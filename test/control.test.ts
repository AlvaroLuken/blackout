import { test } from "node:test";
import assert from "node:assert/strict";
import { afterEpisode, afterCrash, CONTROL_LIMITS, type ControlState } from "../src/controller/control.ts";
import type { Verdict } from "../src/verifier/verifier.ts";

const v = (valid: number, dup = 0, failed = 2): Verdict => ({
  pass: false, contract_hash: "x", results: [], at: "",
  progress: { valid_jobs: valid, scope_jobs: 10, duplicate_jobs: dup, failed_mandatory: failed },
});
const fresh: ControlState = { lastProgressKey: null, noProgressStreak: 0, crashes: 0, episodes: 0 };

test("progress resets the no-progress streak", () => {
  let s = afterEpisode(fresh, v(3)).state;
  const r = afterEpisode(s, v(6));
  assert.equal(r.forced.kind, "none");
  assert.equal(r.state.noProgressStreak, 0);
});

test("same progress vector forces replan, then escalation", () => {
  let s = afterEpisode(fresh, v(3)).state;
  const r1 = afterEpisode(s, v(3));
  assert.equal(r1.forced.kind, "replan");
  const r2 = afterEpisode(r1.state, v(3));
  assert.equal(r2.forced.kind, "escalate");
});

test("committed duplicates escalate immediately", () => {
  assert.equal(afterEpisode(fresh, v(10, 1, 1)).forced.kind, "escalate");
});

test("episode limit escalates instead of looping forever", () => {
  let s = fresh;
  let last;
  for (let i = 0; i < CONTROL_LIMITS.maxEpisodes; i++) { last = afterEpisode(s, v(i)); s = last.state; }
  assert.equal(last!.forced.kind, "escalate");
});

test("too many worker crashes escalate", () => {
  let s = fresh;
  let r;
  for (let i = 0; i <= CONTROL_LIMITS.maxCrashes; i++) { r = afterCrash(s); s = r.state; }
  assert.equal(r!.forced.kind, "escalate");
});
