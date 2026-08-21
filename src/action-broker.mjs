import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACTION_TYPES = new Set([
  "files.list", "files.read", "files.write", "files.move", "files.trash",
  "web.fetch", "macos.notify", "macos.open_app", "shortcuts.run",
  "calendar.create_event", "imessage.send", "command.run",
  "codex.workspace_task", "connector.invoke", "api.request"
]);

const TITLES = Object.freeze({
  "files.list": "List files in a granted root",
  "files.read": "Read a file from a granted root",
  "files.write": "Write a file inside a granted root",
  "files.move": "Move a file inside a granted root",
  "files.trash": "Move a file into a recoverable local trash folder",
  "web.fetch": "Fetch text from an allowlisted HTTPS host",
  "macos.notify": "Post a macOS notification",
  "macos.open_app": "Open an allowlisted macOS application",
  "shortcuts.run": "Run an allowlisted Apple Shortcut",
  "calendar.create_event": "Create an event in an allowlisted calendar",
  "imessage.send": "Send an iMessage to an allowlisted recipient",
  "command.run": "Run a predeclared command recipe without a shell",
  "codex.workspace_task": "Run an approved Codex task inside a writable workspace root",
  "connector.invoke": "Invoke an allowlisted operation on a reviewed local connector",
  "api.request": "Call a granted API profile using a key from the local environment"
});

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedString(value, name, max = 4_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Object.assign(new Error(`${name} is invalid.`), { code: "invalid_arguments" });
  return value.trim();
}

