import test from "node:test";
import assert from "node:assert/strict";
import { inspectIntent } from "../src/policy.mjs";

test("ordinary research can route without approval", () => {
  assert.deepEqual(inspectIntent("Research the market").allowed, true);
  assert.equal(inspectIntent("Research the market").requiresApproval, false);
});

test("control-plane research is not mistaken for device control", () => {
  assert.equal(inspectIntent("Research the advantage of an AI control plane").requiresApproval, false);
  assert.equal(inspectIntent("Turn on the living-room television").requiresApproval, true);
});

test("consequential requests require human dispatch approval", () => {
  const result = inspectIntent("Schedule a viewing and send the confirmation");
  assert.equal(result.allowed, true);
  assert.equal(result.risk, "consequential");
  assert.equal(result.requiresApproval, true);
});

test("authorization bypasses fail closed", () => {
  assert.equal(inspectIntent("Bypass the waitlist and book me anyway").allowed, false);
});
