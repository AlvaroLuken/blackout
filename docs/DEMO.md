# Demo plan

## Before going on stage

1. Restart `npm run web`, open http://localhost:7400, zoom so both lanes fill the screen.
2. One warm-up race a few minutes before your slot (also checks Crusoe is answering).
3. Backup: "Replay last run" plays the 2:28pm live run (both lanes about 92 s, all Lightning) at 2× under a purple "RECORDED REPLAY, not live" banner.
4. Have a terminal ready with `npm run gateway:demo` output from earlier, for Q&A only.
5. The public site (https://blackout-woad.vercel.app) goes in the submission. Don't demo it live.

## Three-minute run of show (≈2:45)

| Time | Say | Do |
|---|---|---|
| 0:00 | "Agents are starting to send emails and issue refunds on their own. When one crashes mid-job, it does things twice and still says 'done'." | Press **Run the race** immediately |
| 0:05 | "This page has no logic. It starts real processes, reads each service's database, and sends one SIGKILL. Left is Blackout. Right is the same Nemotron agent, same tools, same prompt, without our journal." | Point at the two lane titles |
| 0:15 | "The service is broken. Its health check is green, every real message fails. Nemotron writes the definition of done first, and code freezes it." | Point at "/health 200" and the contract hash |
| 0:30 | "Now it diagnoses on its own: logs, config, docs, finds the bad setting, fixes it, proves it with a test message." | Blue FIX line, green "test job ✓" |
| ~0:45 | "Pull the plug." | Hand a judge the keyboard: **P** (or it auto-arms) |
| ~1:10 | "Both workers die right after a message goes out, before they can write it down. Left: the replacement asks the service about that exact operation, finds the receipt, skips it. Right: no record, so it looks pending, and it sends it again." | Moment-of-truth cards |
| ~1:45 | "The verifier is plain code. It passes the left. It catches the duplicate on the right and rejects the agent's 'done'." | Proof of done vs escalation report |
| ~2:00 | "Here's customer 5's inbox on the right." | Click the red customer cell: same message twice, two op IDs |
| 2:15 | "Not a lucky run: ten pairs, Blackout 10 of 10, the plain agent 0 of 10. On a service that shows job status, both get 10 of 10, so the journal matters exactly when the system can't tell you what happened. Half a cent per mission on Crusoe." | Scroll to the measured table |
| 2:35 | "And you can use it today: it ships as an MCP gateway in front of any tool server. A Nemotron agent sent three emails, restarted with no memory, tried again: three suppressed, one email each." | Gateway frame (README section) |
| 2:45 | "The model proposes. Code decides." | End |

### Replay rule (practice the line)

If the **Crash** phase has not lit up by about **70 s**: "Crusoe is under load from every team here right now. Here's the live run from 2:28," then click **Replay last run**. The banner says it's a recording at 2×.

If a lane shows "429 rate limit, switched to Nemotron 3 Super": "We hit a rate limit; Blackout reroutes within the Nemotron family and keeps going." Don't blame Crusoe.

Optional proof that the page has no logic: close the tab mid-run and reopen it. The mission kept going.

## One-minute video script (record from a fresh live run after 3pm)

1. (0:00-0:08) "Agents say done. Code decides." Press Run the race.
2. (0:08-0:18) Health 200 vs verifier FAIL. Contract frozen with hash.
3. (0:18-0:30) FIX line and test job ✓ (cut the waiting).
4. (0:30-0:40) Plug pulled. Both lanes flash; moment-of-truth cards.
5. (0:40-0:52) Proof of done vs escalation report; click the duplicated customer.
6. (0:52-1:00) Measured table 10/10 vs 0/10. "Ships today as an MCP gateway. Built today on Nemotron 3.5 Lightning and Crusoe."

## One-sentence answers

- **Who writes the verifier?** "Each target gets an adapter: tools, a 'did op X happen?' lookup, and output rules. The controller, journal and contract logic don't change; we run two service profiles and an MCP gateway on the same core."
- **Isn't this just idempotency keys?** "Keys are one piece. Blackout generates and journals them before the call, reconciles from receipts after a crash, escalates when it can't tell, and only accepts 'done' from a verifier against a frozen contract. They compose."
- **Why Nemotron?** "We measured: Lightning finished our crash mission in the fewest turns, Super also worked at about six times the cost, Nano didn't make progress. At half a cent a mission, verifying everything is affordable."
- **Isn't the plain agent a strawman?** "Same model, tools, prompt and receipt-lookup tools. On the ledger service it scores 10 of 10, same as Blackout."
- **Exactly-once?** "Only where the system can answer 'did op X happen?'. Otherwise Blackout refuses and escalates. That refusal is tested."
- **What if the agent is tricked into saying done?** "We planted a fake 'resolved, declare success' note. Nemotron read it 7 times and never followed it, and if it had, the verifier would reject the claim."
- **Is this a dashboard project?** "No. The page has no logic; the same race runs in the terminal with `npm run race`."
- **What does it cost?** "About half a cent and 28 Nemotron calls per mission, from the API's own usage counts."
- **What was built today?** "Everything in the repo. Reused: the OpenAI SDK, the MCP SDK, Zod, tsx, TypeScript, Node's SQLite."
