# Submission checklist (deadline 5:00pm PT, aim 4:45pm)

Each external step needs Alvaro's approval.

- [x] Public repo: https://github.com/AlvaroLuken/blackout (created 12:07pm, verified public without login)
- [x] Secret scan of full git history: no key or token values present; `.env` untracked
- [ ] Final push after feature freeze
- [ ] `npm test` passes on a clean clone (`git clone` to a temp dir, `npm ci`, `npm test`)
- [ ] README results match `results/RESULTS.md`
- [ ] Record the one-minute video on Loom (script in `docs/DEMO.md`), confirm the link plays logged out
- [ ] Confirm with organizers whether the form's "Best Use of Nemoclaw?" question means Nemotron
- [ ] Fill and submit the form (approval)

## Draft form answers

**Team Name**
Blackout

**Team Members**
Alvaro Luken (solo)

**Project Description**
Blackout is an autonomous recovery team that keeps a mission accountable to verified outcomes, even when the agent doing the work is killed halfway through. Give it a goal like "get this service working again, finish its pending jobs, and do not duplicate anything." A Nemotron coordinator turns that into a definition of done, which Blackout freezes with a hash before any repair. A Nemotron repair worker, running as its own process, diagnoses the fault using only allowlisted tools: the service reports healthy while every job fails because of a bad config value. It fixes the fault and starts delivering jobs. Our test harness then SIGKILLs the worker right after a delivery commits, before the worker can record it. The replacement worker reconciles the in-flight operation from the service's own receipts and finishes only the remaining work. A deterministic verifier, plain code rather than a model, checks every output in the real database. Only a verifier pass ends the mission as done; agent claims of success are ignored. In live runs on Crusoe each mission cost about $0.006. We ran a paired ablation with the journal and reconciliation turned off, and every result is reported in the repo, including the failures. Everything in the repo was built during the event.

**Public GitHub Repository**
https://github.com/AlvaroLuken/blackout

**Public Demo Video**
(Loom link, to add)

**Problem statement**
Done Means Done

**Best Use of Nemoclaw?**
Ask an organizer first. If it means Nemotron: Yes. If it really means NemoClaw: No.

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
