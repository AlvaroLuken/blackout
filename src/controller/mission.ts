// Mission controller. Runs outside the target's failure domain. Owns the
// journal, freezes the contract, spawns killable worker generations, runs the
// verifier, and applies progress-aware control around the coordinator.
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "../config.ts";
import { Journal } from "../store/journal.ts";
import { freezeContract, type FrozenContract } from "../contract/contract.ts";
import { snapshotScope, verify, type Verdict } from "../verifier/verifier.ts";
import { proposeContract, decide, TEST_PROPOSAL, TEST_INSTRUCTIONS } from "./coordinator.ts";
import { afterCrash, afterEpisode, type ControlState } from "./control.ts";
import { BudgetExceeded, InferenceUnavailable, MODEL, limitsFromEnv, type Limits } from "../llm/crusoe.ts";

export type MissionOpts = {
  goal: string;
  mode: "journal" | "baseline";
  policy: "llm" | "test";
  quiet?: boolean;
  timeLimitMs?: number;
};

export type MissionOutcome = {
  mission_id: string;
  mode: string;
  policy: string;
  model: string | null;
  status: "verified" | "escalated";
  reason: string;
  episodes: number;
  crashes: number;
  final_verdict: Verdict;
  declared_success_without_verification: boolean;
  usage: ReturnType<Journal["usageTotals"]>;
  elapsed_ms: number;
  recovery_ms: number | null;
};

