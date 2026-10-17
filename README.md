# Blackout

Blackout keeps a recovery mission accountable to verified outcomes while the workers doing the repair can fail and be replaced.

Built at the Recursive Agents Hackathon (San Francisco, Oct 17 2026) for the **Done Means Done** problem statement. All agent inference runs on **NVIDIA Nemotron 3.5 Lightning** through **Crusoe Managed Inference**.

> Goal given to Blackout: *"Get this service working again, finish its pending jobs, and do not duplicate anything."*

The demo service says it is healthy while every job fails. A Nemotron coordinator writes a definition of done and freezes it. A Nemotron repair worker diagnoses and fixes the fault using only allowlisted tools. Partway through the batch, a test harness SIGKILLs the worker right after the service commits a delivery and before the worker can acknowledge it. A replacement worker reconciles what actually happened from the service's own receipts and finishes only the remaining work. Plain code, not a model, decides when the mission is done.

## Quick start

Requirements: Node 22+ (uses the built-in `node:sqlite`), npm, macOS or Linux. No Docker.

```bash
npm install
cp .env.example .env        # then set CRUSOE_API_KEY
npm test                    # 18 tests, no inference needed
npm run smoke               # one catalog call + one tiny tool call to Crusoe
npm run demo                # the full live mission with a worker kill
```

| Command | What it does |
|---|---|
| `npm run demo` | Reset, inject the `bad_digest` fault, arm the kill after the 2nd batch delivery, run a live Nemotron mission in journal mode |
| `npm run mission -- --policy llm\|test --mode journal\|baseline --fault bad_digest\|silent_case\|none --kill-after N` | Run one scenario with explicit settings |
| `npm run eval -- --pairs N` | Paired ablation: journal vs baseline, same fault, kill point and budget. Saves `results/eval-*.json` |
| `npm run verify` | Run the deterministic verifier against the current target state |
| `npm run reset` | Rebuild the target, journal and harness state |
| `npm run fault -- bad_digest\|silent_case\|arm-kill N\|disarm` | Manual fault controls |
| `npm test` | Unit and end-to-end tests |

`--policy test` runs a **deterministic test policy** that hard-codes the known fix. It exists only to exercise the kill and reconcile path without inference, and is labelled as such in all output. It is never the showcased repair.

## Architecture

```
 Blackout control plane (separate process, outside the target)        Target service (own process)
 ┌───────────────────────────────────────────────┐                  ┌──────────────────────────┐
 │ Coordinator (Nemotron)   Controller            │   spawns        │ docprint HTTP API        │
 │  writes contract,         budgets, progress,   │ ─────────────►  │  /health always 200      │
 │  continue/replan/escalate worker generations   │  ┌───────────┐  │  /jobs/:id/process op_id │
 │ Frozen contract (hashed)  Mission journal      │  │ Repair    │  │ Service DB: jobs,        │
 │                           (SQLite: intents,    │◄─┤ worker    ├─►│  ledger, receipts        │
 │                            op IDs, usage)      │  │ (Nemotron)│  │ Workspace: config.json,  │
 │ Verifier (plain code, reads target DB r/o)  ───┼──┼───────────┼─►│  SERVICE.md              │
 └───────────────────────────────────────────────┘  └─────▲─────┘  └────────────┬─────────────┘
                                                     SIGKILL│   Fault harness  ◄──┘ failpoint after commit
                                                            └── (hidden from agents)
```

- `src/controller/` mission loop, coordinator prompts, progress rules (`control.ts`)
- `src/worker/` killable worker process and its policies (`llm`, labelled `test`)
- `src/adapter/tools.ts` the 11 allowlisted tools, argument schemas, path checks, receipt reconciliation
- `src/contract/` completion contract schema, mandatory checks, freeze and hash
- `src/verifier/` deterministic verifier with its own reference implementation of the output contract
- `src/store/journal.ts` durable mission journal
- `src/target/` the synthetic service and its supervisor
- `src/faults/harness.ts` fault injection and the SIGKILL failpoint
- `src/llm/crusoe.ts` Crusoe client, budgets, pacing, usage and cost recording

### How a mission runs

1. The coordinator sees the goal and the observed scope (10 batch jobs, 3 already delivered) and proposes checks from a fixed vocabulary. It cannot write checker code.
2. Blackout adds the target's mandatory checks, rejects proposals that are unsupported or false by construction, hashes the contract and stores it read-only outside every agent-writable path.
3. The verifier runs once before repair to record the starting state.
4. The controller starts worker generation 1. Before each side effect the worker records intent with a stable op ID in the journal.
5. If the worker dies, the controller fences that generation and starts the next one. In journal mode the new worker first queries the target's receipt for every unacknowledged op ID and marks each one done, absent, or unknown. Unknown outcomes are never retried; the mission escalates.
6. After each episode the verifier runs. Only a verifier pass ends the mission as done. A worker's or coordinator's claim of success is ignored if the verifier disagrees.
7. If the progress vector (valid jobs, duplicates, failing mandatory checks) does not change, the controller forces a replan, then escalates. Turn, call, token, time and dollar limits also end in escalation.

