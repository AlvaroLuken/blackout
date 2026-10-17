# Measured results

All runs below are live inference: `nvidia/Nemotron-3.5-Lightning-30B-A3B` on Crusoe Managed Inference,
for both the coordinator and the repair worker. Cost is estimated from the per-call `usage` returned by the
API and the catalog price ($0.05 in / $0.20 out per 1M tokens). Raw per-run JSON is in `results/runs/`.

## Paired ablation (predefined), Oct 17 2026, n = 3 pairs

Same model, tools, contract rules, verifier, synthetic inputs, reset state, fault (`bad_digest`),
kill point (SIGKILL after the 2nd batch delivery commits) and budget. Only one thing changes:

- **journal**: durable action journal with op IDs written before each side effect, plus automatic
  receipt reconciliation when a replacement worker starts.
- **baseline**: neither. The replacement worker gets the original task, a note that the previous
  worker exited, and the same tools (including receipt lookup).

| mode | runs | verified | false success claims | missing outputs | duplicate committed deliveries | median calls | mean est. cost |
|---|---|---|---|---|---|---|---|
| journal | 3 | 3 | 0 | 0 | 0 | 30 | $0.0061 |
| baseline | 3 | 2 | 0 | 0 | 1 (one run) | 29 | $0.0049 |

Source: `results/eval-2026-10-17T18-41-54-094Z.json`.

What actually happened in the failed baseline run (mission `m8bf70e`): the crash itself was recovered
fine, because this target exposes per-job status and the model used it. The duplicate came later, from
the model's own retry: it sent a batch with a typo (`job-10`), saw a partial failure, and re-sent
`job-009`, which had already been delivered. In journal mode `process_jobs` skips jobs the journal
records as delivered, so that retry would have been a no-op. Blackout escalated the run instead of
reporting success.

Honest reading:
- 3 pairs is a small sample. No statistical claim.
- On this target, receipt reconciliation was not needed for correctness after the crash, because
  job status was visible. Targets without per-job status (for example, fire-and-forget sends) were not tested.
- No run in either mode produced a false success claim; the controller only accepts a verifier pass.

## Other live runs

| mission | what | outcome |
|---|---|---|
| me4dd52 | first live run, no kill | Nemotron repaired the service in episode 1 (10/10, 0 duplicates), but a coordinator-added check expected 3 jobs, not 10. Controller detected no progress and escalated. Led to grounding the contract in observed scope. 54 calls, $0.0138. |
| m13eb14 | live, kill | coordinator hit `finish_reason: length` at 3000 tokens while reasoning; malformed proposal crashed the controller. Fixed (8192 budget, thinking-off retry, lenient freeze). |
| mad3095 | live, kill | VERIFIED. 10/10, 0 duplicates, 1 SIGKILL, 31 calls, $0.0059, crash to verified 15.8 s. |
