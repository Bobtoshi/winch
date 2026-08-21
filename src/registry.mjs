import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CAPABILITIES = new Set(["general", "code", "research", "personal_ops", "verify"]);
const ID = /^[a-z][a-z0-9_-]{1,39}$/;

const simulations = [
  { id: "scout", name: "Scout", kind: "simulation", capabilities: ["general", "research"], priority: 5, cost: 1, reliability: 0.94 },
  { id: "forge", name: "Forge", kind: "simulation", capabilities: ["code"], priority: 5, cost: 1, reliability: 0.93 },
  { id: "pilot", name: "Pilot", kind: "simulation", capabilities: ["personal_ops", "general"], priority: 4, cost: 1, reliability: 0.91 },
  { id: "sentinel", name: "Sentinel", kind: "simulation", capabilities: ["verify"], priority: 6, cost: 1, reliability: 0.97 }
];

function which(command) {
  const found = spawnSync("which", [command], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}

function safeCapabilities(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => CAPABILITIES.has(value)))].slice(0, 8);
}

function loadCustom(filename, liveEnabled) {
  if (!filename || !fs.existsSync(filename)) return [];
  let document;
  try { document = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch { return []; }
  if (!Array.isArray(document.harnesses)) return [];
  const harnesses = [];
  for (const item of document.harnesses.slice(0, 25)) {
    if (!item || !ID.test(item.id) || typeof item.name !== "string" || item.kind !== "custom_cli") continue;
    const command = typeof item.command === "string" ? path.resolve(item.command) : "";
    let executable = false;
    try {
      const stat = fs.statSync(command);
      executable = stat.isFile() && (stat.mode & 0o111) !== 0 && (stat.mode & 0o002) === 0;
    } catch { executable = false; }
    const capabilities = safeCapabilities(item.capabilities);
    if (!capabilities.length) continue;
    harnesses.push({
      id: item.id,
      name: item.name.slice(0, 80),
      kind: "custom_cli",
      command,
      args: Array.isArray(item.args) ? item.args.filter((arg) => typeof arg === "string" && arg.length <= 500).slice(0, 20) : [],
      environment: Array.isArray(item.environment) ? item.environment.filter((key) => /^[A-Z][A-Z0-9_]{0,80}$/.test(key)).slice(0, 20) : [],
      capabilities,
      priority: Math.max(0, Math.min(10, Number(item.priority) || 0)),
      cost: Math.max(1, Math.min(5, Number(item.cost) || 3)),
      reliability: 0.85,
      available: executable,
      enabled: Boolean(liveEnabled && item.enabled && executable),
      status: !executable ? "unavailable" : liveEnabled && item.enabled ? "ready" : "locked"
    });
  }
  return harnesses;
}

export class HarnessRegistry {
  constructor({ liveEnabled = false, codexEnabled = false, configPath = "" } = {}) {
    this.liveEnabled = liveEnabled;
    this.codexEnabled = codexEnabled;
    this.configPath = configPath;
    this.reload();
  }

  reload() {
    const codexPath = which("codex");
    const builtins = simulations.map((item) => ({ ...item, available: true, enabled: true, status: "simulation" }));
    const codex = {
      id: "codex", name: "Codex", kind: "codex_cli", command: codexPath,
      capabilities: ["general", "code", "research", "verify"], priority: 8, cost: 3, reliability: 0.96,
      available: Boolean(codexPath), enabled: Boolean(this.liveEnabled && this.codexEnabled && codexPath),
      status: !codexPath ? "unavailable" : this.liveEnabled && this.codexEnabled ? "ready" : "locked"
    };
    this.harnesses = [...builtins, codex, ...loadCustom(this.configPath, this.liveEnabled)];
  }

  list() {
    return this.harnesses.slice();
  }

  get(id) {
    return this.harnesses.find((item) => item.id === id) || null;
  }

  publicState() {
    return this.harnesses.map(({ command: _command, args: _args, environment: _environment, ...item }) => item);
  }
}

export const harnessCapabilities = [...CAPABILITIES];
