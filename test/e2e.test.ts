import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Real processes: target supervisor + server, harness, controller, worker generations.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackout-e2e-"));
process.env.BLACKOUT_VAR_DIR = dir;
process.env.BLACKOUT_RESULTS_DIR = path.join(dir, "results");
process.env.BLACKOUT_TARGET_PORT = "7481";
process.env.BLACKOUT_HARNESS_PORT = "7482";
const { runScenario } = await import("../src/scenario.ts");

test("worker SIGKILLed after a committed delivery: replacement reconciles, no loss, no duplicates (test policy)", { timeout: 60_000 }, async () => {
  const r = await runScenario({ fault: "bad_digest", killAfter: 2, mode: "journal", policy: "test", quiet: true });
  assert.equal(r.status, "verified");
  assert.equal(r.harness_events.filter((e: any) => e.event === "worker_sigkilled").length, 1);
  assert.equal(r.crashes, 1);
  assert.equal(r.target_facts.missing_jobs, 0);
  assert.equal(r.target_facts.duplicate_committed_deliveries, 0);
  assert.equal(r.declared_success_without_verification, false);
});

test("missing inference key ends in escalation, never a success claim", { timeout: 60_000 }, async () => {
  process.env.CRUSOE_API_KEY = "replace-me";
  const r = await runScenario({ fault: "bad_digest", killAfter: null, mode: "journal", policy: "llm", quiet: true });
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /CRUSOE_API_KEY/);
  assert.equal(r.final_verdict.pass, false);
});
