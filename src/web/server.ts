// Local web view of the race. Runs the same processes as `npm run race`
// (raceRunner.ts) and streams events to the browser over Server-Sent Events.
// It is a window onto real runs: nothing here simulates agents or results.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import "../llm/crusoe.ts"; // loads .env
import { DatabaseSync } from "node:sqlite";
import { startRace, counters, killWorker, armNextDelivery, varDirFor, MODES, type Mode, type RaceEvent } from "../raceRunner.ts";

function ro(file: string) { return new DatabaseSync(file, { readOnly: true }); }
const targetDb = (m: Mode) => path.join(varDirFor(m), "target", "service.db");
const journalDb = (m: Mode) => path.join(varDirFor(m), "blackout", "journal.db");

// What was in flight when the harness killed the worker: the op ID the target committed
// right before the SIGKILL, from the harness log, joined to the target's own receipt.
function inflight(m: Mode) {
  try {
    const lines = fs.readFileSync(path.join(varDirFor(m), "harness", "events.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const kill = [...lines].reverse().find((e) => e.event === "worker_sigkilled" && e.op_id);
    if (!kill) return null;
    const db = ro(targetDb(m));
    try {
      const r = db.prepare("SELECT op_id, job_id, committed_at FROM receipts WHERE op_id = ?").get(kill.op_id) as any;
      return r ? { op: r.op_id, job: r.job_id, committed_at: r.committed_at, pid: kill.pid } : null;
    } finally { db.close(); }
  } catch { return null; }
}

// Facts for the proof-of-done record, read from Blackout's journal (not from the model).
function journalFacts(m: Mode, missionId: string) {
  try {
    const db = ro(journalDb(m));
    try {
      const models = (db.prepare("SELECT model, COUNT(*) AS n FROM usage WHERE mission_id = ? GROUP BY model").all(missionId) as any[]).map((r) => ({ model: r.model, calls: r.n }));
      const reconciled = (db.prepare("SELECT op_id, target_ref, status FROM actions WHERE mission_id = ? AND status LIKE 'reconciled_%'").all(missionId) as any[]);
      const mission = db.prepare("SELECT goal FROM missions WHERE id = ?").get(missionId) as any;
      return { models, reconciled, goal: mission?.goal ?? null };
    } finally { db.close(); }
  } catch { return { models: [], reconciled: [], goal: null }; }
}

// Every Nemotron call the agents make through Crusoe, as the journal recorded it.
const llmSeen: Record<string, Set<number>> = {};
function newLlmCalls(m: Mode, sinceIso: string) {
  try {
    const db = ro(journalDb(m));
    try {
      const rows = db.prepare("SELECT id, actor, model, latency_ms, prompt_tokens, completion_tokens FROM usage WHERE ts >= ? ORDER BY id").all(sinceIso) as any[];
      const seen = (llmSeen[m] ??= new Set());
      return rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => ({ type: "llm", mode: m, actor: r.actor, model: r.model, ms: r.latency_ms, tok: (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0) }));
    } finally { db.close(); }
  } catch { return []; }
}

const PORT = Number(process.env.BLACKOUT_WEB_PORT ?? 7400);
const page = () => fs.readFileSync(path.join(ROOT, "src/web/index.html"), "utf8");

const clients = new Set<http.ServerResponse>();
let running = false;
let history: unknown[] = [];
let recording: { t: number; msg: unknown }[] = [];
let raceStart = 0;
let replaying = false;
const RECORDING = path.join(ROOT, "results", "race", "last-race.json");
const BACKUP = path.join(ROOT, "results", "race", "replay-backup.json"); // a chosen clean live run

function broadcast(msg: unknown, record = true) {
  history.push(msg);
  if (record && !replaying) recording.push({ t: Date.now() - raceStart, msg });
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) c.write(data);
}

