import crypto from "node:crypto";
import { inspectIntent } from "./policy.mjs";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

export class Orchestrator {
  constructor({ store, registry, router, runner, broker = null }) {
    this.store = store;
    this.registry = registry;
    this.router = router;
    this.runner = runner;
    this.broker = broker;
  }

  #approvalCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(crypto.randomInt(100000, 1_000_000));
      if (!this.store.getRunByCode(code) && !this.store.getActionByCode(code)) return code;
    }
    throw new Error("Could not allocate an approval code.");
  }

  async createRun(intent, { source = "web", preferredHarness = null } = {}) {
    const inspection = inspectIntent(intent);
    const run = {
      id: id("run"), intent: String(intent ?? "").trim(), source, capability: null,
      risk: inspection.risk, status: inspection.allowed ? "routing" : "blocked", route: null,
      approvalCode: null, createdAt: now()
    };
    this.store.createRun(run);
    this.store.addEvent({ runId: run.id, kind: "request", message: "Intent received. Policy and capability routing started." });
    if (!inspection.allowed) {
      this.store.updateRun(run.id, { result: { summary: inspection.reason } });
      this.store.addEvent({ runId: run.id, kind: "blocked", message: inspection.reason });
      return this.store.state();
    }

    let route;
    try {
      route = this.router.route(run.intent, { preferredHarness, requireVerification: inspection.requiresApproval });
    } catch (error) {
      this.store.updateRun(run.id, { status: "failed", result: { summary: error.message, code: error.code || "routing_failed" } });
      this.store.addEvent({ runId: run.id, kind: "failed", message: "No eligible harness route was available." });
      return this.store.state();
    }

    const approvalCode = inspection.requiresApproval ? this.#approvalCode() : null;
    this.store.updateRun(run.id, {
      capability: route.capability, route, approvalCode,
      status: inspection.requiresApproval ? "awaiting_approval" : "routed"
    });
    this.store.addEvent({ runId: run.id, kind: "route", message: `${route.primary} selected for ${route.capability.replace("_", " ")}${route.verifier ? ` with ${route.verifier} verification` : ""}.` });
    if (inspection.requiresApproval) {
      this.store.addEvent({ runId: run.id, kind: "approval", message: `Dispatch is waiting for human approval code ${approvalCode}.` });
      return this.store.state();
    }
    await this.#execute(run.id);
    return this.store.state();
  }

  async decide(runId, decision) {
    const run = this.store.getRun(runId);
    if (!run) throw Object.assign(new Error("Run not found."), { statusCode: 404 });
    if (run.status !== "awaiting_approval") throw Object.assign(new Error("Run is no longer awaiting approval."), { statusCode: 409 });
    if (decision === "reject") {
      this.store.updateRun(run.id, { status: "rejected", approvalCode: null, decidedAt: now(), result: { summary: "Rejected by the operator. No harness received the request." } });
      this.store.addEvent({ runId: run.id, kind: "rejected", message: "Operator rejected dispatch. Nothing ran." });
      return this.store.state();
    }
    this.store.updateRun(run.id, { status: "routed", approvalCode: null, decidedAt: now() });
    this.store.addEvent({ runId: run.id, kind: "approved", message: "Operator approved dispatch to the selected proposal-mode harness." });
    await this.#execute(run.id);
    return this.store.state();
  }

  async decideAction(actionId, decision) {
    const action = this.store.getAction(actionId);
    if (!action) throw Object.assign(new Error("Action not found."), { statusCode: 404 });
    if (action.status !== "awaiting_approval") throw Object.assign(new Error("Action is no longer awaiting approval."), { statusCode: 409 });
    if (decision === "reject") {
      this.store.updateAction(action.id, { status: "rejected", approvalCode: null, decidedAt: now() });
      this.store.addEvent({ runId: action.runId, kind: "action_rejected", message: `${action.type} was rejected. No side effect occurred.` });
      return this.store.state();
    }
    this.store.updateAction(action.id, { status: "executing", approvalCode: null, decidedAt: now() });
    this.store.addEvent({ runId: action.runId, kind: "action_approved", message: `${action.type} received explicit operator approval.` });
    try {
      const result = await this.broker.execute(action);
      this.store.updateAction(action.id, { status: "completed", result, executedAt: now() });
      this.store.addEvent({ runId: action.runId, kind: "action_completed", message: `${action.type} completed and returned a receipt.` });
    } catch (error) {
      this.store.updateAction(action.id, { status: "failed", result: { summary: error.message }, errorCode: error.code || "action_failed", executedAt: now() });
      this.store.addEvent({ runId: action.runId, kind: "action_failed", message: `${action.type} failed safely with no retry.` });
    }
    return this.store.state();
  }

  async #execute(runId) {
    const run = this.store.getRun(runId);
    const route = run.route;
    this.store.updateRun(runId, { status: "running" });
    this.store.addEvent({ runId, kind: "running", message: "WINCH locked the route and started proposal-mode execution." });

    let primaryResult = null;
    let selectedHarness = null;
    for (const harnessId of [route.primary, ...route.fallbacks]) {
      const harness = this.registry.get(harnessId);
      if (!harness) continue;
      const attemptId = id("attempt");
      this.store.createAttempt({ id: attemptId, runId, harnessId: harness.id, harnessName: harness.name, role: harnessId === route.primary ? "primary" : "fallback", startedAt: now() });
      try {
        primaryResult = await this.runner.run(harness, run.intent, { actionCatalog: this.broker?.catalog() || [] });
        selectedHarness = harness;
        this.store.finishAttempt(attemptId, "completed", { result: primaryResult });
        this.store.addEvent({ runId, kind: "completed", message: `${harness.name} returned a normalized proposal receipt.` });
        break;
      } catch (error) {
        this.store.finishAttempt(attemptId, "failed", { errorCode: error.code || "harness_failed" });
        this.store.addEvent({ runId, kind: "fallback", message: `${harness.name} failed safely; WINCH evaluated the next eligible route.` });
      }
    }

    if (!primaryResult) {
      this.store.updateRun(runId, { status: "failed", result: { summary: "Every eligible harness failed safely." } });
      this.store.addEvent({ runId, kind: "failed", message: "No harness produced a usable result." });
      return;
    }

    let verification = null;
    if (route.verifier) {
      const verifier = this.registry.get(route.verifier);
      if (verifier) {
        const attemptId = id("attempt");
        this.store.createAttempt({ id: attemptId, runId, harnessId: verifier.id, harnessName: verifier.name, role: "verifier", startedAt: now() });
        try {
          verification = await this.runner.run(verifier, run.intent, { previousResult: primaryResult.result, actionCatalog: this.broker?.catalog() || [] });
          this.store.finishAttempt(attemptId, "completed", { result: verification });
          this.store.addEvent({ runId, kind: "verified", message: `${verifier.name} completed an independent proposal verification pass.` });
        } catch (error) {
          this.store.finishAttempt(attemptId, "failed", { errorCode: error.code || "verification_failed" });
          this.store.addEvent({ runId, kind: "warning", message: "The primary result completed, but verification failed safely." });
        }
      }
    }

    this.store.updateRun(runId, {
      status: "completed",
      result: { selectedHarness: selectedHarness.id, primary: primaryResult, verification }
    });
    if (this.broker) {
      for (const proposal of primaryResult.proposedActions || []) {
        const normalized = this.broker.normalizeProposal(proposal);
        if (!normalized) {
          this.store.addEvent({ runId, kind: "action_ignored", message: "A harness proposal used an unknown or invalid action type and was discarded." });
          continue;
        }
        this.store.createAction({
          id: id("action"), runId, type: normalized.type, title: normalized.title, risk: normalized.risk,
          status: "awaiting_approval", arguments: normalized.arguments, approvalCode: this.#approvalCode(), createdAt: now()
        });
        this.store.addEvent({ runId, kind: "action_proposed", message: `${normalized.type} is waiting for separate operator approval${normalized.enabled ? "." : " but the capability is locally locked."}` });
      }
    }
  }
}
