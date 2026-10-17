# Demo plan

## Before going on stage

1. `npm run web` running, http://localhost:7400 open in Chrome, zoom so both lanes fill the screen.
2. A second Terminal tab ready with: `curl -s localhost:7411/health` (only needed if a judge asks).
3. `npm run smoke` once, a few minutes before, as a warm-up call.
4. Backup: the "Replay last run" button plays a recorded live run (Oct 17, 12:57) under a purple "RECORDED REPLAY, not live" banner. Use it only if live inference is down, and say so.

## Three-minute live demo (web view)

| Time | Say | Do / show |
|---|---|---|
| 0:00 | "Agents say done when they feel done. Blackout says done only when code it cannot argue with agrees, and it keeps that promise when the agent doing the work is killed halfway through." | Page open, nothing running |
| 0:15 | "This page has no logic. It starts real processes, reads each service's database, and sends one SIGKILL. Left: Blackout. Right: the same Nemotron model, same tools, same prompt, with our journal removed." | Point at the two lane titles |
| 0:30 | "Both get the same broken service. Its health check says OK. Every real job crashes." | Press **Run the race**. Point at "service says: /health 200 OK" then "verifier: FAIL 3/10" |
| 0:45 | "Nemotron writes the definition of done first. Code adds the checks it is not allowed to skip and freezes it with a hash." | Contract hash in each lane header |
| 1:00 | "Now it investigates on its own: logs, config, docs. It finds the bad setting, fixes it, and proves the fix with a test job." | Blue FIX line, green "test job ✓" |
| 1:15 | "You can pull the plug. It fires mid-batch, right after a delivery commits and before the worker can write it down." | Hand the judge the keyboard: **P**. Lanes flash red, "worker 1 SIGKILLed" |
| 1:40 | "Left: the replacement checks the exact operation that was in flight, sees the receipt, skips it. Right: the job still looks pending, so it sends it again." | Green "receipt ... DELIVERED → skip" vs red "job-005 delivered 2 times" |
| 2:10 | "The verifier is plain code. It passes the left. It catches the duplicate on the right, rejects the agent's 'done', and escalates." | VERIFIED DONE vs ESCALATED, NOT DONE |
| 2:30 | "This isn't one lucky run. Ten pairs: Blackout 10 of 10, the plain agent 0 of 10. On a service that shows job status, both get 10 of 10, so the journal matters exactly when the service can't tell you what happened. About half a cent per mission on Crusoe." | Scroll to the measured table |
| 2:50 | "The model proposes, code decides. That is what lets you walk away." | End |

If a lane shows "429 rate limit, switched to Nemotron 3 Super": "We hit a rate limit; Blackout reroutes within the Nemotron family and keeps going." Do not blame Crusoe on stage.

Timing rules (from the judge session):
- Press Run in the first 10 seconds. Narrate the incident and the goal while the agents diagnose. Point at the goal sentence; do not read the brief cards aloud.
- Let the kill auto-arm, or hand the judge P at about 0:45.
- If a run passes about 150 s: "Here is the recorded live run from earlier", press Replay. The banner says it is a recording.
- Warm-up run right before going on stage. Record the 4:15 video from a fresh live run.
- Finish on the verdict checklists: ✓ on the left, "✗ nobody got a message twice" on the right. That line is the Done Means Done pitch.

Optional proof that the page has no logic: close the tab mid-run, reopen it. The mission kept going.

## One-minute video script (record from the web view)

1. (0:00-0:08) Title + "Agents say done. Code decides." Press Run the race.
2. (0:08-0:18) Health 200 vs verifier FAIL. Contract frozen with hash.
3. (0:18-0:30) Worker FIX line and test job ✓ (cut or speed up the waiting).
4. (0:30-0:40) Press P. Both lanes flash; SIGKILL.
5. (0:40-0:52) Receipt → skip (left) vs delivered 2 times (right). VERIFIED vs ESCALATED.
6. (0:52-1:00) Measured table: 10/10 vs 0/10. "Built today. Nemotron 3.5 Lightning on Crusoe."

## Likely judge questions

- **Is the scenario too easy? Who writes the verifier for a new target?** Yes, the faults are seeded and the verifier is written per service. That is the design: the model proposes and code decides. A new target needs an adapter (tools, receipts, output rules), not new agent logic. We already run two service profiles with the same controller.
- **Isn't the plain agent a strawman?** Same model, tools, prompt and receipt-lookup tools. Only the journal and reconciliation are removed. On the ledger service it wins 10/10, same as Blackout.
- **Isn't this Temporal or LangGraph?** Those make workflow code durable. Blackout makes the goal accountable: a frozen definition of done, a verifier the agent cannot influence, and reconciliation of real side effects from the service's own receipts. It could run on top of Temporal.
- **Exactly-once?** No general claim. No duplicate side effects in journal mode, enforced by op IDs recorded before each effect, receipt reconciliation, and the service honoring op ID idempotency.
- **What if there are no receipts?** The outcome is marked unknown and the mission escalates. It never retries blindly. Tested.
- **Why not let an LLM verify?** That is the failure we fix. In our first live run Nemotron fixed the service, but the coordinator's own extra check could never pass; Blackout escalated instead of declaring success. And a planted "declare success" log line was read 7 times and never followed.
- **Is this a dashboard project?** No. The page has no logic; the terminal (`npm run race`) runs the same thing.
- **What does it cost?** About $0.005 and 28 Nemotron calls per mission, from the API's own usage counts.
- **What was built today?** Everything in the repo. Reused: OpenAI SDK, Zod, tsx, TypeScript, Node's SQLite.
