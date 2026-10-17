# Submission checklist (deadline 5:00pm PT, aim 4:45pm)

Each external step needs Alvaro's approval.

- [x] Public repo: https://github.com/AlvaroLuken/blackout (created 12:07pm, verified public without login)
- [x] Secret scan of full git history: no key or token values present; `.env` untracked
- [ ] Final push after feature freeze
- [ ] `npm test` passes on a clean clone (`git clone` to a temp dir, `npm ci`, `npm test`)
- [ ] README results match `results/RESULTS.md`
- [ ] Record the one-minute video on Loom (script in `docs/DEMO.md`), confirm the link plays logged out
- [x] Form has separate questions: Best Use of Nemotron (Yes) and NemoClaw & OpenShell (No)
- [ ] Fill and submit the form (approval)

## Draft form answers

**Team Name**
Blackout

**Team Members**
Alvaro Luken (solo)

**Project Description**
Blackout lets AI agents act on their own without doing anything twice. Agents are starting to send emails, issue refunds and change systems unattended; when one crashes mid-job it re-does work it already did, and it says "done" when it isn't. Blackout sits between the agent and the real world: it writes every side effect down with a stable ID before it happens, asks the outside system's receipts what really happened after a crash, and lets only plain code (never the model) decide the job is done. When it can't tell, it escalates to a human.

We built it two ways today. The full runtime: a Nemotron coordinator writes and freezes a definition of done, a Nemotron repair worker diagnoses and fixes a broken service, we SIGKILL it mid-delivery, and its replacement reconciles from receipts. In 10 paired live runs on a service that can't report job status, Blackout finished cleanly 10/10; the same agent without it 0/10 (16 duplicate deliveries). And a drop-in MCP gateway, published on npm as blackout-mcp, that any MCP agent (including Claude Code) can put in front of its tools. Measured: a Nemotron agent told not to send duplicates, restarted mid-job, duplicated emails in 6 of 10 runs because it re-invented its idempotency key each time; through Blackout, 0 of 10.

All agents run on NVIDIA Nemotron 3.5 Lightning via Crusoe Managed Inference, about half a cent per mission. Site with a 3D explainer and recorded live race: https://blackout-woad.vercel.app. Everything in the repo was built during the event.

**Public GitHub Repository**
https://github.com/AlvaroLuken/blackout

**Public Demo Video**
(Loom link, to add)

**Problem statement**
Done Means Done

**Are you submitting for NVIDIA's Best Use of Nemotron?**
Yes (confirmed the form has separate Nemotron and NemoClaw questions)

**Best Use of NemoClaw & OpenShell?**
No (we did not use NemoClaw or OpenShell)

**Did you use NVIDIA tools?**
Check it (NVIDIA Nemotron 3.5 Lightning powers both agents)

**Did you use You.com tools?**
Leave unchecked

**Describe your use of Crusoe Managed Inference**
All of Blackout's runtime inference runs on Crusoe Managed Inference through its OpenAI-compatible endpoint, using nvidia/Nemotron-3.5-Lightning-30B-A3B for both the coordinator and the repair worker. Nemotron writes the completion contract, chooses every diagnostic and repair tool call (native tool calling), interprets failed verifier checks, and decides whether to continue, replan, or escalate. We picked Lightning over Nemotron 3 Super after measuring both on our account: Lightning finished multi-turn tool missions in fewer turns, 2 to 3 times faster, at about 1/12 the output price. Every call is budget-checked before sending, and its usage (including cached tokens) is recorded in our journal, so each mission reports its measured cost: about 30 calls and $0.006. The controller and worker processes share one request pacer with jittered backoff for 429 and 503 responses.

**Feedback on Crusoe products**
Fast, cheap, and the OpenAI compatibility meant zero glue code. Native tool calling on Nemotron 3.5 Lightning worked first try. Friction points: model IDs are case-sensitive and differ from the names in some docs (we first used a lowercase ID that would have 404'd), and the docs list 1M context while the live catalog shows 262k. Reasoning output can use up max_tokens before any answer appears (finish_reason "length" with empty content); a note recommending a larger budget or enable_thinking=false for structured replies would save time. Short bursts can return 429 "max_requests_limit (orchestrator)" even well under the per-minute limit; documenting the burst window would help. The models endpoint is excellent: supported_parameters and pricing are exactly what an agent builder needs.

**Feedback on partner products**
Nemotron 3.5 Lightning was a strong fit for agent sub-tasks: reliable single tool calls per turn, no argument parse failures across our runs, and low latency. Its default reasoning is useful, but structured JSON replies sometimes arrived inside code fences, so we strip them. We looked at NemoClaw, OpenShell, Blueprints and Switchyard; OpenShell looks promising for sandboxing a repair worker, but it needs Docker, which we could not set up within the build window.
