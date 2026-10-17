# Blackout working plan

Track: Done Means Done. Mission: restore a broken job-processing service and finish its pending jobs without losing or duplicating work, even if a repair worker is SIGKILLed.

## Timeline (Pacific, Oct 17 2026)
- 09:05 pre-build: rules check, env check, repo init, deps installed. No feature code.
- 10:45 build starts.
- ~11:45 slice 1+2: target process, receipts, verifier, worker SIGKILL + receipt reconciliation (deterministic test policy, labelled).
- 13:00 one real Nemotron-driven diagnosis + repair passes the protected verifier.
- 15:00 live agent mission survives worker kill. Feature freeze.
- 16:15 record 1-min video, rehearse, package.
- 16:45 submit (deadline 17:00).

## Components (src/)
- `target/` separate HTTP process. Jobs in its own SQLite (`var/target.db`): `jobs`, `outputs(job_id UNIQUE)`, `receipts(op_id PRIMARY KEY)`. Config file `var/target/config.json` + worker module the repair agent may patch. Endpoints: /health, /submit, /process, /receipts/:op, /outputs, /diag/logs, /reset.
- `faults/` harness (not model-visible): breaks config in a false-green way, arms a kill failpoint after a target-side commit.
- `store/` mission journal (`var/mission.db`): mission, frozen contract, actions (op_id, intent, status), observations, progress, budget.
- `contract/` Zod schema. Allowlisted probe vocabulary. Adapter mandatory invariants merged in, cannot be removed. Frozen with hash.
- `verifier/` deterministic. Reads target DB and calls the public interface. No LLM.
- `agents/` coordinator (in controller process) + repair worker (child process, killable). Crusoe via OpenAI SDK. Tool calls validated with Zod; JSON-envelope fallback if native tools unreliable.
- `controller/` progress vector, no-progress detection, turn/token/USD/time limits, lease+generation for workers, reconciliation on worker death.

## Fault scope (supported)
- A. False green: /health 200, jobs fail (bad config field / worker regression). Restart does not fix.
- C. Worker SIGKILL after target commits op receipt, before ack to Blackout.
- B. No-progress: focused controller test.

## Blockers
- CRUSOE_API_KEY not present locally. Credit status and spend ceiling unconfirmed.
- Participant guide page did not render via fetch; kickoff updates unverified.

## Evaluation
- Ablation: same model/tools/contract/verifier/budget; baseline disables journal + auto reconciliation after worker crash. Report every run.
