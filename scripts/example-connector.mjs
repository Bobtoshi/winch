#!/usr/bin/env node
import fs from "node:fs";

const filename = process.argv[2];
if (!filename) process.exit(2);
const request = JSON.parse(fs.readFileSync(filename, "utf8"));
if (request.operation !== "echo") process.exit(3);
process.stdout.write(JSON.stringify({ ok: true, echoed: request.input }));
