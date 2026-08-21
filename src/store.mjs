import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const parse = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

export class Store {
  constructor(filename) {
    const directory = path.dirname(filename);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const previousUmask = process.umask(0o077);
    try { this.db = new DatabaseSync(filename); }
    finally { process.umask(previousUmask); }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL,
        source TEXT NOT NULL,
        capability TEXT,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        route_json TEXT,
        result_json TEXT,
        approval_code TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_approval_code ON runs(approval_code) WHERE approval_code IS NOT NULL;
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        harness_id TEXT NOT NULL,
        harness_name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        approval_code TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        executed_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_approval_code ON actions(approval_code) WHERE approval_code IS NOT NULL;
    `);
    for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
  }

  createRun(run) {
    this.db.prepare("INSERT INTO runs (id,intent,source,capability,risk,status,route_json,result_json,approval_code,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(run.id, run.intent, run.source, run.capability ?? null, run.risk, run.status, run.route ? JSON.stringify(run.route) : null, null, run.approvalCode ?? null, run.createdAt, null);
  }

  updateRun(id, fields) {
    const map = { capability: "capability", status: "status", route: "route_json", result: "result_json", approvalCode: "approval_code", decidedAt: "decided_at" };
    const entries = Object.entries(fields).filter(([key]) => map[key]);
    if (!entries.length) return;
    const values = entries.map(([key, value]) => ["route", "result"].includes(key) && value !== null ? JSON.stringify(value) : value);
    this.db.prepare(`UPDATE runs SET ${entries.map(([key]) => `${map[key]} = ?`).join(", ")} WHERE id = ?`).run(...values, id);
  }

  getRun(id) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? this.#run(row) : null;
  }

  getRunByCode(code) {
    const row = this.db.prepare("SELECT * FROM runs WHERE approval_code = ? LIMIT 1").get(String(code));
    return row ? this.#run(row) : null;
  }

  createAttempt(attempt) {
    this.db.prepare("INSERT INTO attempts (id,run_id,harness_id,harness_name,role,status,result_json,error_code,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(attempt.id, attempt.runId, attempt.harnessId, attempt.harnessName, attempt.role, "running", null, null, attempt.startedAt, null);
  }

  finishAttempt(id, status, { result = null, errorCode = null } = {}) {
    this.db.prepare("UPDATE attempts SET status = ?, result_json = ?, error_code = ?, finished_at = ? WHERE id = ?")
      .run(status, result ? JSON.stringify(result) : null, errorCode, new Date().toISOString(), id);
  }

  createAction(action) {
    this.db.prepare("INSERT INTO actions (id,run_id,type,title,risk,status,arguments_json,result_json,error_code,approval_code,created_at,decided_at,executed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(action.id, action.runId, action.type, action.title, action.risk, action.status, JSON.stringify(action.arguments), null, null, action.approvalCode, action.createdAt, null, null);
  }

  getAction(id) {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
    return row ? this.#action(row) : null;
  }

  getActionByCode(code) {
    const row = this.db.prepare("SELECT * FROM actions WHERE approval_code = ? LIMIT 1").get(String(code));
    return row ? this.#action(row) : null;
  }

  updateAction(id, fields) {
    const map = { status: "status", result: "result_json", errorCode: "error_code", approvalCode: "approval_code", decidedAt: "decided_at", executedAt: "executed_at" };
    const entries = Object.entries(fields).filter(([key]) => map[key]);
    if (!entries.length) return;
    const values = entries.map(([key, value]) => key === "result" && value !== null ? JSON.stringify(value) : value);
    this.db.prepare(`UPDATE actions SET ${entries.map(([key]) => `${map[key]} = ?`).join(", ")} WHERE id = ?`).run(...values, id);
  }

  addEvent({ runId = null, kind, message }) {
    this.db.prepare("INSERT INTO events (run_id,kind,message,created_at) VALUES (?,?,?,?)")
      .run(runId, kind, String(message).slice(0, 1_000), new Date().toISOString());
  }

  state() {
    const runs = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 40").all().map((row) => this.#run(row));
    const attempts = this.db.prepare("SELECT * FROM attempts ORDER BY started_at DESC LIMIT 120").all().map((row) => this.#attempt(row));
    const events = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 160").all();
    const actions = this.db.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT 120").all().map((row) => this.#action(row));
    return { runs, attempts, actions, events };
  }

  prune(retentionDays = 30) {
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const ids = this.db.prepare("SELECT id FROM runs WHERE created_at < ?").all(cutoff).map((row) => row.id);
    if (!ids.length) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const removeAttempts = this.db.prepare("DELETE FROM attempts WHERE run_id = ?");
      const removeEvents = this.db.prepare("DELETE FROM events WHERE run_id = ?");
      const removeActions = this.db.prepare("DELETE FROM actions WHERE run_id = ?");
      const removeRun = this.db.prepare("DELETE FROM runs WHERE id = ?");
      for (const id of ids) { removeAttempts.run(id); removeEvents.run(id); removeActions.run(id); removeRun.run(id); }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return ids.length;
  }

  #run(row) {
    return {
      id: row.id, intent: row.intent, source: row.source, capability: row.capability, risk: row.risk, status: row.status,
      route: row.route_json ? parse(row.route_json, {}) : null,
      result: row.result_json ? parse(row.result_json, {}) : null,
      approvalCode: row.approval_code, createdAt: row.created_at, decidedAt: row.decided_at
    };
  }

  #attempt(row) {
    return {
      id: row.id, runId: row.run_id, harnessId: row.harness_id, harnessName: row.harness_name, role: row.role,
      status: row.status, result: row.result_json ? parse(row.result_json, {}) : null, errorCode: row.error_code,
      startedAt: row.started_at, finishedAt: row.finished_at
    };
  }

  #action(row) {
    return {
      id: row.id, runId: row.run_id, type: row.type, title: row.title, risk: row.risk, status: row.status,
      arguments: parse(row.arguments_json, {}), result: row.result_json ? parse(row.result_json, {}) : null,
      errorCode: row.error_code, approvalCode: row.approval_code, createdAt: row.created_at,
      decidedAt: row.decided_at, executedAt: row.executed_at
    };
  }
}