function measured() {
  const out: Record<string, unknown>[] = [];
  for (const f of fs.readdirSync(path.join(ROOT, "results")).filter((f) => /^eval-(outbox|ledger)-\d.*\.json$/.test(f))) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "results", f), "utf8"));
    if (d.pairs < 10) continue;
    for (const mode of ["journal", "baseline"]) {
      const r = d.runs.filter((x: any) => x.mode === mode);
      out.push({
        profile: d.profile, mode, runs: r.length,
        verified: r.filter((x: any) => x.verified).length,
        dup_runs: r.filter((x: any) => x.duplicate_committed > 0).length,
        dup_deliveries: r.reduce((s: number, x: any) => s + x.duplicate_committed, 0),
        false_success: r.filter((x: any) => x.false_success).length,
        mean_usd: r.reduce((s: number, x: any) => s + (x.est_usd ?? 0), 0) / r.length,
      });
    }
  }

  // MCP gateway eval rows (latest n>=10 run): "verified" = runs where every customer got exactly one email.
  const gwf = fs.readdirSync(path.join(ROOT, "results")).filter((f) => /^gateway-eval-.*\.json$/.test(f)).sort().reverse();
  for (const f of gwf) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "results", f), "utf8"));
    if ((d.summary?.[0]?.runs ?? 0) < 10) continue;
    for (const sm of d.summary) out.push({ profile: "MCP gateway", mode: sm.arm === "gateway" ? "journal" : "baseline", runs: sm.runs, verified: sm.runs - sm.runs_with_duplicate - (sm.missing > 0 ? 1 : 0), dup_runs: sm.runs_with_duplicate, dup_deliveries: sm.duplicate_emails, false_success: sm.false_done, mean_usd: sm.mean_usd });
    break;
  }
  return out;
}

