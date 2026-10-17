// Blackout command line. Subcommands: reset, fault, verify, mission, demo, eval.
import fs from "node:fs";
import { PATHS } from "./config.ts";
import { resetTarget } from "./target/reset.ts";
import { injectFault, armKill, disarm, FAULTS, type FaultName } from "./faults/harness.ts";
import { freezeContract } from "./contract/contract.ts";
import { snapshotScope, verify } from "./verifier/verifier.ts";

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
    default:
      console.error("usage: blackout <reset|fault|verify|mission|demo|eval>");
      process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
