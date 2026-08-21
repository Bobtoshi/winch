const BLOCKED = [
  { pattern: /\b(bypass|circumvent|break into|credential stuffing)\b/i, reason: "WINCH will not route work that bypasses an authorization boundary." },
  { pattern: /\b(phish|malware|ransomware|steal credentials?)\b/i, reason: "WINCH will not route harmful credential or malware activity." },
  { pattern: /\bspam\b|email\s+(everyone|thousands|a list)/i, reason: "Bulk unsolicited outreach is not an allowed workflow." }
];

const CONSEQUENTIAL = /\b(send|publish|deploy|purchase|buy|book|schedule|delete|remove|push|merge|commit|restart|email|message|transfer|pay|submit)\b/i;
const COMMAND_EXECUTION = /\b(execute|run)\b.{0,40}\b(command|script|shortcut|program|binary|job)\b/i;
const DEVICE_CONTROL = /\b(control|turn on|turn off)\b.{0,60}\b(device|television|tv|console|machine|server|home|lights?)\b/i;

export function inspectIntent(value) {
  const intent = String(value ?? "").trim();
  if (!intent) return { allowed: false, reason: "Describe an outcome first.", risk: "blocked", requiresApproval: false };
  if (intent.length > 4_000) return { allowed: false, reason: "Requests are limited to 4,000 characters.", risk: "blocked", requiresApproval: false };
  const blocked = BLOCKED.find(({ pattern }) => pattern.test(intent));
  if (blocked) return { allowed: false, reason: blocked.reason, risk: "blocked", requiresApproval: false };
  const consequential = CONSEQUENTIAL.test(intent) || COMMAND_EXECUTION.test(intent) || DEVICE_CONTROL.test(intent);
  return {
    allowed: true,
    risk: consequential ? "consequential" : "informational",
    requiresApproval: consequential,
    reason: consequential ? "This request could lead to an external change. Approve the dispatch before a harness receives it." : "Read-only planning can route automatically."
  };
}
