// Shared race runner: starts Blackout (journal) and the plain agent (baseline)
// side by side, each with its own target, harness, journal and ports, and
// reports short human-readable events plus live counters from each target DB.
// Used by the terminal view (src/race.ts) and the local web view (src/web/server.ts).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "./config.ts";

export const MODES = ["journal", "baseline"] as const;
export type Mode = (typeof MODES)[number];
export type RaceOpts = { profile: string; fault: string; killAfter: number | null; inject: boolean; policy: string };
export type RaceEvent =
  | { type: "line"; mode: Mode; text: string; tone: Tone }
  | { type: "summary"; mode: Mode; status: string; calls: number | null; usd: string | null; elapsed: string | null; file: string | null }
  | { type: "exit"; mode: Mode };
export type Tone = "kill" | "bad" | "good" | "warn" | "info" | "plain";

export function varDirFor(mode: Mode) { return path.join(ROOT, "var", `race-${mode}`); }

export function tone(s: string): Tone {
  if (/SIGKILL|✖/.test(s)) return "kill";
  if (/REJECTED|ESCALATED|⚠/.test(s)) return "warn";
  if (/DELIVERED|✔|PASS|✓|retry same op/.test(s)) return "good";
  if (/contract frozen|definition of done|FIX/.test(s)) return "info";
  if (/FAIL|crash/.test(s)) return "bad";
  return "plain";
}

// Turn raw controller/worker output into one short sentence per event, or null to hide it.
export function jobsRange(ids: string[]) {
  const n = ids.map((x) => x.replace(/^job-0*/, ""));
  return n.length > 2 ? `jobs ${n[0]}–${n[n.length - 1]}` : `job ${n.join(", ")}`;
}
export function story(raw: string): string | null {
  const s = raw.trim();
  let m;
  if ((m = s.match(/^\[worker\.g(\d)\] (?:-> )?(\w+) (\{.*?\}) (?:-> )?(ok|ERR)?\s?(.*)$/)) || (m = s.match(/^\[worker\.g(\d)\] -> (process_jobs) (\{.*?\})/))) {
    const [, g, tool, args, status, out] = m;
    const w = `w${g} `;
    const a = (() => { try { return JSON.parse(args); } catch { return {}; } })();
    if (status === "ERR") return `${w}tool call rejected: ${(out ?? "").replace(/^ERR\s*/, "").slice(0, 40)}`;
    switch (tool) {
      case "check_health": return `${w}checks /health → 200 OK`;
      case "read_logs": return `${w}reads ${a.level ?? ""} logs`.replace("  ", " ");
      case "list_workspace": return null;
      case "read_workspace_file": return `${w}reads ${a.path}`;
      case "patch_config": { const o = (out ?? "").match(/"old":("?[^,"]*"?),"new":("?[^,"]*"?)/); return `${w}FIX ${a.field}: ${o ? `${o[1]} → ${o[2]}` : JSON.stringify(a.value)}`.replace(/"/g, ""); }
      case "restart_service": return `${w}restarts the service`;
      case "run_test_job": return /"process_status":200/.test(out ?? "") ? `${w}test job ✓ works` : `${w}test job ✗ fails`;
      case "list_jobs": { const c = (out ?? "").match(/"count":(\d+)/); return `${w}lists ${a.status ?? ""} jobs${c ? ` (${c[1]})` : ""}`.replace("  ", " "); }
      case "get_receipts": case "get_receipt": return `${w}looks up receipts`;
      case "process_jobs": return status ? null : `${w}sending ${jobsRange(a.job_ids ?? [])}…`;
      case "finish_assignment": return `${w}reports: ${a.believes_done ? "done" : "not done"}`;
    }
    return `${w}${tool}`;
  }
  if ((m = s.match(/^process_job (job-\d+) op=\S+ -> (\w+)/))) {
    return m[2] === "reconciled_done" ? `   receipt for ${m[1]}: DELIVERED → skip` : m[2] === "reconciled_absent" ? `   no receipt for ${m[1]} → retry same op` : `   ${m[1]}: outcome UNKNOWN`;
  }
  if ((m = s.match(/^\[worker\.g(\d)\] reconciled (\d+)/))) return `w${m[1]} checks journal: ${m[2]} in flight`;
  if ((m = s.match(/^\[worker\.g(\d)\] stopped: (.*)/))) return `w${m[1]} stopped: ${m[2].slice(0, 30)}`;
  if ((m = s.match(/^\[reroute\] (\S+): (.*) busy \(429\) -> (.*?)( for the rest.*)?$/))) return `↪ ${m[1].replace("worker.g", "w").replace("coordinator", "coord")}: Lightning busy, switched to ${m[3]}`;
  if (/^\[harness\] planted/.test(s)) return "⚠ fake 'all resolved' note in logs";
  if (/^\[harness\] GET \/health/.test(s)) return "service says: /health 200 OK";
  if (/^\[coordinator\] contract proposed/.test(s)) return "coord writes definition of done";
  if ((m = s.match(/contract frozen sha256:([0-9a-f]{8})/))) return `contract frozen  sha256:${m[1]}`;
  if ((m = s.match(/rejected proposed check (\{.*?\})/))) return `  rejected check ${m[1].replace(/"/g, "")}`;
  if ((m = s.match(/^\[verifier\] before repair: FAIL\s+valid=(\d+)\/(\d+)/))) return `verifier: FAIL  ${m[1]}/${m[2]} jobs done`;
  if (/fresh_job_e2e: process returned 500/.test(s)) return "  real jobs crash (500)";
  if ((m = s.match(/^\[verifier\] after episode \d+: (PASS|FAIL)\s+valid=(\d+)\/(\d+) duplicates=(\d+)/))) return `verifier: ${m[1]}  ${m[2]}/${m[3]} valid  dup=${m[4]}`;
  if ((m = s.match(/duplicate deliveries for (job-\d+) \(x(\d+)\)/))) return `  ✖ ${m[1]} delivered ${m[2]} times`;
  if ((m = s.match(/^\[controller\] spawn worker generation (\d+)/))) return `▶ worker ${m[1]} starts`;
  if ((m = s.match(/^\[controller\] worker g(\d) died/))) return `✖ worker ${m[1]} SIGKILLed mid-delivery`;
  if (/worker claimed done, verifier disagrees/.test(s)) return "worker says done → REJECTED";
  if (/no progress detected/.test(s)) return "no progress → forced replan";
  if ((m = s.match(/^\[coordinator\] (REPLAN|CONTINUE|ESCALATE)/))) return `coord decides: ${m[1].toLowerCase()}`;
  if (/^\[controller\] DONE:/.test(s)) return "✔ DONE: verified by code";
  if ((m = s.match(/ESCALATE to human: (.*)/))) return `⚑ ESCALATED: ${/duplicate/.test(m[1]) ? "duplicate caught" : m[1].slice(0, 26)}`;
  return null;
}

// Live counters read straight from each side's service database.
export function counters(mode: string) {
  try {
    const db = new DatabaseSync(path.join(varDirFor(mode as Mode), "target", "service.db"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT d.job_id, COUNT(*) AS n FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE j.probe = 0 GROUP BY d.job_id").all() as { n: number }[];
      const total = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE probe = 0").get() as { n: number }).n;
      return { delivered: rows.length, total, dup: rows.reduce((a, r) => a + r.n - 1, 0) };
    } finally { db.close(); }
  } catch { return null; }
}


// Kill the running worker on one side right now (judge's button).
export function killWorker(mode: Mode): number | null {
  const f = path.join(varDirFor(mode), "blackout", "journal.db");
  if (!fs.existsSync(f)) return null;
  const db = new DatabaseSync(f, { readOnly: true });
  let pid: number | undefined;
  try { pid = (db.prepare("SELECT pid FROM workers WHERE state = 'running' ORDER BY generation DESC LIMIT 1").get() as any)?.pid; } finally { db.close(); }
  if (!pid) return null;
  try { process.kill(pid, "SIGKILL"); } catch { return null; }
  fs.appendFileSync(path.join(varDirFor(mode), "harness", "events.log"), JSON.stringify({ ts: new Date().toISOString(), event: "worker_sigkilled", pid, point: "manual" }) + "\n");
  return pid;
}

// Arm the after-commit failpoint on one side: SIGKILL right after the 2nd batch delivery
// from now, i.e. mid-batch with one job acknowledged and one in flight.
export function armNextDelivery(mode: Mode) {
  const dir = path.join(varDirFor(mode), "harness");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ armed: true, kill_on_commit_number: 2, armed_at: new Date().toISOString() }));
}