function loadConfig(filename) {
  if (!filename || !fs.existsSync(filename)) return { base: process.cwd(), document: {} };
  const stat = fs.statSync(filename);
  if (!stat.isFile() || (stat.mode & 0o002) !== 0) throw new Error("Action grants must be a regular file that is not world-writable.");
  let document;
  try { document = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch { throw new Error("Action grants are not valid JSON."); }
  return { base: path.dirname(filename), document: plainObject(document) };
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function readResponseBody(response, limit = 262_144) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw Object.assign(new Error("Web response exceeded the configured limit."), { code: "response_too_large" }); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class ActionBroker {
  constructor({ configPath = "", enabled = false } = {}) {
    this.enabled = Boolean(enabled);
    this.configPath = configPath;
    const { base, document } = loadConfig(configPath);
    this.tools = plainObject(document.tools);
    this.fileRoots = Array.isArray(document.fileRoots) ? document.fileRoots.slice(0, 20).flatMap((item) => {
      if (!item || typeof item.name !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(item.name) || typeof item.path !== "string") return [];
      const resolved = path.resolve(base, item.path);
      try {
        const real = fs.realpathSync(resolved);
        return fs.statSync(real).isDirectory() ? [{ name: item.name, path: real, writable: item.writable === true }] : [];
      } catch { return []; }
    }) : [];
    this.webHosts = new Set(Array.isArray(document.webHosts) ? document.webHosts.filter((item) => typeof item === "string").map((item) => item.toLowerCase()).slice(0, 100) : []);
    this.apps = new Set(Array.isArray(document.apps) ? document.apps.filter((item) => typeof item === "string").slice(0, 50) : []);
    this.shortcuts = new Set(Array.isArray(document.shortcuts) ? document.shortcuts.filter((item) => typeof item === "string").slice(0, 50) : []);
    this.calendars = new Set(Array.isArray(document.calendars) ? document.calendars.filter((item) => typeof item === "string").slice(0, 25) : []);
    this.imessageRecipients = new Set(Array.isArray(document.imessageRecipients) ? document.imessageRecipients.filter((item) => typeof item === "string").slice(0, 100) : []);
    this.commands = plainObject(document.commands);
    this.apis = {};
    for (const [name, raw] of Object.entries(plainObject(document.apis)).slice(0, 100)) {
      const item = plainObject(raw);
      if (!/^[a-z][a-z0-9_-]{0,79}$/.test(name) || typeof item.baseUrl !== "string" || typeof item.apiKeyEnv !== "string") continue;
      let baseUrl;
      try { baseUrl = new URL(item.baseUrl); } catch { continue; }
      if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.port) continue;
      const apiKeyHeader = typeof item.apiKeyHeader === "string" && /^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(item.apiKeyHeader) ? item.apiKeyHeader : "Authorization";
      if (["host", "cookie", "content-length", "connection", "transfer-encoding"].includes(apiKeyHeader.toLowerCase())) continue;
      if (!/^[A-Z][A-Z0-9_]{0,80}$/.test(item.apiKeyEnv)) continue;
      this.apis[name] = {
        baseUrl,
        apiKeyEnv: item.apiKeyEnv,
        apiKeyHeader,
        apiKeyPrefix: typeof item.apiKeyPrefix === "string" ? item.apiKeyPrefix.slice(0, 40) : "Bearer ",
        methods: new Set(Array.isArray(item.methods) ? item.methods.map((value) => String(value).toUpperCase()).filter((value) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value)) : ["GET"]),
        pathPrefixes: Array.isArray(item.pathPrefixes) ? item.pathPrefixes.filter((value) => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 500).slice(0, 100) : []
      };
    }
    this.connectors = {};
    for (const [name, raw] of Object.entries(plainObject(document.connectors)).slice(0, 50)) {
      const item = plainObject(raw);
      if (!/^[a-z][a-z0-9_-]{0,79}$/.test(name) || typeof item.executable !== "string") continue;
      const executable = path.resolve(base, item.executable);
      let safe = false;
      try { const stat = fs.statSync(executable); safe = stat.isFile() && (stat.mode & 0o111) !== 0 && (stat.mode & 0o002) === 0; } catch { safe = false; }
      if (!safe) continue;
      this.connectors[name] = {
        executable,
        args: Array.isArray(item.args) ? item.args.filter((value) => typeof value === "string" && value.length <= 500).slice(0, 30) : [],
        operations: new Set(Array.isArray(item.operations) ? item.operations.filter((value) => typeof value === "string" && /^[a-z][a-z0-9_.-]{0,99}$/.test(value)).slice(0, 100) : []),
        environment: Array.isArray(item.environment) ? item.environment.filter((value) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(value)).slice(0, 30) : [],
        timeoutMs: Math.min(300_000, Math.max(1_000, Number(item.timeoutMs) || 60_000))
      };
    }
  }

  isEnabled(type) {
    return this.enabled && ACTION_TYPES.has(type) && this.tools[type] === true;
  }

  catalog() {
    return [...ACTION_TYPES].map((type) => ({ type, title: TITLES[type], enabled: this.isEnabled(type), approval: "always" }));
  }

  normalizeProposal(proposal) {
    const item = plainObject(proposal);
    const type = typeof item.type === "string" ? item.type : "";
    if (!ACTION_TYPES.has(type)) return null;
    const args = plainObject(item.arguments);
    const serialized = JSON.stringify(args);
    if (serialized.length > 12_000) return null;
    return {
      type,
      title: String(item.title || TITLES[type]).slice(0, 300),
      risk: "approval",
      arguments: JSON.parse(serialized),
      enabled: this.isEnabled(type)
    };
  }

  #root(name, writable = false) {
    const root = this.fileRoots.find((item) => item.name === name);
    if (!root || (writable && !root.writable)) throw Object.assign(new Error("The requested file root is not granted for this operation."), { code: "target_not_granted" });
    return root;
  }

  #existingPath(root, value) {
    const requested = path.resolve(root.path, boundedString(value, "path", 1_000));
    if (!within(root.path, requested)) throw Object.assign(new Error("The path leaves its granted root."), { code: "path_outside_root" });
    let real;
    try { real = fs.realpathSync(requested); }
    catch { throw Object.assign(new Error("The requested path does not exist."), { code: "path_not_found" }); }
    if (!within(root.path, real)) throw Object.assign(new Error("The resolved path leaves its granted root."), { code: "path_outside_root" });
    return real;
  }

  #writePath(root, value) {
    const requested = path.resolve(root.path, boundedString(value, "path", 1_000));
    if (!within(root.path, requested)) throw Object.assign(new Error("The path leaves its granted root."), { code: "path_outside_root" });
    const parent = fs.realpathSync(path.dirname(requested));
    if (!within(root.path, parent)) throw Object.assign(new Error("The resolved parent leaves its granted root."), { code: "path_outside_root" });
    return path.join(parent, path.basename(requested));
  }

  async execute(action) {
    if (!this.isEnabled(action.type)) throw Object.assign(new Error("This action capability is locked in the local grants file."), { code: "capability_locked" });
    const args = plainObject(action.arguments);
    switch (action.type) {
      case "files.list": {
        const root = this.#root(boundedString(args.root, "root", 40));
        const target = this.#existingPath(root, args.path || ".");
        if (!fs.statSync(target).isDirectory()) throw Object.assign(new Error("The requested path is not a directory."), { code: "invalid_target" });
        return { summary: "Directory listed", output: fs.readdirSync(target, { withFileTypes: true }).slice(0, 500).map((item) => ({ name: item.name, type: item.isDirectory() ? "directory" : item.isFile() ? "file" : "other" })) };
      }
      case "files.read": {
        const root = this.#root(boundedString(args.root, "root", 40));
        const target = this.#existingPath(root, args.path);
        const stat = fs.statSync(target);
        if (!stat.isFile() || stat.size > 1_000_000) throw Object.assign(new Error("The file is not a regular file under 1 MB."), { code: "invalid_target" });
        return { summary: "File read", output: fs.readFileSync(target, "utf8").slice(0, 1_000_000) };
      }
      case "files.write": {
        const root = this.#root(boundedString(args.root, "root", 40), true);
        const target = this.#writePath(root, args.path);
        const content = typeof args.content === "string" && args.content.length <= 1_000_000 ? args.content : null;
        if (content === null) throw Object.assign(new Error("File content must be text under 1 MB."), { code: "invalid_arguments" });
        const overwrite = args.overwrite === true;
        fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o600, flag: overwrite ? "w" : "wx" });
        return { summary: "File written", output: { root: root.name, path: path.relative(root.path, target), bytes: Buffer.byteLength(content), overwrite } };
      }
      case "files.move": {
        const root = this.#root(boundedString(args.root, "root", 40), true);
        const source = this.#existingPath(root, args.from);
        const destination = this.#writePath(root, args.to);
        fs.renameSync(source, destination);
        return { summary: "File moved", output: { root: root.name, from: path.relative(root.path, source), to: path.relative(root.path, destination) } };
      }
      case "files.trash": {
        const root = this.#root(boundedString(args.root, "root", 40), true);
        const source = this.#existingPath(root, args.path);
        if (source === root.path) throw Object.assign(new Error("A granted root cannot be trashed."), { code: "invalid_target" });
        const trash = path.join(root.path, ".winch-trash");
        fs.mkdirSync(trash, { mode: 0o700 });
        const destination = path.join(trash, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${path.basename(source)}`);
        fs.renameSync(source, destination);
        return { summary: "Item moved to recoverable trash", output: { root: root.name, original: path.relative(root.path, source), recoveryPath: path.relative(root.path, destination) } };
      }
      case "web.fetch": {
        if (String(args.source || "").toLowerCase().includes("email")) throw Object.assign(new Error("WINCH never opens or fetches links originating from email."), { code: "email_link_denied" });
        const url = new URL(boundedString(args.url, "url", 2_000));
        if (url.protocol !== "https:" || url.username || url.password || url.port) throw Object.assign(new Error("Only credential-free HTTPS URLs on the default port are allowed."), { code: "url_not_allowed" });
        if (!this.webHosts.has(url.hostname.toLowerCase())) throw Object.assign(new Error("The web host is not allowlisted."), { code: "target_not_granted" });
        const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw Object.assign(new Error("Private, local, and link-local web targets are denied."), { code: "ssrf_denied" });
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "text/plain, application/json;q=0.9, text/html;q=0.7" } });
        if (response.status >= 300 && response.status < 400) throw Object.assign(new Error("Redirects are not followed."), { code: "redirect_denied" });
        const contentType = response.headers.get("content-type") || "";
        if (!/^(text\/|application\/(json|[^;]+\+json))/i.test(contentType)) throw Object.assign(new Error("Only textual web responses are accepted."), { code: "content_type_denied" });
        return { summary: `Fetched ${url.hostname}`, output: { status: response.status, contentType, body: await readResponseBody(response) } };
      }
      case "macos.notify": {
        const title = boundedString(args.title, "title", 120);
        const body = boundedString(args.body, "body", 500);
        await execFileAsync("/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], { timeout: 10_000 });
        return { summary: "Notification posted", output: { title } };
      }
      case "macos.open_app": {
        const app = boundedString(args.app, "app", 120);
        if (!this.apps.has(app)) throw Object.assign(new Error("The application is not allowlisted."), { code: "target_not_granted" });
        await execFileAsync("/usr/bin/open", ["-a", app], { timeout: 15_000 });
        return { summary: "Application opened", output: { app } };
      }
      case "shortcuts.run": {
        const shortcut = boundedString(args.shortcut, "shortcut", 200);
        if (!this.shortcuts.has(shortcut)) throw Object.assign(new Error("The shortcut is not allowlisted."), { code: "target_not_granted" });
        const { stdout } = await execFileAsync("/usr/bin/shortcuts", ["run", shortcut], { timeout: 120_000, maxBuffer: 1_000_000 });
        return { summary: "Shortcut completed", output: stdout.slice(0, 20_000) };
      }
      case "calendar.create_event": {
        const calendar = boundedString(args.calendar, "calendar", 120);
        if (!this.calendars.has(calendar)) throw Object.assign(new Error("The calendar is not allowlisted."), { code: "target_not_granted" });
        const title = boundedString(args.title, "title", 300);
        const notes = typeof args.notes === "string" ? args.notes.slice(0, 4_000) : "";
        const start = new Date(args.start);
        const end = new Date(args.end);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end - start > 7 * 86_400_000) throw Object.assign(new Error("Event start/end are invalid."), { code: "invalid_arguments" });
        const script = "on run argv\ntell application \"Calendar\"\ntell calendar (item 1 of argv)\nmake new event with properties {summary:(item 2 of argv), start date:(date (item 3 of argv)), end date:(date (item 4 of argv)), description:(item 5 of argv)}\nend tell\nend tell\nend run";
        await execFileAsync("/usr/bin/osascript", ["-e", script, calendar, title, start.toString(), end.toString(), notes], { timeout: 20_000 });
        return { summary: "Calendar event created", output: { calendar, title, start: start.toISOString(), end: end.toISOString() } };
      }
      case "imessage.send": {
        const recipient = boundedString(args.recipient, "recipient", 200);
        const message = boundedString(args.message, "message", 10_000);
        if (!this.imessageRecipients.has(recipient)) throw Object.assign(new Error("The iMessage recipient is not allowlisted."), { code: "target_not_granted" });
        const script = "on run argv\ntell application \"Messages\"\nset targetService to first service whose service type = iMessage\nset targetBuddy to buddy (item 1 of argv) of targetService\nsend (item 2 of argv) to targetBuddy\nend tell\nend run";
        await execFileAsync("/usr/bin/osascript", ["-e", script, recipient, message], { timeout: 20_000 });
        return { summary: "iMessage sent", output: { recipient, characters: message.length } };
      }
      case "command.run": {
        const recipeName = boundedString(args.recipe, "recipe", 80);
        const recipe = plainObject(this.commands[recipeName]);
        const executable = typeof recipe.executable === "string" ? path.resolve(recipe.executable) : "";
        let stat;
        try { stat = fs.statSync(executable); } catch { stat = null; }
        if (!stat?.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o002) !== 0) throw Object.assign(new Error("The command recipe is not executable or safely configured."), { code: "target_not_granted" });
        const input = typeof args.input === "string" && args.input.length <= 4_000 ? args.input : "";
        const recipeArgs = Array.isArray(recipe.args) ? recipe.args.filter((item) => typeof item === "string" && item.length <= 500).slice(0, 30).map((item) => item.replaceAll("{{input}}", input)) : [];
        const { stdout } = await execFileAsync(executable, recipeArgs, { timeout: Math.min(300_000, Math.max(1_000, Number(recipe.timeoutMs) || 60_000)), maxBuffer: 1_000_000, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
        return { summary: `Command recipe ${recipeName} completed`, output: stdout.slice(0, 20_000) };
      }
      case "codex.workspace_task": {
        const root = this.#root(boundedString(args.root, "root", 40), true);
        const requestedPath = args.path ? this.#existingPath(root, args.path) : root.path;
        if (!fs.statSync(requestedPath).isDirectory()) throw Object.assign(new Error("The Codex task target must be a directory."), { code: "invalid_target" });
        const prompt = boundedString(args.prompt, "prompt", 20_000);
        let command;
        try { command = (await execFileAsync("/usr/bin/which", ["codex"], { timeout: 5_000 })).stdout.trim(); }
        catch { throw Object.assign(new Error("Codex is not installed or discoverable."), { code: "harness_unavailable" }); }
        const stat = fs.statSync(command);
        if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o002) !== 0) throw Object.assign(new Error("The Codex executable failed validation."), { code: "harness_unavailable" });
        const { stdout } = await execFileAsync(command, ["exec", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", requestedPath, prompt], {
          timeout: 900_000, maxBuffer: 2_000_000,
          env: { HOME: process.env.HOME || "", PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: process.env.TMPDIR || os.tmpdir() }
        });
        return { summary: "Codex workspace task completed", output: stdout.slice(0, 100_000) };
      }
      case "connector.invoke": {
        const connectorName = boundedString(args.connector, "connector", 80);
        const operation = boundedString(args.operation, "operation", 100);
        const connector = this.connectors[connectorName];
        if (!connector || !connector.operations.has(operation)) throw Object.assign(new Error("The connector operation is not allowlisted."), { code: "target_not_granted" });
        const input = plainObject(args.input);
        if (JSON.stringify(input).length > 50_000) throw Object.assign(new Error("Connector input is too large."), { code: "invalid_arguments" });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "winch-connector-"));
        const requestPath = path.join(directory, "request.json");
        fs.writeFileSync(requestPath, JSON.stringify({ protocol: 1, connector: connectorName, operation, input }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        const connectorArgs = connector.args.map((value) => value.replaceAll("{{requestFile}}", requestPath));
        if (!connector.args.some((value) => value.includes("{{requestFile}}"))) connectorArgs.push(requestPath);
        const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: process.env.TMPDIR || os.tmpdir() };
        for (const key of connector.environment) if (process.env[key] !== undefined) env[key] = process.env[key];
        try {
          const { stdout } = await execFileAsync(connector.executable, connectorArgs, { cwd: directory, env, timeout: connector.timeoutMs, maxBuffer: 2_000_000 });
          let output;
          try { output = JSON.parse(stdout); } catch { output = stdout.slice(0, 100_000); }
          return { summary: `Connector ${connectorName}.${operation} completed`, output };
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }
      case "api.request": {
        const apiName = boundedString(args.api, "api", 80);
        const profile = this.apis[apiName];
        if (!profile) throw Object.assign(new Error("The API profile is not granted."), { code: "target_not_granted" });
        const method = String(args.method || "GET").toUpperCase();
        if (!profile.methods.has(method)) throw Object.assign(new Error("The HTTP method is not granted for this API."), { code: "target_not_granted" });
        const requestedPath = boundedString(args.path, "path", 2_000);
        if (!requestedPath.startsWith("/") || requestedPath.startsWith("//") || !profile.pathPrefixes.some((prefix) => requestedPath.startsWith(prefix))) throw Object.assign(new Error("The API path is outside its granted prefixes."), { code: "target_not_granted" });
        const secret = process.env[profile.apiKeyEnv];
        if (typeof secret !== "string" || !secret || secret.length > 8_000) throw Object.assign(new Error(`API key environment variable ${profile.apiKeyEnv} is missing or invalid.`), { code: "missing_api_key" });
        const url = new URL(requestedPath, profile.baseUrl.origin);
        const query = plainObject(args.query);
        for (const [key, value] of Object.entries(query).slice(0, 100)) {
          if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key) || !["string", "number", "boolean"].includes(typeof value)) throw Object.assign(new Error("API query parameters are invalid."), { code: "invalid_arguments" });
          url.searchParams.append(key, String(value).slice(0, 2_000));
        }
        const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw Object.assign(new Error("Private, local, and link-local API targets are denied."), { code: "ssrf_denied" });
        let body;
        if (args.body !== undefined && method !== "GET") {
          body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
          if (body.length > 100_000) throw Object.assign(new Error("API request body is too large."), { code: "invalid_arguments" });
        }
        const headers = { accept: "application/json, text/plain;q=0.8", [profile.apiKeyHeader]: `${profile.apiKeyPrefix}${secret}` };
        if (body !== undefined) headers["content-type"] = "application/json";
        const response = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(20_000) });
        if (response.status >= 300 && response.status < 400) throw Object.assign(new Error("API redirects are not followed."), { code: "redirect_denied" });
        const contentType = response.headers.get("content-type") || "";
        const text = await readResponseBody(response);
        let output = text;
        if (/application\/(json|[^;]+\+json)/i.test(contentType)) { try { output = JSON.parse(text); } catch { output = text; } }
        return { summary: `API ${apiName} returned ${response.status}`, output: { status: response.status, contentType, body: output } };
      }
      default: throw Object.assign(new Error("Unknown action capability."), { code: "unknown_action" });
    }
  }
}

export const actionTypes = [...ACTION_TYPES];
