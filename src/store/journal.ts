// Blackout's durable mission journal. Lives in var/blackout, outside the
// target's failure domain and outside every path agent tools may touch.
// This is Blackout's record of intent; it is never treated as proof that a
// target-side effect happened. Only target receipts and the verifier are.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PATHS } from "../config.ts";

export type ActionStatus = "intent" | "acked" | "failed" | "reconciled_done" | "reconciled_absent" | "unknown";

export class Journal {
  db: DatabaseSync;
  constructor(file = PATHS.journalDb) {
    fs.mkdirSync(PATHS.blackoutDir, { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, goal TEXT NOT NULL, mode TEXT NOT NULL,
        policy TEXT NOT NULL, status TEXT NOT NULL, contract_hash TEXT, generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers (generation INTEGER NOT NULL, mission_id TEXT NOT NULL, pid INTEGER,
        assignment TEXT, state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, exit_info TEXT,
        PRIMARY KEY (mission_id, generation));
      CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL,
        op_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, kind TEXT NOT NULL, target_ref TEXT,
        args TEXT, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL,
        ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL,
        ts TEXT NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
        est_usd REAL, latency_ms INTEGER, finish_reason TEXT);
      CREATE TABLE IF NOT EXISTS verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL,
        ts TEXT NOT NULL, pass INTEGER NOT NULL, progress TEXT NOT NULL, results TEXT NOT NULL);
    `);
  }
  now() { return new Date().toISOString(); }

  createMission(id: string, goal: string, mode: string, policy: string) {
    this.db.prepare("INSERT INTO missions (id, goal, mode, policy, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'planning', ?, ?)").run(id, goal, mode, policy, this.now(), this.now());
  }
  mission(id: string) {
    return this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
      | { id: string; goal: string; mode: string; policy: string; status: string; contract_hash: string | null; generation: number }
      | undefined;
  }
  setMission(id: string, fields: { status?: string; contract_hash?: string }) {
    if (fields.status) this.db.prepare("UPDATE missions SET status = ?, updated_at = ? WHERE id = ?").run(fields.status, this.now(), id);
    if (fields.contract_hash) this.db.prepare("UPDATE missions SET contract_hash = ?, updated_at = ? WHERE id = ?").run(fields.contract_hash, this.now(), id);
  }

  // Start a new worker generation. Older generations are fenced: their writes are rejected.
  newGeneration(missionId: string, assignment: unknown): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const g = (this.mission(missionId)!.generation ?? 0) + 1;
      this.db.prepare("UPDATE missions SET generation = ?, updated_at = ? WHERE id = ?").run(g, this.now(), missionId);
      this.db.prepare("UPDATE workers SET state = 'fenced' WHERE mission_id = ? AND state = 'running'").run(missionId);
      this.db.prepare("INSERT INTO workers (generation, mission_id, assignment, state, started_at) VALUES (?, ?, ?, 'starting', ?)").run(g, missionId, JSON.stringify(assignment), this.now());
      this.db.exec("COMMIT");
      return g;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  workerStarted(missionId: string, g: number, pid: number) {
    this.db.prepare("UPDATE workers SET pid = ?, state = 'running' WHERE mission_id = ? AND generation = ?").run(pid, missionId, g);
  }
  workerEnded(missionId: string, g: number, state: string, info: unknown) {
    this.db.prepare("UPDATE workers SET state = ?, ended_at = ?, exit_info = ? WHERE mission_id = ? AND generation = ?").run(state, this.now(), JSON.stringify(info), missionId, g);
  }
  assertCurrent(missionId: string, g: number) {
    const cur = this.mission(missionId)!.generation;
    if (cur !== g) throw new Error(`fenced: worker generation ${g} is stale (current ${cur})`);
  }

  // Persist intent BEFORE the side effect, under the generation fence.
  recordIntent(missionId: string, g: number, opId: string, kind: string, targetRef: string, args: unknown) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertCurrent(missionId, g);
      this.db.prepare("INSERT INTO actions (mission_id, op_id, generation, kind, target_ref, args, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, ?)").run(missionId, opId, g, kind, targetRef, JSON.stringify(args), this.now(), this.now());
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  settleAction(opId: string, status: ActionStatus, result: unknown) {
    this.db.prepare("UPDATE actions SET status = ?, result = ?, updated_at = ? WHERE op_id = ?").run(status, JSON.stringify(result), this.now(), opId);
  }
  actions(missionId: string) {
    return this.db.prepare("SELECT * FROM actions WHERE mission_id = ? ORDER BY id").all(missionId) as {
      op_id: string; generation: number; kind: string; target_ref: string; status: ActionStatus; result: string | null;
    }[];
  }
  unsettled(missionId: string) {
    return this.actions(missionId).filter((a) => a.status === "intent");
  }

  event(missionId: string, actor: string, type: string, data: unknown = {}) {
    this.db.prepare("INSERT INTO events (mission_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)").run(missionId, this.now(), actor, type, JSON.stringify(data));
  }
  events(missionId: string) {
    return this.db.prepare("SELECT * FROM events WHERE mission_id = ? ORDER BY id").all(missionId) as { ts: string; actor: string; type: string; data: string }[];
  }
  recordUsage(missionId: string, u: { actor: string; model: string; prompt_tokens: number; completion_tokens: number; est_usd: number | null; latency_ms: number; finish_reason: string }) {
    this.db.prepare("INSERT INTO usage (mission_id, ts, actor, model, prompt_tokens, completion_tokens, est_usd, latency_ms, finish_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(missionId, this.now(), u.actor, u.model, u.prompt_tokens, u.completion_tokens, u.est_usd, u.latency_ms, u.finish_reason);
  }
  usageTotals(missionId: string) {
    return this.db.prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens, SUM(est_usd) AS est_usd, COUNT(est_usd) AS priced_calls FROM usage WHERE mission_id = ?").get(missionId) as {
      calls: number; prompt_tokens: number; completion_tokens: number; est_usd: number | null; priced_calls: number;
    };
  }
  recordVerdict(missionId: string, v: { pass: boolean; progress: unknown; results: unknown }) {
    this.db.prepare("INSERT INTO verdicts (mission_id, ts, pass, progress, results) VALUES (?, ?, ?, ?, ?)").run(missionId, this.now(), v.pass ? 1 : 0, JSON.stringify(v.progress), JSON.stringify(v.results));
  }
  close() { this.db.close(); }
}
