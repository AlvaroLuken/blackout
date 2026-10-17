import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BLACKOUT_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "blackout-contract-"));
const { freezeContract, loadFrozenContract, MANDATORY, contractHash } = await import("../src/contract/contract.ts");
const scope = { job_ids: ["job-001"], preexisting: [] };

test("mandatory checks are always present even if the model proposes none", () => {
  const c = freezeContract("t1", "g", { goal_summary: "g", checks: [] }, scope);
  for (const m of MANDATORY) assert.ok(c.checks.some((x) => x.kind === m.kind && x.source === "mandatory"));
});

test("unsupported model checks are rejected, supported ones added", () => {
  const c = freezeContract("t2", "g", { goal_summary: "g", checks: [{ kind: "rm_rf" }, { kind: "health_ok" }, { kind: "expected_scope_size", count: 1 }] }, scope);
  assert.deepEqual(c.rejected_checks, [{ check: { kind: "rm_rf" }, reason: "not in the allowed check vocabulary" }]);
  assert.ok(c.checks.some((x) => x.kind === "health_ok" && x.source === "model"));
  assert.ok(c.checks.some((x) => x.kind === "expected_scope_size"));
});

test("a tampered frozen contract is refused", () => {
  const c = freezeContract("t3", "g", { goal_summary: "g", checks: [] }, scope);
  const file = path.join(process.env.BLACKOUT_VAR_DIR!, "blackout", "contracts", "t3.json");
  const tampered = { ...c, checks: c.checks.slice(1) };
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => loadFrozenContract("t3"), /hash mismatch/);
  assert.notEqual(contractHash(tampered), c.hash);
});

test("a proposed check that contradicts the observed scope is rejected at freeze", () => {
  const c = freezeContract("t4", "g", { goal_summary: "g", checks: [{ kind: "expected_scope_size", count: 3 }] }, { job_ids: ["a", "b", "c", "d"], preexisting: [] });
  assert.equal(c.checks.some((x) => x.kind === "expected_scope_size"), false);
  assert.match((c.rejected_checks[0] as any).reason, /inconsistent with observed scope/);
});

test("a malformed proposal still freezes with mandatory checks and the user's goal", () => {
  const c = freezeContract("t5", "fix it", { checks: "nope", assumptions: [1, "ok"] }, scope);
  assert.equal(c.goal_summary, "fix it");
  assert.deepEqual(c.assumptions, ["ok"]);
  assert.equal(c.checks.filter((x) => x.source === "mandatory").length, MANDATORY.length);
});