// Crusoe's own telemetry for our model, fetched server-side (token never sent to the browser).
const MODEL_ALIAS = process.env.BLACKOUT_MODEL ?? "nvidia/Nemotron-3.5-Lightning-30B-A3B";
const QUERIES = {
  rpm: "sum by (model_alias) (rate(inference_counter_all_chat_request[5m])) * 60",
  ttft_ms: "histogram_quantile(0.5, sum by (model_alias, le) (rate(inference_histogram_first_token_latency_bucket[5m]))) * 1000",
  tok_s: "sum by (model_alias) (rate(inference_counter_output_token[5m]))",
};
let telemetry: Record<string, number | null> & { at?: number } = {};
async function pollCrusoe() {
  const token = process.env.CRUSOE_MONITOR_TOKEN, project = process.env.CRUSOE_PROJECT_ID;
  if (!token || !project) return;
  const next: Record<string, number | null> & { at?: number } = { at: Date.now() };
  for (const [k, q] of Object.entries(QUERIES)) {
    try {
      const r = await fetch(`https://api.crusoecloud.com/v1alpha5/projects/${project}/metrics/timeseries/api/v1/query?query=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      const j = (await r.json()) as any;
      const row = (j?.data?.result ?? []).find((x: any) => x.metric?.model_alias === MODEL_ALIAS);
      next[k] = row ? parseFloat(row.value[1]) : null;
    } catch { next[k] = null; }
  }
  telemetry = next;
}
pollCrusoe();
setInterval(pollCrusoe, 15_000);

async function body(req: http.IncomingMessage) {
  let s = "";
  for await (const c of req) s += c;
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page());
  }
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const m of history) res.write(`data: ${JSON.stringify(m)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/inbox") {
    // Every delivery the service committed for one customer job, straight from its DB.
    const m = url.searchParams.get("mode") as Mode;
    const job = String(url.searchParams.get("job") ?? "");
    if (!MODES.includes(m) || !/^job-\d{3}$/.test(job)) { res.writeHead(400); return res.end("{}"); }
    try {
      const db = ro(targetDb(m));
      try {
        const rows = db.prepare("SELECT d.id, d.op_id, d.created_at, d.payload, j.text FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE d.job_id = ? ORDER BY d.id").all(job);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(rows));
      } finally { db.close(); }
    } catch { res.writeHead(200, { "content-type": "application/json" }); return res.end("[]"); }
  }
  if (req.method === "POST" && url.pathname === "/warmup") {
    // One tiny Crusoe call before going on stage: confirms the key, model and latency.
    const t0 = Date.now();
    try {
      const r = await fetch(`${process.env.CRUSOE_BASE_URL ?? "https://api.inference.crusoecloud.com/v1"}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${process.env.CRUSOE_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL_ALIAS, max_tokens: 5, messages: [{ role: "user", content: "ping" }], chat_template_kwargs: { enable_thinking: false } }),
        signal: AbortSignal.timeout(20_000),
      });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: r.ok, status: r.status, ms: Date.now() - t0 }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: (e as Error).message.slice(0, 80), ms: Date.now() - t0 }));
    }
  }
  if (req.method === "GET" && url.pathname === "/crusoe") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ model: MODEL_ALIAS, ...telemetry }));
  }
  if (req.method === "GET" && url.pathname === "/measured") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(measured()));
  }
  if (req.method === "POST" && url.pathname === "/start") {
    if (running) { res.writeHead(409); return res.end("{}"); }
    const b = await body(req);
    running = true;
    history = [];
    recording = [];
    raceStart = Date.now();
    const fault = Math.random() < 0.5 ? "bad_digest" : "bad_unicode";
    const killAfter = b.kill === "judge" ? null : 2;
    broadcast({ type: "start", kill: b.kill === "judge" ? "judge" : "auto", inject: !!b.inject, at: Date.now() });
    let exited = 0;
    const sinceIso = new Date(raceStart).toISOString();
    for (const m of MODES) llmSeen[m] = new Set();
    const tick = setInterval(() => {
      broadcast({ type: "counters", data: Object.fromEntries(MODES.map((m) => [m, counters(m)])) });
      for (const m of MODES) for (const c of newLlmCalls(m, sinceIso)) broadcast(c);
    }, 400);
    startRace({ profile: "outbox", fault, killAfter, inject: !!b.inject, policy: process.env.BLACKOUT_WEB_POLICY ?? "llm" }, (e: RaceEvent) => {
      // Attach the verifier's per-check results and contract hash from the saved run file.
      if (e.type === "summary" && e.file) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(ROOT, e.file), "utf8"));
          (e as any).checks = r.final_verdict.results.map((c: any) => ({ kind: c.kind, pass: c.pass, detail: c.detail, source: c.source }));
          (e as any).hash = r.final_verdict.contract_hash;
          (e as any).mission = r.mission_id;
          (e as any).facts = journalFacts(e.mode, r.mission_id);
          (e as any).facts.kills = (r.harness_events ?? []).filter((h: any) => h.event === "worker_sigkilled").length;
        } catch {}
      }
      broadcast(e);
      if (e.type === "line" && /SIGKILLed/.test(e.text)) {
        setTimeout(() => { const f = inflight(e.mode); if (f) broadcast({ type: "inflight", mode: e.mode, ...f }); }, 300);
      }
      if (e.type === "exit" && ++exited === 2) {
        setTimeout(() => {
          clearInterval(tick);
          broadcast({ type: "counters", data: Object.fromEntries(MODES.map((m) => [m, counters(m)])) });
          broadcast({ type: "done" });
          running = false;
          fs.mkdirSync(path.dirname(RECORDING), { recursive: true });
          fs.writeFileSync(RECORDING, JSON.stringify({ recorded_at: new Date(raceStart).toISOString(), events: recording }));
        }, 300);
      }
    });
    res.writeHead(202, { "content-type": "application/json" });
    return res.end(JSON.stringify({ started: true }));
  }
  if (req.method === "POST" && url.pathname === "/replay") {
    // Backup if live inference degrades on stage. Clearly labelled in the page.
    const src = fs.existsSync(BACKUP) ? BACKUP : RECORDING;
    if (running || !fs.existsSync(src)) { res.writeHead(409); return res.end("{}"); }
    const rec = JSON.parse(fs.readFileSync(src, "utf8"));
    running = true; replaying = true; history = [];
    const speed = Number(url.searchParams.get("speed") ?? 2);
    broadcast({ type: "replay", recorded_at: rec.recorded_at, speed }, false);
    for (const ev of rec.events) setTimeout(() => broadcast(ev.msg, false), ev.t / speed);
    const end = (rec.events.at(-1)?.t ?? 0) / speed + 200;
    setTimeout(() => { running = false; replaying = false; }, end);
    res.writeHead(202, { "content-type": "application/json" });
    return res.end("{}");
  }
  if (req.method === "POST" && url.pathname === "/plug") {
    // Judge's button: both sides get killed right after their next delivery commits.
    if (!running) { res.writeHead(409); return res.end("{}"); }
    for (const m of MODES) armNextDelivery(m);
    broadcast({ type: "plug" });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
  if (req.method === "POST" && url.pathname === "/kill-now") {
    const pids = MODES.map((m) => killWorker(m));
    broadcast({ type: "killnow", pids });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ pids }));
  }
  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => console.log(`Blackout live view: http://localhost:${PORT}`));
