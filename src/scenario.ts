// Scenario runner: reset the world, start the target and the fault harness as
// separate processes, inject the fault, arm the kill point, run one mission,
// save a machine-readable result. Used by `npm run demo`, `mission`, `eval`.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PATHS, ROOT, TARGET_URL } from "./config.ts";
import { resetTarget } from "./target/reset.ts";
import { injectFault, armKill, disarm, type FaultName } from "./faults/harness.ts";
import { runMission, type MissionOutcome } from "./controller/mission.ts";
import { DatabaseSync } from "node:sqlite";

export type ScenarioOpts = {
  fault: FaultName | "none";
  killAfter: number | null;
  mode: "journal" | "baseline";
  policy: "llm" | "test";
  goal?: string;
  quiet?: boolean;
  label?: string;
};

export const DEFAULT_GOAL = "Get this service working again, finish its pending jobs, and do not duplicate anything.";

function startProc(script: string, args: string[] = []): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join(ROOT, script), ...args], { stdio: ["ignore", "ignore", "inherit"], env: process.env });
}

async function waitHealthy(ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${TARGET_URL}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("target did not start");
}

async function portFree() {
  try { await fetch(`${TARGET_URL}/health`, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
}

// Counts from the target's own database: what actually got committed.
export function targetFacts() {
  const db = new DatabaseSync(PATHS.targetDb, { readOnly: true });
  try {
    const perJob = db.prepare("SELECT d.job_id, COUNT(*) AS n FROM deliveries d JOIN jobs j ON j.id = d.job_id WHERE j.probe = 0 GROUP BY d.job_id").all() as { job_id: string; n: number }[];
    const jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE probe = 0").get() as { n: number };
    return {
      scope_jobs: jobs.n,
      jobs_with_delivery: perJob.length,
      missing_jobs: jobs.n - perJob.length,
      duplicate_committed_deliveries: perJob.reduce((s, r) => s + Math.max(0, r.n - 1), 0),
    };
  } finally { db.close(); }
}

export async function runScenario(o: ScenarioOpts) {
  if (!(await portFree())) throw new Error(`port for ${TARGET_URL} is busy; stop the other target first`);
  resetTarget();
  fs.rmSync(PATHS.harnessDir, { recursive: true, force: true });
  disarm();
  const say = (s: string) => { if (!o.quiet) console.log(s); };

  const target = startProc("src/target/supervisor.ts");
  const harness = startProc("src/faults/harness.ts", ["serve"]);
  try {
    await waitHealthy();
    if (o.fault !== "none") {
      injectFault(o.fault);
      await fetch(`${TARGET_URL}/admin/restart`, { method: "POST" }).catch(() => null);
      await new Promise((r) => setTimeout(r, 400));
      await waitHealthy();
      say(`[harness] fault injected and service restarted (fault label hidden from agents)`);
    }
    const h = (await (await fetch(`${TARGET_URL}/health`)).json()) as any;
    say(`[harness] GET /health -> 200 ${JSON.stringify({ status: h.status, version: h.version })}`);
    if (o.killAfter) { armKill(o.killAfter); say(`[harness] armed: SIGKILL the repair worker right after target commit #${o.killAfter}, before it can acknowledge`); }

    const outcome = await runMission({ goal: o.goal ?? DEFAULT_GOAL, mode: o.mode, policy: o.policy, quiet: o.quiet });
    const facts = targetFacts();
    const harnessEvents = fs.existsSync(PATHS.harnessLog) ? fs.readFileSync(PATHS.harnessLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const result = { label: o.label ?? null, scenario: { fault: o.fault, kill_after_commit: o.killAfter }, ...outcome, target_facts: facts, harness_events: harnessEvents, recorded_at: new Date().toISOString(), inference: o.policy === "llm" ? "live Crusoe inference" : "none (deterministic test policy)" };
    fs.mkdirSync(path.join(PATHS.results, "runs"), { recursive: true });
    const file = path.join(PATHS.results, "runs", `${result.recorded_at.replace(/[:.]/g, "-")}-${outcome.mission_id}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    printSummary(say, result as any, file);
    return result;
  } finally {
    target.kill("SIGTERM");
    harness.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }
}

function printSummary(say: (s: string) => void, r: MissionOutcome & { target_facts: ReturnType<typeof targetFacts>; harness_events: any[] }, file: string) {
  const u = r.usage;
  say("\n================ mission summary ================");
  say(`status:            ${r.status.toUpperCase()} (${r.reason})`);
  say(`verifier:          ${r.final_verdict.pass ? "PASS" : "FAIL"}  ${r.final_verdict.progress.valid_jobs}/${r.final_verdict.progress.scope_jobs} jobs valid`);
  say(`committed output:  missing=${r.target_facts.missing_jobs} duplicates=${r.target_facts.duplicate_committed_deliveries}  (counted from the target's own DB)`);
  say(`worker kills:      ${r.harness_events.filter((e) => e.event === "worker_sigkilled").length}  replacements: ${r.crashes}`);
  say(`episodes:          ${r.episodes}`);
  say(`inference:         ${r.policy === "llm" ? `${u.calls} calls, ${u.prompt_tokens} in / ${u.completion_tokens} out tokens, est $${u.est_usd?.toFixed(4) ?? "unknown"} (${r.model})` : "none (deterministic test policy)"}`);
  say(`elapsed:           ${(r.elapsed_ms / 1000).toFixed(1)}s${r.recovery_ms ? `  (crash to verified: ${(r.recovery_ms / 1000).toFixed(1)}s)` : ""}`);
  say(`result file:       ${path.relative(ROOT, file)}`);
}
