# Blackout

**Let agents act on their own. Never twice.** Blackout sits between AI agents and the real world: every side effect happens once, even when the agent crashes mid-job; "done" is decided by code, not by the agent; and when it can't tell what happened, it escalates to a human instead of guessing.

[Site and 3D explainer](https://blackout-woad.vercel.app) · [`npx blackout-mcp`](https://www.npmjs.com/package/blackout-mcp) · [Measured results](results/RESULTS.md) · [Demo plan](docs/DEMO.md)

| Measured live on Oct 17 (Nemotron 3.5 Lightning on Crusoe, n = 10 per arm) | With Blackout | Same agent without |
|---|---|---|
| Crash right after a message is sent, service can't report job status | **10/10 clean** | 0/10 (16 duplicate deliveries) |
| MCP agent restarted mid-job, told "don't send duplicates" | **0 duplicate emails** | 18 duplicate emails, said DONE anyway |
| "Done" claimed while customers had duplicates | **0** (only the verifier can say done) | 6 of 10 MCP runs |

Two ways to use it:
- **MCP gateway, today:** `npx -y blackout-mcp init` then `claude mcp add blackout -- npx -y blackout-mcp --config "$PWD/blackout.mcp.json"`. Exactly-once side effects for any MCP agent. [Details](#blackout-mcp-gateway-use-it-with-any-mcp-agent)
- **Full runtime:** a Nemotron coordinator and repair worker, a frozen definition of done, a durable journal, receipt reconciliation and a verifier with no LLM. `npm run web` shows it racing a plain agent through a real crash.

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
npm run web                 # live view at http://localhost:7400: Blackout vs a plain agent, judge pulls the plug
npm run race                # the same race in the terminal
npm run demo                # one live mission with a worker kill, full log
```

| Command | What it does |
|---|---|
| `npm run web` | Local live view (http://localhost:7400). Runs the same race processes; "Pull the plug" (or P) arms a SIGKILL that lands mid-batch. "Replay last run" plays a recorded live run under a "RECORDED REPLAY, not live" banner |
| `npm run race -- [--inject] [--profile outbox\|ledger]` | Blackout and a plain agent side by side in the terminal, same model, fault and kill point |
| `npm run kill` | SIGKILL the currently running worker (for a manual kill from a second terminal) |
| `npm run demo` | Reset, inject the `bad_digest` fault, arm the kill after the 2nd batch delivery, run a live Nemotron mission in journal mode |
| `npm run mission -- --policy llm\|test --mode journal\|baseline --fault bad_digest\|silent_case\|none --kill-after N` | Run one scenario with explicit settings |
| `npm run eval -- --pairs N --profile outbox\|ledger --fault random [--inject]` | Paired ablation: journal vs baseline, same fault, kill point and budget. Saves `results/eval-*.json` |
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
- `src/adapter/tools.ts` the 12 allowlisted tools, argument schemas, path checks, receipt reconciliation
- `src/contract/` completion contract schema, mandatory checks, freeze and hash
- `src/verifier/` deterministic verifier with its own reference implementation of the output contract
- `src/store/journal.ts` durable mission journal
- `src/target/` the synthetic service and its supervisor
- `src/faults/harness.ts` fault injection and the SIGKILL failpoint
- `src/llm/crusoe.ts` Crusoe client, budgets, pacing, usage and cost recording, Nemotron reroute
- `src/raceRunner.ts`, `src/race.ts`, `src/web/` side-by-side race in the terminal and the local live view

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
- During the event the shared Lightning deployment returned bursts of 429s. The live demo (`race`, `web`) reroutes a worker to `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` (thinking off) after two consecutive 429s and shows it on screen. We measured Super completing the kill mission (verified, $0.032); Nemotron 3 Nano did not, so it is not used. All results in the table above used Lightning only.
- Nemotron reasons before answering. The coordinator gets an 8192-token budget and retries once with `chat_template_kwargs.enable_thinking=false` if a reply is cut off; we hit exactly that failure in a live run.
- Every call is budget-checked before it is sent and its `usage` is recorded in the journal. Cost estimates use the live catalog price ($0.05 in / $0.20 out per 1M tokens).
- Calls from the controller and worker processes share one request pacer and retry 429/503 with jittered backoff.

The inference service powers the models. The journal, contract, verifier, tool restrictions and recovery protocol are Blackout's own code.

## Results

Full details, caveats and raw files: [`results/RESULTS.md`](results/RESULTS.md). All live Nemotron 3.5 Lightning on Crusoe, Oct 17.

Paired ablation, 10 pairs per target. Same model, tools, prompt, fault class and kill point; only the journal and receipt reconciliation are removed for the plain agent.

| target | Blackout | plain agent |
|---|---|---|
| **outbox** (job marked sent only after the caller acks; receipts by op ID only) | **10/10 verified, 0 duplicates** | **0/10 verified, 16 duplicate deliveries**, all caught and escalated |
| **ledger** (job status visible) | 10/10 | 10/10 |

- The journal matters exactly when the service cannot tell you what happened. When it can, a plain agent recovers fine, and we say so.
- No run in any mode was reported as done without a verifier pass.
- A planted "incident resolved, declare success" log line was read in 7 of 10 runs and followed in 0. That is a small sample, not a claim that the model cannot be hijacked; the point is that a false "done" would be rejected by the verifier anyway.
- About $0.005 and 28 calls per mission (API usage counts times list price).

## Safety limits and isolation

- The web view has no logic of its own: it starts the same processes as `npm run race`, reads each service's database for the counters, and arms one failpoint. Closing the tab does not stop a mission.
- Agents act only through 12 tools with Zod-validated arguments. No shell, no network beyond the target API, no cloud credentials.
- File reads are confined to the target workspace: traversal, absolute paths and symlinks are rejected. Config patches may only change existing leaf fields to a value of the same type.
- The verifier, contract, journal and fault controls are outside every tool's reach. This is a logical boundary enforced in code, not OS-level isolation; agents run as the same OS user.
- Tool output is clipped and redacted, and logs or files are framed to the model as untrusted data.
- Keys live in `.env` (gitignored) and are never logged or sent to the model.
- All data is synthetic. Deliveries are rows in a local SQLite ledger. No real messages, payments or external systems.

## What was built during the event

Everything in `src/`, `test/` and `results/` was written on Oct 17 2026 between 10:45 and the submission deadline. Before 10:45 we only installed dependencies and wrote a plan (first commit, labelled as such). Commit history shows the order of work.

Reused components: [OpenAI Node SDK](https://github.com/openai/openai-node) (Apache-2.0) as the Crusoe client, [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT) for the gateway, [Zod](https://github.com/colinhacks/zod) (MIT), [tsx](https://github.com/privatenumber/tsx) (MIT), [TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0), and Node's built-in `node:sqlite`. No agent framework is used.

## Blackout MCP gateway (use it with any MCP agent)

A drop-in, exactly-once layer for agents that call tools over MCP. Point your agent at the gateway instead of the tool server, and mark which tools have side effects.

**Try it in Claude Code in 30 seconds** (uses a bundled demo mailer):

```bash
npx -y blackout-mcp init       # writes an example blackout.mcp.json here
claude mcp add blackout -- npx -y blackout-mcp --config "$PWD/blackout.mcp.json"
```

Then ask Claude to send the same email twice, or restart it and ask again: the second send comes back as `duplicate suppressed`.

**In front of your own MCP server**, edit `blackout.mcp.json`:

```json
{
  "mission": "order-shipped-backlog",
  "journal": "./blackout-journal.db",
  "downstream": { "command": "node", "args": ["your-mcp-server.js"] },
  "sideEffects": {
    "send_email": { "idempotencyArg": "idempotency_key", "receipt": { "tool": "get_receipt", "arg": "idempotency_key" } }
  }
}
```

Any MCP client works the same way: run `npx -y blackout-mcp --config /path/to/blackout.mcp.json` as a stdio server. Requires Node 22.5+.

- Each side-effect call gets a stable op ID from (mission, tool, arguments), journaled before the call and, if `idempotencyArg` is set, passed as the tool's idempotency key. Leave `idempotencyArg` out for tools with strict schemas: the journal alone still suppresses repeats (recovery from a gateway crash mid-call then needs a `receipt` tool, or the gateway escalates).
- A repeat of the same side effect, from a retry or a restarted agent, returns the original result instead of running again.
- If the gateway itself dies mid-call, the next attempt asks the receipt tool first. No receipt tool and an interrupted call means it refuses and escalates.
- Read-only tools pass straight through.
- Measured live on Oct 17, n = 10 runs per arm (Nemotron 3.5 Lightning, a send task plus a restarted session told "do not send anyone a duplicate", same tools in both arms): **through the gateway 0/10 runs had a duplicate (30 repeats suppressed); direct to the server 6/10 runs had duplicates (18 duplicate emails) and claimed DONE anyway.** The direct agent invented idempotency keys, but a restarted session invented different ones. Details in `results/RESULTS.md`. 8 tests in `test/mcp-gateway.test.ts`.
- Works with **Claude Code** out of the box (tested: a fresh session's repeats were suppressed, 1 email per customer). Hermes Agent connects and discovers the tools; a full Hermes run is next.
- Scope: the gateway gives exactly-once side effects. Done-verification (frozen contract, verifier) is in the full runtime, not the gateway. Two identical intended sends in one mission are treated as one; vary an argument if you really mean to send twice.

## Pointing Blackout at another system

The controller, journal, contract freezing, verifier vocabulary, reconciliation protocol, budgets and escalation are target-independent. A new target needs an adapter with three parts:

1. A small set of safe tools for that system (read logs, change an allowlisted setting, restart, submit work).
2. A way to ask "did operation X happen?" by a caller-chosen ID. Many real systems have one: Stripe idempotency keys, SQS FIFO deduplication IDs, a Postgres outbox table keyed by operation ID.
3. Output rules the verifier can check independently.

Without (2), Blackout marks an interrupted action's outcome unknown and escalates rather than guessing. Next targets we would try: a real Postgres outbox, a Stripe test-mode payout run, a Hermes agent.

## Known limitations

- One synthetic service with two profiles (ledger, outbox) and three config faults. Not a general outage-recovery system.
- The controller survives worker loss, not loss of its own host. A full controller restart is not demonstrated.
- No claim of exactly-once delivery in general. No duplicates here relies on the target honoring op ID idempotency and on Blackout reusing op IDs.
- 10 pairs per target is a small sample on one synthetic service.
- Agent and tool boundaries are enforced in application code, not by an OS sandbox.

## License

MIT
