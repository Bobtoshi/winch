import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRunner } from "./adapters.mjs";
import { ActionBroker } from "./action-broker.mjs";
import { BridgeAccess, projectBridgeRun } from "./bridge.mjs";
import { loadEnv } from "./env.mjs";
import { Orchestrator } from "./orchestrator.mjs";
import { HarnessRegistry } from "./registry.mjs";
import { HarnessRouter } from "./router.mjs";
import { Store } from "./store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(root, ".env"));

const port = Number(process.env.WINCH_PORT || 4321);
const host = process.env.WINCH_HOST || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("WINCH_PORT must be a valid TCP port.");
if (!loopbackHosts.has(host.toLowerCase())) throw new Error("WINCH only binds to loopback. Put an authenticated proxy in front of it for remote access.");

const configSetting = process.env.WINCH_HARNESS_CONFIG || "./config/harnesses.json";
const configPath = path.isAbsolute(configSetting) ? configSetting : path.resolve(root, configSetting);
const actionConfigSetting = process.env.WINCH_ACTION_CONFIG || "./config/action-grants.json";
const actionConfigPath = path.isAbsolute(actionConfigSetting) ? actionConfigSetting : path.resolve(root, actionConfigSetting);
const store = new Store(path.join(root, "data", "winch.sqlite"));
store.prune(Number(process.env.WINCH_RETENTION_DAYS || 30));
const registry = new HarnessRegistry({
  liveEnabled: process.env.WINCH_LIVE_HARNESSES === "1",
  codexEnabled: process.env.WINCH_CODEX_ENABLED === "1",
  configPath
});
const router = new HarnessRouter(registry);
const runner = new AdapterRunner();
const broker = new ActionBroker({ configPath: actionConfigPath, enabled: process.env.WINCH_ACTIONS_ENABLED === "1" });
const orchestrator = new Orchestrator({ store, registry, router, runner, broker });
const bridge = new BridgeAccess({ token: process.env.WINCH_BRIDGE_TOKEN || "" });
const publicDir = path.join(root, "public");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

const securityHeaders = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; trusted-types 'none'; require-trusted-types-for 'script'"
});

function json(res, status, body) {
  res.writeHead(status, { ...securityHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_000) throw Object.assign(new Error("Request body too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }); }
}

function assertLocalRequest(req) {
  const remote = String(req.socket.remoteAddress || "").toLowerCase();
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) throw Object.assign(new Error("Remote client is not loopback."), { statusCode: 403 });
  let authority;
  try { authority = new URL(`http://${req.headers.host || ""}`); }
  catch { throw Object.assign(new Error("Invalid Host header."), { statusCode: 400 }); }
  if (!loopbackHosts.has(authority.hostname.toLowerCase()) || Number(authority.port || 80) !== port) {
    throw Object.assign(new Error("Host is not allowed."), { statusCode: 403 });
  }
  if (req.method === "POST") {
    if (req.headers["x-winch-request"] !== "1") throw Object.assign(new Error("Missing WINCH mutation header."), { statusCode: 403 });
    if (req.headers["sec-fetch-site"] === "cross-site") throw Object.assign(new Error("Cross-site requests are not allowed."), { statusCode: 403 });
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); }
      catch { throw Object.assign(new Error("Invalid Origin header."), { statusCode: 403 }); }
      if (!loopbackHosts.has(origin.hostname.toLowerCase()) || Number(origin.port || 80) !== port) {
        throw Object.assign(new Error("Origin is not allowed."), { statusCode: 403 });
      }
    }
  }
}

function stateResponse() {
  return {
    ...store.state(),
    meta: {
      product: "WINCH",
      mode: process.env.WINCH_LIVE_HARNESSES === "1" ? "live-enabled" : "simulation-only",
      harnesses: registry.publicState(),
      tools: broker.catalog(),
      protocol: "proposal-and-action-v2",
      bridge: bridge.status()
    }
  };
}

