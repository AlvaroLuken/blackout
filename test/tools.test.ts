import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BLACKOUT_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "blackout-tools-"));
process.env.BLACKOUT_TARGET_PORT = "7491"; // nothing listens here
const { resetTarget } = await import("../src/target/reset.ts");
const { runTool, reconcile, redact } = await import("../src/adapter/tools.ts");
const { Journal } = await import("../src/store/journal.ts");
const { PATHS } = await import("../src/config.ts");

resetTarget();
const journal = new Journal();
journal.createMission("mt", "goal", "journal", "test");
const g = journal.newGeneration("mt", {});
const ctx = { missionId: "mt", generation: g, journal, useJournal: true };

test("path traversal and absolute paths are rejected", async () => {
  for (const p of ["../service.db", "/etc/passwd", "../../blackout/journal.db"]) {
    const r = await runTool("read_workspace_file", { path: p }, ctx);
    assert.equal(r.ok, false, p);
  }
});

test("symlinks out of the workspace are rejected", async () => {
  fs.symlinkSync(PATHS.targetDb, path.join(PATHS.workspace, "link.db"));
  const r = await runTool("read_workspace_file", { path: "link.db" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /symlink/);
});

test("unknown tools and malformed args are refused without running", async () => {
  assert.equal((await runTool("shell", { cmd: "ls" }, ctx)).ok, false);
  assert.equal((await runTool("process_jobs", { job_ids: "job-001" }, ctx)).ok, false);
  assert.equal((await runTool("read_logs", { tail: 10_000 }, ctx)).ok, false);
});

test("patch_config only edits existing leaf fields of the same type", async () => {
  assert.equal((await runTool("patch_config", { field: "fingerprint", value: "x" }, ctx)).ok, false);
  assert.equal((await runTool("patch_config", { field: "fingerprint.algorithm", value: 5 }, ctx)).ok, false);
  assert.equal((await runTool("patch_config", { field: "new_field", value: "x" }, ctx)).ok, false);
  assert.equal((await runTool("patch_config", { field: "log_level", value: "warn" }, ctx)).ok, true);
});

test("unreachable receipts make an interrupted action UNKNOWN, and it is not repeated", async () => {
  journal.recordIntent("mt", g, "mt-job-004-aaaaaa", "process_job", "job-004", {});
  const rep = await reconcile(ctx);
  assert.equal(rep.find((r) => r.op_id === "mt-job-004-aaaaaa")?.outcome, "unknown");
  const r = await runTool("process_jobs", { job_ids: ["job-004"] }, ctx);
  assert.match(r.output, /unknown outcome/);
});

test("secrets are redacted from tool output", () => {
  const s = redact('Authorization: Bearer abcdefghijklmnop12345 api_key="sk-live-1234567890abcdef"');
  assert.doesNotMatch(s, /abcdefghijklmnop12345|1234567890abcdef/);
});
