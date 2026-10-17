// Local web view of the race. Runs the same processes as `npm run race`
// (raceRunner.ts) and streams events to the browser over Server-Sent Events.
// It is a window onto real runs: nothing here simulates agents or results.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import "../llm/crusoe.ts"; // loads .env
import { startRace, counters, killWorker, armNextDelivery, MODES, type RaceEvent } from "../raceRunner.ts";

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
    const tick = setInterval(() => broadcast({ type: "counters", data: Object.fromEntries(MODES.map((m) => [m, counters(m)])) }), 400);
    startRace({ profile: "outbox", fault, killAfter, inject: !!b.inject, policy: process.env.BLACKOUT_WEB_POLICY ?? "llm" }, (e: RaceEvent) => {
      broadcast(e);
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
    broadcast({ type: "replay", recorded_at: rec.recorded_at }, false);
    for (const ev of rec.events) setTimeout(() => broadcast(ev.msg, false), ev.t);
    const end = (rec.events.at(-1)?.t ?? 0) + 200;
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
