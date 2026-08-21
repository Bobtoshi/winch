import test from "node:test";
import assert from "node:assert/strict";
import { BridgeAccess, projectBridgeRun } from "../src/bridge.mjs";

test("bridge stays disabled without a strong shared secret", () => {
  assert.equal(new BridgeAccess({ token: "short" }).enabled(), false);
  assert.equal(new BridgeAccess({ token: "short" }).authenticate("Bearer short"), false);
});

test("bridge authenticates the exact bearer token without exposing it", () => {
  const token = "synthetic-bridge-secret-0123456789abcdef";
  const bridge = new BridgeAccess({ token });
  assert.equal(bridge.enabled(), true);
  assert.equal(bridge.authenticate(`Bearer ${token}`), true);
  assert.equal(bridge.authenticate(`Bearer ${token}x`), false);
  assert.doesNotMatch(JSON.stringify(bridge.status()), /synthetic-bridge-secret/);
});

test("bridge projections isolate one run and namespace approval codes", () => {
  const state = {
    runs: [{ id: "run_1", approvalCode: "123456" }, { id: "run_2", approvalCode: null }],
    attempts: [{ runId: "run_1" }, { runId: "run_2" }],
    actions: [{ runId: "run_1", approvalCode: "654321" }, { runId: "run_2", approvalCode: "111111" }],
    events: [{ run_id: "run_1", kind: "test", message: "ok", created_at: "now" }, { run_id: "run_2", kind: "other", message: "no", created_at: "now" }]
  };
  const projected = projectBridgeRun(state, "run_1");
  assert.equal(projected.run.approvalCode, "W123456");
  assert.equal(projected.actions[0].approvalCode, "W654321");
  assert.equal(projected.attempts.length, 1);
  assert.equal(projected.events.length, 1);
});
