// Progress-aware control rules. Pure functions so they can be tested without
// inference. The controller applies these on top of the coordinator's choice.
import type { Verdict } from "../verifier/verifier.ts";

export type ControlState = {
  lastProgressKey: string | null;
  noProgressStreak: number;
  crashes: number;
  episodes: number;
};
export const CONTROL_LIMITS = { maxEpisodes: 6, maxCrashes: 3, noProgressReplanAt: 1, noProgressEscalateAt: 2 };

export function progressKey(v: Verdict) {
  const p = v.progress;
  return `${p.valid_jobs}/${p.scope_jobs}|dup${p.duplicate_jobs}|fail${p.failed_mandatory}`;
}

export type Forced = { kind: "none" } | { kind: "replan"; reason: string } | { kind: "escalate"; reason: string };

// Called after a worker episode that ended normally (not a crash).
export function afterEpisode(state: ControlState, verdict: Verdict): { state: ControlState; forced: Forced } {
  const key = progressKey(verdict);
  const same = state.lastProgressKey === key;
  const streak = same ? state.noProgressStreak + 1 : 0;
  const next: ControlState = { ...state, lastProgressKey: key, noProgressStreak: streak, episodes: state.episodes + 1 };
  if (verdict.progress.duplicate_jobs > 0) return { state: next, forced: { kind: "escalate", reason: "duplicate deliveries exist; repair cannot undo a committed side effect safely" } };
  if (streak >= CONTROL_LIMITS.noProgressEscalateAt) return { state: next, forced: { kind: "escalate", reason: `no verified progress for ${streak} consecutive episodes (${key})` } };
  if (streak >= CONTROL_LIMITS.noProgressReplanAt) return { state: next, forced: { kind: "replan", reason: `the last episode made no verified progress (${key}); the previous approach did not work` } };
  if (next.episodes >= CONTROL_LIMITS.maxEpisodes) return { state: next, forced: { kind: "escalate", reason: `episode limit ${CONTROL_LIMITS.maxEpisodes} reached` } };
  return { state: next, forced: { kind: "none" } };
}

export function afterCrash(state: ControlState): { state: ControlState; forced: Forced } {
  const next = { ...state, crashes: state.crashes + 1 };
  if (next.crashes > CONTROL_LIMITS.maxCrashes) return { state: next, forced: { kind: "escalate", reason: `worker crashed ${next.crashes} times` } };
  return { state: next, forced: { kind: "none" } };
}
