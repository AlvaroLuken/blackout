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

## One-minute video script (record at 4:15 from a fresh live run, Presenter view on)

Before recording: restart `npm run web`, press **Warm up**, turn on **Presenter view** (V). Record the screen plus your voice in Loom. If the live run is slow, record the live run anyway and speed up the waiting in Loom's editor; say "sped up".

| Time | Show | Say |
|---|---|---|
| 0:00 | Page title, press **Run the race** | "Built today at the Recursive Agents Hackathon: Blackout. Agents say done. Code decides." |
| 0:05 | Both lanes: "/health 200 OK" then "verifier: FAIL 3/10" | "The service says it's healthy. Every real message is failing." |
| 0:12 | FIX line, test job ✓ | "Nemotron on Crusoe finds the bad setting and fixes it, in both lanes." |
| 0:20 | Press **P**; lanes flash; moment-of-truth cards | "We kill each worker right after it sends a message. Left, Blackout checks the receipt for that exact operation and skips it. Right, the same agent without Blackout sends it again." |
| 0:35 | Verdict bars: VERIFIED vs ESCALATED; click the red customer | "Plain code checks every inbox. Customer 5 got it twice on the right. That 'done' is rejected." |
| 0:45 | Scroll to the measured table | "Ten pairs: Blackout 10 of 10, the plain agent 0 of 10. About half a cent a mission." |
| 0:53 | Site "Use it today" or README gateway section | "And it ships today as an MCP gateway: npx blackout-mcp. Nemotron 3.5 Lightning runs every agent." |

## One-sentence answers

- **Who writes the verifier?** "Each target gets an adapter: tools, a 'did op X happen?' lookup, and output rules. The controller, journal and contract logic don't change; we run two service profiles and an MCP gateway on the same core."
- **Isn't this just idempotency keys?** "Keys are one piece. Blackout generates and journals them before the call, reconciles from receipts after a crash, escalates when it can't tell, and only accepts 'done' from a verifier against a frozen contract. They compose."
- **Why Nemotron?** "We measured: Nano made no progress, Super works and is our fallback, Lightning works and is the fastest and cheapest. Lightning runs every agent. At half a cent a mission, verifying everything is affordable." (Say this once in the live demo too.)
- **Couldn't the plain agent just check the receipts?** "It has the same receipt tool, but receipts are looked up by operation ID, and the ID died with the worker. Blackout writes the ID down before acting. Where receipts can be searched by customer, the plain agent recovers fine, 10 of 10, and we report that. A careful agent could do this; Blackout makes it guaranteed instead of hoped for. In 3 measured runs the plain agent re-sent the whole batch with the receipt tool right there."
- **What if Blackout itself goes down?** "It fails closed: dangerous actions go through it, so if it's down they don't happen. You get a stalled job, not a double refund. The journal survives process crashes, and after one Blackout checks receipts before retrying (tested in the gateway). The real gap today is losing the journal disk: it's a local SQLite file, and production would put it on replicated storage. The gateway's IDs are derived from the call itself, so a provider that honours idempotency keys still blocks the repeat even then."
- **How would you keep it running / could NemoClaw help?** "Keeping the gateway up is ordinary infrastructure: two instances and a shared, replicated journal. Where NVIDIA's OpenShell fits better is the other direction: run the agent inside an OpenShell sandbox whose network policy only allows reaching tools through Blackout. Then the agent can't bypass Blackout even if it tries. That's next, not built today."
- **Isn't the plain agent a strawman?** "Same model, tools, prompt and receipt-lookup tools. On the ledger service it scores 10 of 10, same as Blackout."
- **Exactly-once?** "Only where the system can answer 'did op X happen?'. Otherwise Blackout refuses and escalates. That refusal is tested."
- **What if the agent is tricked into saying done?** "We planted a fake 'resolved, declare success' note. Nemotron read it 7 times and never followed it, and if it had, the verifier would reject the claim."
- **Is this a dashboard project?** "No. The page has no logic; the same race runs in the terminal with `npm run race`."
- **What does it cost?** "About half a cent and 28 Nemotron calls per mission, from the API's own usage counts."
- **What was built today?** "Everything in the repo. Reused: the OpenAI SDK, the MCP SDK, Zod, tsx, TypeScript, Node's SQLite."
