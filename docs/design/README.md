# `design/` — design & planning docs

Forward-looking docs for features that are **being designed or built** — the thinking, scope, and
next steps before/while the code lands. Once a feature is shipped and stable, its lasting reference
moves to `platform/` (backend) or `setup/`; this folder is for work in motion.

| File | What it is |
|---|---|
| **jd-to-1000-prospects.md** | Design for the "JD → 1,000 prospects" sourcing flow — how a job description fans out into a large ranked prospect set. |
| **bd-engine-next-steps.md** | The BD Engine backend direction — audit decisions and the next build steps (email engine, KV→SQL migration, etc.). |
| **linkedin-voice-notes-safeguards.md** | Safety parameters for sending cloned-voice notes on LinkedIn via Unipile — daily caps, pacing, eligibility gates, and the quality-throttle that actually prevents bans. Read before wiring any auto-send loop. |
