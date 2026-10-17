// Blackout command line. Subcommands: reset, fault, verify, mission, demo, eval.
import fs from "node:fs";
import { PATHS } from "./config.ts";
import { resetTarget } from "./target/reset.ts";
import { injectFault, armKill, disarm, FAULTS, type FaultName } from "./faults/harness.ts";
import { freezeContract } from "./contract/contract.ts";
import { snapshotScope, verify } from "./verifier/verifier.ts";
import { runScenario, DEFAULT_GOAL } from "./scenario.ts";

const [cmd, ...args] = process.argv.slice(2);

function resetAll() {
  resetTarget();
  fs.rmSync(PATHS.blackoutDir, { recursive: true, force: true });
  fs.rmSync(PATHS.harnessDir, { recursive: true, force: true });
  fs.mkdirSync(PATHS.blackoutDir, { recursive: true });
  disarm();
}

async function main() {
  switch (cmd) {
    case "reset":
      resetAll();
      console.log("reset: target, journal, and harness state rebuilt (restart the target to load the config)");
      return;
    case "fault": {
      const [what, arg] = args;
      if (what === "arm-kill") { armKill(Number(arg ?? 2)); console.log(`armed: SIGKILL worker after commit #${arg ?? 2}`); return; }
      if (what === "disarm") { disarm(); console.log("disarmed"); return; }
      if (!(what in FAULTS)) { console.error(`unknown fault. options: ${Object.keys(FAULTS).join(", ")}, arm-kill N, disarm`); process.exit(2); }
      injectFault(what as FaultName);
      console.log(`fault injected: ${what} (restart the target to load it)`);
      return;
    }
    case "verify": {
      // Ad hoc verification against the mandatory checks only.
      const c = freezeContract(`adhoc-${Date.now()}`, "ad hoc verification", { goal_summary: "ad hoc", checks: [] }, snapshotScope());
      const v = await verify(c);
      for (const r of v.results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.kind.padEnd(28)} ${r.detail}`);
      console.log(v.pass ? "VERIFIED" : "NOT VERIFIED", JSON.stringify(v.progress));
      return;
    }
    case "mission":
    case "demo": {
      const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
      const kill = flag("kill-after", cmd === "demo" ? "2" : "0");
      const r = await runScenario({
        fault: flag("fault", "bad_digest") as FaultName | "none",
        killAfter: Number(kill) || null,
        mode: flag("mode", "journal") as "journal" | "baseline",
        policy: flag("policy", "llm") as "llm" | "test",
        goal: flag("goal", DEFAULT_GOAL),
      });
      process.exit(r.status === "verified" ? 0 : 1);
    }
    case "eval": {
      // Predefined paired ablation. Same model, tools, contract rules, verifier,
      // inputs, reset state, kill point and budget. Only the mode differs:
      //   journal:  durable action journal + automatic receipt reconciliation
      //   baseline: neither; the replacement worker gets the original task, a note
      //             that the previous worker exited, and the same receipt tools.
      const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
      const pairs = Number(flag("pairs", "1"));
      const policy = flag("policy", "llm") as "llm" | "test";
      const runs: any[] = [];
      for (let i = 0; i < pairs; i++) {
        for (const mode of ["journal", "baseline"] as const) {
          console.log(`\n######## pair ${i + 1}/${pairs}  mode=${mode} ########`);
          runs.push(await runScenario({ fault: "bad_digest", killAfter: 2, mode, policy, label: `eval-pair${i + 1}-${mode}` }));
        }
      }
      const row = (r: any) => ({
        mode: r.mode, status: r.status, verified: r.final_verdict.pass, false_success: r.declared_success_without_verification,
        missing: r.target_facts.missing_jobs, duplicate_committed: r.target_facts.duplicate_committed_deliveries,
        kills: r.harness_events.filter((e: any) => e.event === "worker_sigkilled").length, episodes: r.episodes,
        calls: r.usage.calls, tokens: r.usage.prompt_tokens + r.usage.completion_tokens, est_usd: r.usage.est_usd,
        elapsed_s: +(r.elapsed_ms / 1000).toFixed(1), recovery_s: r.recovery_ms ? +(r.recovery_ms / 1000).toFixed(1) : null, mission: r.mission_id,
      });
      const table = runs.map(row);
      console.log("\n======== ablation results (every run) ========");
      console.table(table);
      fs.mkdirSync(PATHS.results, { recursive: true });
      const file = `${PATHS.results}/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      fs.writeFileSync(file, JSON.stringify({ policy, model: runs[0]?.model, pairs, design: "paired; only journal+reconciliation toggled", runs: table }, null, 2));
      console.log(`saved ${file}  (n=${pairs} pair(s); small sample, no statistical claims)`);
      return;
    }
    default:
      console.error("usage: blackout <reset|fault|verify|mission|demo|eval>");
      process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
