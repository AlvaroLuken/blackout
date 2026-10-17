// docprint: the synthetic job-processing service Blackout repairs.
// Runs as its own OS process under supervisor.ts. Owns its own SQLite DB.
// Delivery semantics are at-least-once: the ledger has no per-job uniqueness.
// The only dedupe is the caller-supplied op_id (idempotency key) on /process.
import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PATHS, PORTS } from "../config.ts";
import { computePayload, type ServiceConfig } from "./compute.ts";

const bootId = randomUUID().slice(0, 8);
const bootAt = new Date().toISOString();

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  fs.appendFileSync(PATHS.targetLog, JSON.stringify({ ts: new Date().toISOString(), level, boot: bootId, msg, ...extra }) + "\n");
}

// Config is read once at boot, like most real services. Editing it requires a restart.
const config: ServiceConfig = JSON.parse(fs.readFileSync(PATHS.targetConfig, "utf8"));

const db = new DatabaseSync(PATHS.targetDb);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

type Hooks = { armed?: boolean; kill_on_commit_number?: number; armed_at?: string };
function readHooks(): Hooks {
  try { return JSON.parse(fs.readFileSync(PATHS.hooks, "utf8")); } catch { return {}; }
}

// Test-harness failpoint. Fires after the commit and before the HTTP response,
// which is the window where the caller cannot know the effect happened.
async function afterCommitHook(opId: string) {
  const h = readHooks();
  if (!h.armed || !h.kill_on_commit_number || !h.armed_at) return;
  const n = (db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE committed_at >= ? AND op_id NOT LIKE 'verify-%'").get(h.armed_at) as { n: number }).n;
  if (n !== h.kill_on_commit_number) return;
  try {
    await fetch(`http://127.0.0.1:${PORTS.harness}/failpoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ point: "after_commit_before_ack", op_id: opId, commit_number: n }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    log("warn", "harness unreachable at failpoint");
  }
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 64_000) throw new Error("body too large"); }
  return s ? JSON.parse(s) : {};
}

async function processJob(jobId: string, opId: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT * FROM receipts WHERE op_id = ?").get(opId);
    if (existing) {
      db.exec("COMMIT");
      return { code: 200, body: { replayed: true, receipt: existing } };
    }
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as { id: string; text: string } | undefined;
    if (!job) { db.exec("ROLLBACK"); return { code: 404, body: { error: "job_not_found" } }; }
    const payload = computePayload(job.id, job.text, config);
    const now = new Date().toISOString();
    const d = db.prepare("INSERT INTO deliveries (job_id, op_id, payload, created_at) VALUES (?, ?, ?, ?)").run(job.id, opId, JSON.stringify(payload), now);
    db.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").run(now, job.id);
    db.prepare("INSERT INTO receipts (op_id, job_id, delivery_id, committed_at) VALUES (?, ?, ?, ?)").run(opId, job.id, Number(d.lastInsertRowid), now);
    db.exec("COMMIT");
    log("info", "job delivered", { job_id: job.id, op_id: opId });
    const receipt = db.prepare("SELECT * FROM receipts WHERE op_id = ?").get(opId);
    await afterCommitHook(opId);
    return { code: 200, body: { replayed: false, receipt } };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    const requestId = randomUUID().slice(0, 8);
    log("error", "job processing failed", { job_id: jobId, op_id: opId, request_id: requestId, error: (e as Error).message, stage: "fingerprint" });
    db.prepare("UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ? AND status != 'done'").run(new Date().toISOString(), jobId);
    return { code: 500, body: { error: "internal_error", request_id: requestId } };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/health") {
      return send(res, 200, { status: "ok", service: config.service, version: config.version, boot_id: bootId, booted_at: bootAt });
    }
    if (req.method === "GET" && p === "/jobs") {
      const rows = db.prepare("SELECT id, status, probe, created_at, updated_at FROM jobs ORDER BY id").all();
      return send(res, 200, { jobs: rows });
    }
    if (req.method === "POST" && p === "/jobs") {
      const b = await readBody(req);
      if (typeof b.text !== "string" || b.text.length > 2000) return send(res, 400, { error: "text required" });
      const id = (b.probe ? "probe-" : "job-") + randomUUID().slice(0, 8);
      db.prepare("INSERT INTO jobs (id, text, probe, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(id, b.text, b.probe ? 1 : 0, new Date().toISOString());
      return send(res, 201, { id });
    }
    const m = p.match(/^\/jobs\/([\w-]+)\/process$/);
    if (req.method === "POST" && m) {
      const b = await readBody(req);
      if (typeof b.op_id !== "string" || !/^[\w:-]{4,80}$/.test(b.op_id)) return send(res, 400, { error: "op_id required" });
      const r = await processJob(m[1], b.op_id);
      return send(res, r.code, r.body);
    }
    const r = p.match(/^\/receipts\/([\w:-]+)$/);
    if (req.method === "GET" && r) {
      const row = db.prepare("SELECT * FROM receipts WHERE op_id = ?").get(r[1]);
      return row ? send(res, 200, row) : send(res, 404, { error: "no_receipt" });
    }
    if (req.method === "GET" && p === "/receipts") {
      const job = url.searchParams.get("job_id");
      const rows = job
        ? db.prepare("SELECT * FROM receipts WHERE job_id = ? ORDER BY committed_at").all(job)
        : db.prepare("SELECT * FROM receipts ORDER BY committed_at").all();
      return send(res, 200, { receipts: rows });
    }
    if (req.method === "POST" && p === "/admin/restart") {
      log("info", "restart requested");
      send(res, 202, { restarting: true, boot_id: bootId });
      setTimeout(() => process.exit(0), 50);
      return;
    }
    send(res, 404, { error: "not_found" });
  } catch (e) {
    send(res, 500, { error: "internal_error" });
  }
});

server.listen(PORTS.target, "127.0.0.1", () => {
  log("info", "docprint started", { port: PORTS.target, version: config.version });
  log("warn", "fingerprint cache warmup skipped (cold start)");
});