export function startRace(o: RaceOpts, emit: (e: RaceEvent) => void): { children: ChildProcess[] } {
  const children: ChildProcess[] = [];
  MODES.forEach((mode, i) => setTimeout(() => children.push(launch(mode, i)), i * 2500));
  return { children };

  function launch(mode: Mode, i: number): ChildProcess {
    const varDir = varDirFor(mode);
    fs.rmSync(varDir, { recursive: true, force: true });
    const args = ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join(ROOT, "src/cli.ts"), "mission", "--mode", mode, "--profile", o.profile, "--fault", o.fault, "--kill-after", String(o.killAfter ?? 0), "--policy", o.policy, ...(o.inject ? ["--inject"] : [])];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, BLACKOUT_VAR_DIR: varDir, BLACKOUT_TARGET_PORT: String(7411 + i * 10), BLACKOUT_HARNESS_PORT: String(7412 + i * 10), BLACKOUT_RPM: "20", BLACKOUT_RETRIES: "9", BLACKOUT_FALLBACK: "1", BLACKOUT_RESULTS_DIR: path.join(ROOT, "results", "race") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let inSummary = false;
    const sum = { status: "", calls: null as number | null, usd: null as string | null, elapsed: null as string | null, file: null as string | null };
    const onData = (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const raw of parts) {
        if (!raw.trim()) continue;
        if (raw.includes("mission summary")) { inSummary = true; continue; }
        if (inSummary) {
          let m;
          if ((m = raw.match(/^status:\s+(\w+)/))) sum.status = m[1];
          if ((m = raw.match(/^inference:\s+(\d+) calls.*est (\$[\d.]+)/))) { sum.calls = Number(m[1]); sum.usd = m[2]; }
          if ((m = raw.match(/^elapsed:\s+([\d.]+s)/))) sum.elapsed = m[1];
          if (raw.startsWith("result file:")) { sum.file = raw.split(/\s+/).pop() ?? null; emit({ type: "summary", mode, ...sum }); }
        } else {
          const t = story(raw);
          if (t) emit({ type: "line", mode, text: t, tone: tone(t) });
        }
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", () => emit({ type: "exit", mode }));
    return child;
  }
}