async function handleApi(req, res, url) {
  if (url.pathname.startsWith("/api/bridge/")) {
    if (!bridge.enabled()) return json(res, 404, { error: "Bridge is disabled." });
    if (!bridge.authenticate(req.headers.authorization)) return json(res, 401, { error: "Bridge authentication failed." });
    if (req.method === "POST" && !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw Object.assign(new Error("Content-Type must be application/json."), { statusCode: 415 });
    if (req.method === "GET" && url.pathname === "/api/bridge/status") {
      return json(res, 200, { bridge: bridge.status(), harnesses: registry.publicState() });
    }
    if (req.method === "POST" && url.pathname === "/api/bridge/runs") {
      const body = await readBody(req);
      if (typeof body.intent !== "string") throw Object.assign(new Error("Intent must be a string."), { statusCode: 400 });
      const created = await orchestrator.createRun(body.intent, {
        source: "cplug-bridge",
        preferredHarness: typeof body.preferredHarness === "string" ? body.preferredHarness : null,
        approvedBy: body.operatorApproved === true ? "C-Plug operator approval" : null,
        withRunId: true
      });
      return json(res, 201, projectBridgeRun(created.state, created.runId));
    }
    const approval = url.pathname.match(/^\/api\/bridge\/approvals\/W?(\d{6})$/i);
    if (req.method === "POST" && approval) {
      const body = await readBody(req);
      if (!["approve", "reject"].includes(body.decision)) throw Object.assign(new Error("Decision must be approve or reject."), { statusCode: 400 });
      const decided = await orchestrator.decideByCode(approval[1], body.decision);
      return json(res, 200, projectBridgeRun(decided.state, decided.runId));
    }
    return json(res, 404, { error: "Bridge route not found." });
  }
  if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, stateResponse());
  if (req.method === "POST" && url.pathname === "/api/runs") {
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw Object.assign(new Error("Content-Type must be application/json."), { statusCode: 415 });
    const body = await readBody(req);
    if (typeof body.intent !== "string") throw Object.assign(new Error("Intent must be a string."), { statusCode: 400 });
    await orchestrator.createRun(body.intent, { source: "web", preferredHarness: typeof body.preferredHarness === "string" ? body.preferredHarness : null });
    return json(res, 201, stateResponse());
  }
  const decision = url.pathname.match(/^\/api\/runs\/([a-z0-9_]+)\/(approve|reject)$/);
  if (req.method === "POST" && decision) {
    await orchestrator.decide(decision[1], decision[2]);
    return json(res, 200, stateResponse());
  }
  const actionDecision = url.pathname.match(/^\/api\/actions\/([a-z0-9_]+)\/(approve|reject)$/);
  if (req.method === "POST" && actionDecision) {
    await orchestrator.decideAction(actionDecision[1], actionDecision[2]);
    return json(res, 200, stateResponse());
  }
  return json(res, 404, { error: "API route not found." });
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(publicDir, `.${requested}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return json(res, 404, { error: "Not found." });
  res.writeHead(200, { ...securityHeaders, "content-type": mime[path.extname(resolved)] || "application/octet-stream", "cache-control": requested === "/index.html" ? "no-cache" : "public, max-age=3600" });
  fs.createReadStream(resolved).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    assertLocalRequest(req);
    if (!req.url?.startsWith("/")) throw Object.assign(new Error("Invalid request target."), { statusCode: 400 });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (req.method === "GET") serveStatic(res, url.pathname);
    else json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    if (!error.statusCode) console.error("WINCH request failed with an internal error.");
    json(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Internal server error." });
  }
});

server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, host, () => {
  console.log(`WINCH is running at http://${host}:${port}`);
  console.log(`Mode: ${process.env.WINCH_LIVE_HARNESSES === "1" ? "live harnesses enabled" : "simulation only"}`);
  console.log(`Harnesses: ${registry.publicState().map((item) => `${item.id}:${item.status}`).join(", ")}`);
  console.log(`Action broker: ${process.env.WINCH_ACTIONS_ENABLED === "1" ? "enabled" : "locked"}`);
  console.log(`C-Plug bridge: ${bridge.status().status}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
