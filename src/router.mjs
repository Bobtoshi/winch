const RULES = [
  { capability: "code", pattern: /\b(code|repo|repository|bug|test|build|refactor|typescript|javascript|python|git|pull request)\b/i },
  { capability: "research", pattern: /\b(research|compare|investigate|find|search|sources?|evidence|market)\b/i },
  { capability: "personal_ops", pattern: /\b(calendar|email|message|appointment|booking|home|shortcut|house|viewing|reminder)\b/i }
];

export function classifyIntent(intent) {
  return RULES.find(({ pattern }) => pattern.test(intent))?.capability || "general";
}

function score(harness, capability) {
  const live = harness.kind === "simulation" ? 0 : 60;
  const exact = harness.capabilities.includes(capability) ? 20 : 0;
  return live + exact + harness.priority * 10 + Math.round(harness.reliability * 10) - harness.cost * 2;
}

export class HarnessRouter {
  constructor(registry) {
    this.registry = registry;
  }

  route(intent, { preferredHarness = null, requireVerification = false } = {}) {
    const capability = classifyIntent(intent);
    let candidates = this.registry.list().filter((item) => item.available && item.enabled && item.capabilities.includes(capability));
    if (capability !== "general") {
      const generalFallbacks = this.registry.list().filter((item) => item.available && item.enabled && item.capabilities.includes("general") && !candidates.some((candidate) => candidate.id === item.id));
      candidates = [...candidates, ...generalFallbacks];
    }
    candidates.sort((a, b) => score(b, capability) - score(a, capability) || a.id.localeCompare(b.id));
    if (preferredHarness) {
      const preferred = candidates.find((item) => item.id === preferredHarness);
      if (preferred) candidates = [preferred, ...candidates.filter((item) => item.id !== preferred.id)];
    }
    if (!candidates.length) throw Object.assign(new Error("No enabled harness can handle this request."), { code: "no_route" });

    const primary = candidates[0];
    const verifier = (requireVerification || /\b(verify|review|audit|double-check)\b/i.test(intent))
      ? this.registry.list().filter((item) => item.available && item.enabled && item.id !== primary.id && item.capabilities.includes("verify")).sort((a, b) => score(b, "verify") - score(a, "verify"))[0] || null
      : null;
    return {
      capability,
      primary: primary.id,
      fallbacks: candidates.slice(1, 3).map((item) => item.id),
      verifier: verifier?.id || null,
      rationale: `${primary.name} ranked highest for ${capability.replace("_", " ")} under the current availability, priority, reliability, and cost policy.`,
      rankings: candidates.slice(0, 4).map((item) => ({ id: item.id, name: item.name, score: score(item, capability), mode: item.kind === "simulation" ? "simulation" : "live" }))
    };
  }
}
