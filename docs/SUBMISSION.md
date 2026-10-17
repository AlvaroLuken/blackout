# Submission checklist (deadline 5:00pm PT, aim 4:45pm)

Each external step needs Alvaro's approval.

- [ ] `git log` shows only today's work after the pre-event setup commit
- [ ] `git grep -nI "CRUSOE_API_KEY=" -- . ':!.env.example'` returns nothing; `.env` is untracked
- [ ] `npm test` passes on a clean checkout (`git clone` to a temp dir, `npm ci`, `npm test`)
- [ ] README results match `results/RESULTS.md`
- [ ] Create the public GitHub repo and push (approval)
- [ ] Open the repo in a private window and confirm it is public
- [ ] Record the one-minute video (script in `docs/DEMO.md`)
- [ ] Upload the video, confirm the link plays in a private window (approval)
- [ ] Fill the form at https://cerebralvalley.ai/e/crusoe-recursive-agents-hackathon/hackathon/submit (approval)
  - Problem statement: Done Means Done
  - Mention: Nemotron 3.5 Lightning on Crusoe for both agents
  - State clearly what was built during the event
- [ ] Solo entry: no teammates to add
