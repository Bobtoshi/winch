import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", "node_modules", "data", "output", ".playwright-cli"]);
const forbiddenNames = new Set([".env", "action-grants.json", "harnesses.json"]);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\/Users\/[^/\s]+\//
];

const failures = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full);
    if (forbiddenNames.has(entry.name)) failures.push(`${relative}: private configuration must not be public`);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.isFile() || fs.statSync(full).size > 2_000_000) continue;
    const content = fs.readFileSync(full, "utf8");
    for (const pattern of secretPatterns) if (pattern.test(content)) failures.push(`${relative}: matches forbidden secret or local-path pattern ${pattern}`);
  }
}

walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Public-tree check passed: no private config, obvious secrets, or local user paths found.");
}
