import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActionBroker } from "../src/action-broker.mjs";

function configuredBroker(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "winch-broker-test-"));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const configPath = path.join(directory, "grants.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tools: { "files.read": true, "files.write": true, "web.fetch": true, ...overrides.tools },
    fileRoots: [{ name: "workspace", path: workspace, writable: true }],
    webHosts: ["example.com"],
    ...overrides
  }), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, workspace, broker: new ActionBroker({ configPath, enabled: true }) };
}

test("file actions stay inside granted roots and produce receipts", async (t) => {
  const { workspace, broker } = configuredBroker(t);
  const action = { type: "files.write", arguments: { root: "workspace", path: "note.txt", content: "hello" } };
  const result = await broker.execute(action);
  assert.equal(result.summary, "File written");
  assert.equal(fs.readFileSync(path.join(workspace, "note.txt"), "utf8"), "hello");
  await assert.rejects(() => broker.execute({ type: "files.write", arguments: { root: "workspace", path: "../escape.txt", content: "no" } }), { code: "path_outside_root" });
});

test("web links marked as email-derived are denied before retrieval", async (t) => {
  const { broker } = configuredBroker(t);
  await assert.rejects(() => broker.execute({ type: "web.fetch", arguments: { url: "https://example.com/", source: "email" } }), { code: "email_link_denied" });
});

test("disabled tools remain locked even with configured targets", async (t) => {
  const { broker } = configuredBroker(t, { tools: { "macos.open_app": false }, apps: ["Safari"] });
  await assert.rejects(() => broker.execute({ type: "macos.open_app", arguments: { app: "Safari" } }), { code: "capability_locked" });
});

test("universal connectors expose only allowlisted semantic operations", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "winch-connector-test-"));
  const connector = path.resolve("scripts/example-connector.mjs");
  const configPath = path.join(directory, "grants.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tools: { "connector.invoke": true },
    connectors: { example: { executable: connector, args: ["{{requestFile}}"], operations: ["echo"] } }
  }), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const broker = new ActionBroker({ configPath, enabled: true });
  const receipt = await broker.execute({ type: "connector.invoke", arguments: { connector: "example", operation: "echo", input: { value: 42 } } });
  assert.deepEqual(receipt.output, { ok: true, echoed: { value: 42 } });
  await assert.rejects(() => broker.execute({ type: "connector.invoke", arguments: { connector: "example", operation: "shell.run", input: {} } }), { code: "target_not_granted" });
});

test("API profiles accept arbitrary key environment names without exposing ungranted methods or paths", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "winch-api-test-"));
  const configPath = path.join(directory, "grants.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tools: { "api.request": true },
    apis: { vendor: { baseUrl: "https://api.example.com", apiKeyEnv: "VENDOR_SPECIAL_KEY", apiKeyHeader: "x-api-key", apiKeyPrefix: "", methods: ["POST"], pathPrefixes: ["/v2/jobs/"] } }
  }), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const broker = new ActionBroker({ configPath, enabled: true });
  await assert.rejects(() => broker.execute({ type: "api.request", arguments: { api: "vendor", method: "GET", path: "/v2/jobs/1" } }), { code: "target_not_granted" });
  await assert.rejects(() => broker.execute({ type: "api.request", arguments: { api: "vendor", method: "POST", path: "/admin" } }), { code: "target_not_granted" });
  await assert.rejects(() => broker.execute({ type: "api.request", arguments: { api: "vendor", method: "POST", path: "/v2/jobs/1", body: {} } }), { code: "missing_api_key" });
});