export async function runMission(opts: MissionOpts): Promise<MissionOutcome> {
  const say = (s: string) => { if (!opts.quiet) console.log(s); };
  const started = Date.now();
  const missionId = `m${randomUUID().slice(0, 6)}`;
  const journal = new Journal();
  const limits: Limits = limitsFromEnv(opts.timeLimitMs);
  journal.createMission(missionId, opts.goal, opts.mode, opts.policy);
  say(`\n[controller] mission ${missionId}  mode=${opts.mode}  policy=${opts.policy === "test" ? "DETERMINISTIC TEST POLICY (not autonomous)" : `llm ${MODEL} via Crusoe`}`);
  say(`[controller] goal: "${opts.goal}"`);

  const escalate = (reason: string, verdict: Verdict, episodes: number, crashes: number, recoveryMs: number | null): MissionOutcome => {
    journal.setMission(missionId, { status: "escalated" });
    journal.event(missionId, "controller", "escalated", { reason });
    say(`[controller] ESCALATE to human: ${reason}`);
    return finish("escalated", reason, verdict, episodes, crashes, recoveryMs);
  };
  const finish = (status: "verified" | "escalated", reason: string, verdict: Verdict, episodes: number, crashes: number, recoveryMs: number | null): MissionOutcome => {
    const out: MissionOutcome = {
      mission_id: missionId, mode: opts.mode, policy: opts.policy, model: opts.policy === "llm" ? MODEL : null, status, reason,
      episodes, crashes, final_verdict: verdict,
      declared_success_without_verification: status === "verified" && !verdict.pass,
      usage: journal.usageTotals(missionId), elapsed_ms: Date.now() - started, recovery_ms: recoveryMs,
    };
    journal.event(missionId, "controller", "mission_end", out);
    journal.close();
    return out;
  };

  // 1. Definition of done, before any repair.
  let proposal: unknown;
  const scope = snapshotScope();
  try {
    proposal = opts.policy === "test" ? TEST_PROPOSAL : await proposeContract(journal, missionId, limits, opts.goal, { batch_jobs: scope.job_ids.length, already_delivered: new Set(scope.preexisting.map((p) => p.job_id)).size });
  } catch (e) {
    proposal = { goal_summary: opts.goal, assumptions: ["Coordinator proposal unavailable; mandatory checks only."], checks: [] };
    journal.event(missionId, "coordinator", "proposal_failed", { message: (e as Error).message });
    if (e instanceof InferenceUnavailable || e instanceof BudgetExceeded) {
      const c = freezeContract(missionId, opts.goal, proposal, scope);
      return escalate(`cannot start: ${(e as Error).message}`, await verify(c), 0, 0, null);
    }
  }
  const contract: FrozenContract = freezeContract(missionId, opts.goal, proposal, scope);
  journal.setMission(missionId, { contract_hash: contract.hash, status: "running" });
  journal.event(missionId, "controller", "contract_frozen", { hash: contract.hash, checks: contract.checks, assumptions: contract.assumptions, rejected: contract.rejected_checks });
  say(`[coordinator] contract proposed: "${contract.goal_summary}"`);
  for (const a of contract.assumptions) say(`[coordinator]   assumption: ${a}`);
  say(`[controller] contract frozen sha256:${contract.hash.slice(0, 12)}  scope=${contract.scope.job_ids.length} jobs, ${contract.scope.preexisting.length} pre-existing deliveries`);
  say(`[controller]   checks: ${contract.checks.map((c) => `${c.kind}${c.source === "model" ? "(model)" : ""}`).join(", ")}`);
  for (const r of contract.rejected_checks as { check: unknown; reason: string }[]) say(`[controller]   rejected proposed check ${JSON.stringify(r.check)}: ${r.reason}`);

  let verdict = await verify(contract);
  journal.recordVerdict(missionId, verdict);
  printVerdict(say, "before repair", verdict);
  if (verdict.pass) return finish("verified", "already satisfied", verdict, 0, 0, null);

  let state: ControlState = { lastProgressKey: null, noProgressStreak: 0, crashes: 0, episodes: 0 };
  let instructions = opts.policy === "test" ? TEST_INSTRUCTIONS : `Investigate why the service is not completing jobs, repair it, verify the repair with a test job, then deliver every remaining batch job exactly once. Goal: ${opts.goal}`;
  const history: string[] = [];
  let crashAt: number | null = null;
  let recoveryMs: number | null = null;

  while (true) {
    const g = journal.newGeneration(missionId, { instructions, limits });
    say(`[controller] spawn worker generation ${g}`);
    const exit = await runWorker(missionId, g, opts.quiet);
    if (exit.signal) {
      journal.workerEnded(missionId, g, "killed", exit);
      journal.event(missionId, "controller", "worker_crashed", { generation: g, signal: exit.signal });
      say(`[controller] worker g${g} died (${exit.signal}). Its last action has no acknowledgement. Starting a replacement from the journal.`);
      crashAt ??= Date.now();
      const r = afterCrash(state); state = r.state;
      if (r.forced.kind === "escalate") return escalate(r.forced.reason, verdict, state.episodes, state.crashes, recoveryMs);
      continue;
    }
    const report = (journal.db.prepare("SELECT data FROM events WHERE mission_id = ? AND type IN ('worker_report','worker_error') ORDER BY id DESC LIMIT 1").get(missionId) as any)?.data;
    const workerReport = report ? JSON.parse(report) : { summary: "no report" };

    verdict = await verify(contract);
    journal.recordVerdict(missionId, verdict);
    printVerdict(say, `after episode ${state.episodes + 1}`, verdict);
    if (verdict.pass) {
      if (crashAt) recoveryMs = Date.now() - crashAt;
      journal.setMission(missionId, { status: "verified" });
      say(`[controller] DONE: all ${contract.checks.length} contract checks pass against real service state.`);
      return finish("verified", "verifier passed", verdict, state.episodes + 1, state.crashes, recoveryMs);
    }
    if (workerReport.kind === "budget_exceeded" || workerReport.kind === "inference_unavailable") {
      return escalate(`worker stopped: ${workerReport.message}`, verdict, state.episodes + 1, state.crashes, recoveryMs);
    }
    if (workerReport.believes_done) say(`[controller] worker claimed done, verifier disagrees. Claim rejected.`);
    const unknown = journal.actions(missionId).filter((a) => a.status === "unknown");
    if (unknown.length) {
      return escalate(`outcome of ${unknown.length} action(s) cannot be established from target receipts (${unknown.map((u) => u.target_ref).join(", ")}); not retrying blindly`, verdict, state.episodes + 1, state.crashes, recoveryMs);
    }

    const r = afterEpisode(state, verdict); state = r.state;
    if (r.forced.kind === "escalate") return escalate(r.forced.reason, verdict, state.episodes, state.crashes, recoveryMs);
    if (r.forced.kind === "replan") say(`[controller] no progress detected: forcing replan`);

    if (opts.policy === "test") {
      if (r.forced.kind === "replan") return escalate("test policy has no alternative plan", verdict, state.episodes, state.crashes, recoveryMs);
      continue;
    }
    let d;
    try {
      d = await decide(journal, missionId, limits, { goal: opts.goal, episode: state.episodes, verdict, workerReport, history, forced: r.forced.kind === "replan" ? r.forced.reason + ". You must choose replan with a different approach, or escalate." : undefined });
    } catch (e) {
      return escalate(`coordinator unavailable: ${(e as Error).message}`, verdict, state.episodes, state.crashes, recoveryMs);
    }
    let decision = d.decision.decision;
    if (r.forced.kind === "replan" && decision === "continue") decision = "replan";
    journal.event(missionId, "coordinator", "decision", { ...d.decision, effective: decision, forced: r.forced });
    say(`[coordinator] ${decision.toUpperCase()}: ${d.decision.rationale}`);
    history.push(`ep${state.episodes}:${decision}:${verdict.progress.valid_jobs}/${verdict.progress.scope_jobs}`);
    if (decision === "escalate") return escalate(`coordinator: ${d.decision.rationale || d.decision.instructions}`, verdict, state.episodes, state.crashes, recoveryMs);
    instructions = d.decision.instructions;
  }
}

function printVerdict(say: (s: string) => void, label: string, v: Verdict) {
  say(`[verifier] ${label}: ${v.pass ? "PASS" : "FAIL"}  valid=${v.progress.valid_jobs}/${v.progress.scope_jobs} duplicates=${v.progress.duplicate_jobs} failed_mandatory=${v.progress.failed_mandatory}`);
  for (const r of v.results) if (!r.pass) say(`[verifier]   x ${r.kind}: ${r.detail}`);
}

function runWorker(missionId: string, g: number, quiet?: boolean): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning", path.join(ROOT, "src/worker/main.ts"), missionId, String(g)], {
      stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"],
      env: process.env,
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}
