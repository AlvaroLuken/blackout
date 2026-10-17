// Repair worker process. Spawned by the controller for one assignment, one
// generation. It can be SIGKILLed at any point; everything it needs to resume
// safely is in the journal and the target's receipts.
import { Journal } from "../store/journal.ts";
import { reconcile, type ToolCtx } from "../adapter/tools.ts";
import { loadFrozenContract } from "../contract/contract.ts";
import { testPolicy, llmPolicy, type Brief } from "./policies.ts";
import { BudgetExceeded, InferenceUnavailable } from "../llm/crusoe.ts";

const [missionId, genStr] = process.argv.slice(2);
const generation = Number(genStr);
const journal = new Journal();
const mission = journal.mission(missionId)!;
const assignment = JSON.parse((journal.db.prepare("SELECT assignment FROM workers WHERE mission_id = ? AND generation = ?").get(missionId, generation) as any).assignment);
journal.workerStarted(missionId, generation, process.pid);
const actor = `worker.g${generation}`;
journal.event(missionId, actor, "worker_started", { pid: process.pid, policy: mission.policy, mode: mission.mode });

const useJournal = mission.mode === "journal";
const ctx: ToolCtx = { missionId, generation, journal, useJournal };
const contract = loadFrozenContract(missionId);

let journalContext = "";
if (useJournal) {
  const rec = await reconcile(ctx);
  if (rec.length) {
    journal.event(missionId, actor, "reconciled", { actions: rec });
    console.log(`  [${actor}] reconciled ${rec.length} unacknowledged action(s) from target receipts:`);
    for (const r of rec) console.log(`    ${r.kind} ${r.target_ref} op=${r.op_id} -> ${r.outcome}`);
  }
  const unknown = rec.filter((r) => r.outcome === "unknown");
  const acts = journal.actions(missionId);
  const delivered = acts.filter((a) => a.kind === "process_job" && (a.status === "acked" || a.status === "reconciled_done")).map((a) => a.target_ref);
  const retryable = acts.filter((a) => a.kind === "process_job" && a.status === "reconciled_absent").map((a) => a.target_ref);
  const lines = [
    "Blackout journal (authoritative record of this mission's prior actions, reconciled against service receipts):",
    `- Prior worker generations: ${generation - 1}.`,
    `- Jobs delivered by this mission and confirmed by receipt: ${delivered.join(", ") || "none"}.`,
    retryable.length ? `- Jobs whose earlier attempt left no receipt (safe to retry; the same op_id will be reused): ${retryable.join(", ")}.` : "",
    unknown.length ? `- Actions with UNKNOWN outcome: ${unknown.map((u) => u.target_ref).join(", ")}. Do not repeat these.` : "",
    `- Config patches applied: ${acts.filter((a) => a.kind === "patch_config" && a.status !== "reconciled_absent").map((a) => a.target_ref).join(", ") || "none"}.`,
  ].filter(Boolean);
  journalContext = lines.join("\n");
} else if (generation > 1) {
  journalContext = "Note: a previous worker on this mission exited unexpectedly. No record of its actions is available.";
}

const brief: Brief = { goal: mission.goal, instructions: assignment.instructions, checks: contract.checks.map((c) => c.kind), journalContext };

try {
  const result = mission.policy === "test"
    ? await testPolicy(ctx, brief)
    : await llmPolicy(ctx, brief, assignment.limits);
  journal.event(missionId, actor, "worker_report", result);
  journal.workerEnded(missionId, generation, "exited", result);
  process.exit(0);
} catch (e) {
  const kind = e instanceof BudgetExceeded ? "budget_exceeded" : e instanceof InferenceUnavailable ? "inference_unavailable" : "error";
  journal.event(missionId, actor, "worker_error", { kind, message: (e as Error).message });
  journal.workerEnded(missionId, generation, "errored", { kind, message: (e as Error).message });
  console.log(`  [${actor}] stopped: ${kind}: ${(e as Error).message}`);
  process.exit(3);
}
