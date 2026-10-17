# Demo plan

## Before going on stage

1. `npm run smoke` once (warm-up call, confirms the key).
2. Terminal font large, window wide enough that lines do not wrap. Dark background.
3. Have the recorded fallback ready: `docs/recording/` (labelled "recorded run, Oct 17").
4. `npm run reset` is not needed; every run resets itself.

## Three-minute live demo

| Time | Say | Show |
|---|---|---|
| 0:00 | "Agents say done when they feel done. Blackout says done only when code it cannot argue with agrees. And it keeps that promise when the agent doing the work gets killed." | Title line |
| 0:20 | "Here is a job service. Its health check says OK. Every job is actually failing." | Start `npm run demo -- --profile outbox`. Point at `GET /health -> 200` and `before repair: FAIL valid=3/10` |
| 0:40 | "Nemotron writes the definition of done first. Code adds the checks it is not allowed to skip, then freezes it with a hash." | `contract frozen sha256:...` and the check list |
| 1:00 | "Now the repair worker, also Nemotron on Crusoe, investigates with a small set of allowed tools." | Worker lines: logs, config, docs, patch, restart, test job |
| 1:30 | "It starts delivering. Our harness kills it with a real SIGKILL right after a delivery commits, before the worker can record it." | `-> process_jobs ...` then `worker g1 died (SIGKILL)` |
| 1:50 | "On this kind of service the job still looks pending. A fresh agent would send it again. Blackout's replacement asks the service for the receipt of the exact operation in flight." | `reconciled ... -> reconciled_done` |
| 2:15 | "It finishes only what is left. The verifier, plain code, checks every output in the real database." | `PASS valid=10/10 duplicates=0`, summary block, cost line |
| 2:35 | "Same model, same kill, journal turned off:" | Results table from `results/RESULTS.md` (outbox and ledger, n=10) |
| 2:50 | "The model proposes, code decides. That is what lets you walk away." | End |

Optional judge moment: let a judge pick the kill point, `npm run demo -- --profile outbox --kill-after N` with N from 1 to 6.

## One-minute video script

1. (0:00-0:08) Health says OK, jobs fail. "Agents trust signals like this. Blackout doesn't."
2. (0:08-0:18) Contract frozen with hash. "Nemotron writes the definition of done. Code makes it binding."
3. (0:18-0:32) Worker diagnoses and fixes the config with allowlisted tools.
4. (0:32-0:42) SIGKILL lands mid-batch. Replacement reconciles the receipt.
5. (0:42-0:52) Verifier PASS 10/10, 0 duplicates, cost line.
6. (0:52-1:00) Ablation table. "Everything shown was built today. Nemotron 3.5 Lightning on Crusoe."

## Likely judge questions

- **Is the scenario too easy? Who writes the verifier for a new target?** Yes, the fault is seeded and the verifier is written per target. That is the design: the model proposes and code decides. The check kinds are a reusable vocabulary; a new target needs an adapter (tools, receipts, reference output rules), not new agent logic. We run two target profiles with the same controller.
- **Isn't this Temporal or LangGraph?** Those make workflow code durable. Blackout makes the goal accountable: a frozen definition of done, a verifier the agent cannot influence, and reconciliation of external side effects from the target's own receipts. It could run on top of Temporal.
- **Exactly-once?** No general claim. No duplicate side effects were observed in journal mode, enforced by op IDs written before each effect, receipt reconciliation, and the target's op ID idempotency.
- **What if the target has no receipts?** The action's outcome is marked unknown and the mission escalates. It never retries blindly. Tested.
- **Why not let an LLM verify?** That is the failure we are fixing. In our first live run Nemotron fixed the service but the coordinator's own extra check could not pass; Blackout escalated instead of declaring success.
- **What does it cost?** Measured from the API's usage counts times list prices: about $0.006 per mission, roughly 30 calls.
- **What was built today?** Everything in the repo. Reused: OpenAI SDK, Zod, tsx, TypeScript, Node's SQLite.
