import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, HarnessRouter } from "../src/router.mjs";

const harnesses = [
  { id: "sim", name: "Simulation", kind: "simulation", capabilities: ["code", "general"], enabled: true, available: true, priority: 8, cost: 1, reliability: 0.99 },
  { id: "live", name: "Live", kind: "custom_cli", capabilities: ["code", "general"], enabled: true, available: true, priority: 4, cost: 3, reliability: 0.9 },
  { id: "verify", name: "Verify", kind: "simulation", capabilities: ["verify"], enabled: true, available: true, priority: 5, cost: 1, reliability: 0.95 }
];
const registry = { list: () => harnesses };

test("intent classification selects a bounded capability", () => {
  assert.equal(classifyIntent("Fix the repository tests"), "code");
  assert.equal(classifyIntent("Compare primary sources"), "research");
  assert.equal(classifyIntent("What should I do next?"), "general");
});

test("live harnesses outrank simulations when explicitly enabled", () => {
  const route = new HarnessRouter(registry).route("Fix this code");
  assert.equal(route.primary, "live");
  assert.deepEqual(route.fallbacks, ["sim"]);
});

test("a verification route is attached independently", () => {
  const route = new HarnessRouter(registry).route("Review this code", { requireVerification: true });
  assert.equal(route.verifier, "verify");
});

test("operator preference overrides ranking only when eligible", () => {
  const route = new HarnessRouter(registry).route("Fix this code", { preferredHarness: "sim" });
  assert.equal(route.primary, "sim");
});
