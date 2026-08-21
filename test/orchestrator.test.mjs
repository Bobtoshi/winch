import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdapterRunner } from "../src/adapters.mjs";
import { ActionBroker } from "../src/action-broker.mjs";
import { Orchestrator } from "../src/orchestrator.mjs";
import { HarnessRegistry } from "../src/registry.mjs";
import { HarnessRouter } from "../src/router.mjs";
import { Store } from "../src/store.mjs";

function fixture(runner = new AdapterRunner(), broker = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "winch-test-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  const registry = new HarnessRegistry();
  const router = new HarnessRouter(registry);
  const orchestrator = new Orchestrator({ store, registry, router, runner, broker });
  return { directory, store, registry, router, orchestrator };
}

test("read-only work routes and returns a normalized receipt", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const state = await f.orchestrator.createRun("Research private AI operator products");
  assert.equal(state.runs[0].status, "completed");
  assert.equal(state.runs[0].route.capability, "research");
  assert.equal(state.attempts[0].status, "completed");
  assert.match(state.runs[0].result.primary.result, /Simulation only/);
});

test("harness proposals become separately approved broker actions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "winch-action-flow-"));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const configPath = path.join(directory, "grants.json");
  fs.writeFileSync(configPath, JSON.stringify({ tools: { "files.write": true }, fileRoots: [{ name: "workspace", path: workspace, writable: true }] }), { mode: 0o600 });
  const broker = new ActionBroker({ configPath, enabled: true });
  const runner = { async run() { return { summary: "Note proposed", result: "Waiting for action approval.", proposedActions: [{ type: "files.write", title: "Write note", risk: "approval", arguments: { root: "workspace", path: "note.txt", content: "approved" } }] }; } };
  const f = fixture(runner, broker);
  t.after(() => { fs.rmSync(f.directory, { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true }); });
  let state = await f.orchestrator.createRun("Prepare a local note");
  assert.equal(state.runs[0].status, "completed");
  assert.equal(state.actions[0].status, "awaiting_approval");
  assert.equal(fs.existsSync(path.join(workspace, "note.txt")), false);
  state = await f.orchestrator.decideAction(state.actions[0].id, "approve");
  assert.equal(state.actions[0].status, "completed");
  assert.equal(fs.readFileSync(path.join(workspace, "note.txt"), "utf8"), "approved");
});

test("consequential work stops before dispatch and can be rejected", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  let state = await f.orchestrator.createRun("Schedule a viewing and send an email");
  assert.equal(state.runs[0].status, "awaiting_approval");
  assert.equal(state.attempts.length, 0);
  state = await f.orchestrator.decide(state.runs[0].id, "reject");
  assert.equal(state.runs[0].status, "rejected");
  assert.equal(state.attempts.length, 0);
});

test("approved consequential work receives an independent verifier", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  let state = await f.orchestrator.createRun("Schedule a viewing and send an email");
  state = await f.orchestrator.decide(state.runs[0].id, "approve");
  assert.equal(state.runs[0].status, "completed");
  assert.ok(state.runs[0].result.verification);
  assert.deepEqual(new Set(state.attempts.map((item) => item.role)), new Set(["primary", "verifier"]));
});

test("a failed primary route falls back safely", async (t) => {
  const runner = {
    calls: [],
    async run(harness) {
      this.calls.push(harness.id);
      if (this.calls.length === 1) throw Object.assign(new Error("Synthetic failure"), { code: "synthetic" });
      return { summary: "Fallback complete", result: "Synthetic fallback result", proposedActions: [] };
    }
  };
  const f = fixture(runner);
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const state = await f.orchestrator.createRun("Fix this code");
  assert.equal(state.runs[0].status, "completed");
  assert.equal(state.attempts.filter((item) => item.status === "failed").length, 1);
  assert.equal(state.attempts.filter((item) => item.status === "completed").length, 1);
});