### Completion contract

Mandatory checks for this target, always present:

- `fresh_job_e2e`: a new test job submitted through the public API completes with a correct payload
- `all_scope_jobs_valid_output`: every scoped job has a delivery whose payload matches the documented output contract
- `no_duplicate_deliveries`: no scoped job has more than one committed delivery
- `preexisting_outputs_intact`: deliveries that existed before the mission are unchanged
- `no_unaccounted_work`: every scoped job is done and has a receipt

The model may add `health_ok`, `no_errors_since_boot`, or `expected_scope_size`. Health is reported as liveness only and never counts as proof on its own.

## Supported fault scope

| Fault | Symptom | What fixes it |
|---|---|---|
| `bad_digest` (demo) | `/health` 200, every job returns 500, logs say `Digest method not supported` | Find the bad `fingerprint.algorithm` value, patch it, restart. A restart alone does not fix it |
| `silent_case` | Jobs succeed but payloads are wrong (case normalization off) | Only payload verification catches it |
| Worker SIGKILL after a committed delivery | Last action has intent but no acknowledgement | Receipt reconciliation, then continue |

Anything else is out of scope. Unsupported or uncertain outcomes end in an evidence-backed escalation.

## Crusoe and Nemotron

- Model: `nvidia/Nemotron-3.5-Lightning-30B-A3B` for both the coordinator and the worker. No other model is used in any reported run.
- Chosen over Nemotron 3 Super after a short measured comparison on this org's account: Lightning completed multi-turn tool missions in fewer turns, 2 to 3 times faster, at about 1/12 the output price.
- Native OpenAI-style tool calling (`tools`, `tool_choice: auto`). A JSON-envelope fallback exists but was not needed in the reported runs.
- Nemotron reasons before answering. The coordinator gets an 8192-token budget and retries once with `chat_template_kwargs.enable_thinking=false` if a reply is cut off; we hit exactly that failure in a live run.
- Every call is budget-checked before it is sent and its `usage` is recorded in the journal. Cost estimates use the live catalog price ($0.05 in / $0.20 out per 1M tokens).
- Calls from the controller and worker processes share one request pacer and retry 429/503 with jittered backoff.

The inference service powers the models. The journal, contract, verifier, tool restrictions and recovery protocol are Blackout's own code.

## Results

See [`results/RESULTS.md`](results/RESULTS.md). Summary of live runs on Oct 17:

- Demo mission: verified 10/10, 0 duplicates, 1 real SIGKILL, 31 calls, about $0.006, 16 s from crash to verified.
- Paired ablation, n = 3 pairs: journal 3/3 verified with 0 duplicates; baseline 2/3, one run committed a duplicate and was escalated. No false success claims in either mode. Small sample, no statistical claim, caveats in the results file.

## Safety limits and isolation

- Agents act only through 11 tools with Zod-validated arguments. No shell, no network beyond the target API, no cloud credentials.
- File reads are confined to the target workspace: traversal, absolute paths and symlinks are rejected. Config patches may only change existing leaf fields to a value of the same type.
- The verifier, contract, journal and fault controls are outside every tool's reach. This is a logical boundary enforced in code, not OS-level isolation; agents run as the same OS user.
- Tool output is clipped and redacted, and logs or files are framed to the model as untrusted data.
- Keys live in `.env` (gitignored) and are never logged or sent to the model.
- All data is synthetic. Deliveries are rows in a local SQLite ledger. No real messages, payments or external systems.

## What was built during the event

Everything in `src/`, `test/` and `results/` was written on Oct 17 2026 between 10:45 and the submission deadline. Before 10:45 we only installed dependencies and wrote a plan (first commit, labelled as such). Commit history shows the order of work.

Reused components: [OpenAI Node SDK](https://github.com/openai/openai-node) (Apache-2.0) as the Crusoe client, [Zod](https://github.com/colinhacks/zod) (MIT), [tsx](https://github.com/privatenumber/tsx) (MIT), [TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0), and Node's built-in `node:sqlite`. No agent framework is used.

## Known limitations

- One synthetic target and two fault types. Not a general outage-recovery system.
- The controller survives worker loss, not loss of its own host. A full controller restart is not demonstrated.
- No claim of exactly-once delivery in general. No duplicates here relies on the target honoring op ID idempotency and on Blackout reusing op IDs.
- The ablation is 3 pairs. On this target, job status is visible, so the baseline also recovered from the crash; the measured difference came from a model retry.
- Agent and tool boundaries are enforced in application code, not by an OS sandbox.

## License

MIT
