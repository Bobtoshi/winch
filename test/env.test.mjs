import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../src/env.mjs";

test("private environment files must be owner-only", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "winch-env-mode-"));
  const filename = path.join(directory, ".env");
  fs.writeFileSync(filename, "WINCH_TEST_SECRET=example\n", { mode: 0o640 });
  t.after(() => { delete process.env.WINCH_TEST_SECRET; fs.rmSync(directory, { recursive: true, force: true }); });
  assert.throws(() => loadEnv(filename), /mode 600/);
  fs.chmodSync(filename, 0o600);
  loadEnv(filename);
  assert.equal(process.env.WINCH_TEST_SECRET, "example");
});
