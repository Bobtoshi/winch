import crypto from "node:crypto";

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export class BridgeAccess {
  constructor({ token = "" } = {}) {
    this.token = String(token);
  }

  enabled() {
    return this.token.length >= 32 && this.token.length <= 512;
  }

  authenticate(header) {
    if (!this.enabled()) return false;
    const match = String(header || "").match(/^Bearer ([\x21-\x7e]{32,512})$/);
    return Boolean(match && equalSecret(match[1], this.token));
  }

  status() {
    return this.enabled()
      ? { status: "ready", detail: "Authenticated loopback bridge enabled" }
      : { status: "disabled", detail: "Set a shared token of at least 32 characters" };
  }
}

export function projectBridgeRun(state, runId) {
  const storedRun = state.runs.find((item) => item.id === runId);
  if (!storedRun) throw Object.assign(new Error("Run not found."), { statusCode: 404 });
  const run = { ...storedRun, approvalCode: storedRun.approvalCode ? `W${storedRun.approvalCode}` : null };
  return {
    run,
    attempts: state.attempts.filter((item) => item.runId === runId),
    actions: state.actions.filter((item) => item.runId === runId).map((item) => ({
      ...item,
      approvalCode: item.approvalCode ? `W${item.approvalCode}` : null
    })),
    events: state.events.filter((item) => item.run_id === runId).map((item) => ({
      kind: item.kind,
      message: item.message,
      createdAt: item.created_at
    }))
  };
}
