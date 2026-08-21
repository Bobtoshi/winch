import fs from "node:fs";

export function loadEnv(filename) {
  if (!fs.existsSync(filename)) return;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(".env must be a regular file readable and writable only by its owner (mode 600).");
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
