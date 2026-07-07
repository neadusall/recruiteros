# Daily BD Operating Model — 20 minutes a day

One pipeline, in the same order as the nav: **Hire Signals → Clients → Send Queue → Email → Senders.**
The engine does the finding, naming, verifying, video-making, and staging on its own.
Your job is 5 checks a day. Everything else in the app is OFF the daily path.

---

## The golden path (what runs by itself)

```
free job-board pool (accumulator, hourly + 3-min inflow tick)
  → curation tick: decision-maker name + work email        (every ~4 min, background)
  → Reoon find + verify: emailValidated=true only           (REOON_API_KEY)
  → auto-enroll into the BD Bulk campaign                   (INMARKET_AUTOENROLL, capped, never sends)
  → auto-capture job posting + auto-video composite          (INMARKET_AUTOCAPTURE / AUTOVIDEO)
  → Send Queue autofill keeps a 3–5 day buffer staged        (UI toggle, populate-only)
  → Autopilot cadence sends Day-0 text + Day-1 video email   (AUTOMATION_ENABLED + campaign armed)
  → any reply pauses every sequence for that person          (response router)
```

Every stage is already built. It ships OFF; the one-time activation below turns it on.

## What is deliberately NOT in the daily flow

Do not use these day-to-day — they create a second, unsynced pipeline:

- **Manual search → picks → "Push to Email"** (localStorage queue — browser-local, no dedup vs the server path). Use targeted searches via the **batch queue** instead; results merge into the same pool the engine curates.
- **Manual approve/enroll clicking** — auto-enroll replaces the review gate; you QA after the fact (Step 3).
- **Prospects CSV imports, KoldInfo round-trip** — weekly levers at most, not daily.
- **Direct dial / voicemail drops / LinkedIn touches** — phase 2; layer on after email is humming.

---

## One-time activation (do once, in this order)

On the production box, in `.env.production` (each is confirmable before the next):

```bash
# 1. Verified emails only (Reoon does the SMTP check; port 25 is blocked on Hetzner)
REOON_API_KEY=<key>
INMARKET_REQUIRE_VALIDATED=1
REOON_FIND_BATCH=100                    # default 20 is the funnel bottleneck — raise it

# 2. Auto-enroll verified people into the BD Bulk campaign (populate-only, never sends)
INMARKET_AUTOENROLL=1
INMARKET_AUTOENROLL_WORKSPACE=<workspaceId>
INMARKET_AUTOENROLL_CAMPAIGN=<bd-bulk-campaignId>
INMARKET_AUTOENROLL_DAILY_CAP=3000      # match to video + inbox capacity, not the 5K dream

# 3. Auto assets (capture + video). Size targets to real video throughput (~2.5K/day/box)
INMARKET_AUTOCAPTURE=1
INMARKET_AUTOVIDEO=1
INMARKET_AUTOVIDEO_WORKSPACE=<workspaceId>
INMARKET_AUTOVIDEO_CLIP_ID=<recorded clip id from PiP Studio>
ROS_S3_ENDPOINT=... ROS_S3_BUCKET=... ROS_S3_KEY=... ROS_S3_SECRET=...   # R2

# 4. Send Queue buffer sized to reality (defaults are 4000/6000)
SEND_QUEUE_TARGET_MIN=2000
SEND_QUEUE_TARGET_MAX=3000

# 5. LAST — the master switch. Nothing sends until this is on AND a campaign is armed.
AUTOMATION_ENABLED=on
```

In the app (once):
1. **PiP Studio** — record the one webcam clip the videos composite over.
2. **Campaign Studio** — approve the BD Bulk model (LLM drafts it; you approve once; after that it's pure merge-fill, copy never drifts).
3. **Send Queue → campaign setup** — marks the campaign as the Send Queue campaign, retimes email 1 → Day 0 and email 2 (video) → Day 1, sets the recruiter. Turn **Autofill** on.
4. **Senders** — import the inbox CSV, assign inboxes to that recruiter. Hard cap is 2 cold/inbox/day, so **inbox count = daily send ceiling ÷ 2** (1,500 inboxes ≈ 3K/day).
5. Arm the campaign (Autopilot toggle = autoRun + active). `GET /api/send-queue` go-live readiness shows exactly which gate is still red.

---

## The daily loop — 5 steps, ~20 minutes

| # | Where | What you do | Time |
|---|---|---|---|
| 1 | **Send Queue** | Glance the dashboard: engine pills green, runway ≥ 3 days, shortfall 0. If "needs assets" is piling up, the video worker is behind — that's the only thing to investigate. | 3 min |
| 2 | **Replies** (Email/Conversations) | Answer positives, send booking links, book calls. The router already paused their sequences — this is the money step, give it the most time. | 7 min |
| 3 | **Clients** | Sort newest first, spot-check ~10 fresh contactable/enrolled rows: right person? right company? sane email? Suppress the bad ones. You're QA-ing the machine, not driving it. | 5 min |
| 4 | **Hire Signals → batch queue** | Only if net-new inflow looks thin or you want a specific vertical this week: enqueue 1–2 targeted searches and walk away — the runner scrapes, size-filters, and merges into the pool on its own. Most days: skip. | 3 min |
| 5 | **Senders** | Cold capacity remaining ≥ tomorrow's target; no bounce spikes or auto-paused domains. | 2 min |

Weekly (15 min, pick one): raise `REOON_FIND_BATCH` / autoenroll cap if runway is fat; import newly warmed inboxes; run one KoldInfo CSV round-trip on the `named`-but-no-email backlog.

## Throughput reality check

- **Inboxes are the ceiling:** 2 cold/day each, so 3K/day needs 1,500 warmed inboxes. Ramp caps with inbox count, not ambition.
- **Video is the second ceiling:** ~2.5K composites/day per box. If ready-supply starves, add a worker box before touching any other dial.
- **Reoon batch size is the third:** the default 20/tick quietly caps verified inflow; step 1 above fixes it.

## The copy guard (send-time fail-safe, always on)

Every autopilot send is rendered first and inspected by `lib/copy/renderGuard.ts`. If any merge
token the template uses is missing or fell back to a generic ("Hi there", "your team", "the seat"),
if a `{{token}}` or spintax brace survived, if the Day-1 email lost its video link, if the video
thumbnail isn't wrapped in a clickable link to the watch page, or if the copy breaks the house
voice (hollow openers, fabricated referrals, dashes, emoji) — the prospect is **held**: nothing sends, the sequence doesn't advance, and the exact reasons appear in
**Send Queue → ✋ Copy guard held**. Fix the data in Clients; the next tick re-renders and releases
it automatically. The staging gate also now requires **contact data** (real first name + company +
role/signal) before a prospect counts as send-ready at all (**👤 Contact data** card).

Optional second pass: `AUTOPILOT_CRITIC=1` runs the Haiku critic on each unique rendered wording
(~$0.001, cached, fails open) to catch copy that's technically clean but reads bot-written.

Tune (rarely needed): `RENDER_GUARD_OPTIONAL_TOKENS` (csv of tokens allowed empty, default
`videoposter`), `RENDER_GUARD_ALLOW_FALLBACK` (csv of tokens allowed to use their generic fallback).
Tests: `npx tsx lib/copy/renderGuard.test.ts` — includes the guarantee that all 50 MPC templates +
the video follow-up pass the guard with full data.

## Harden before arming sending (known gaps)

1. The opt-out/DNC list is **in-memory only** — a server restart forgets who said stop. Persist it before real volume.
2. The recruiter sender-pool path doesn't check the bounce-suppression list before sending.
3. No `List-Unsubscribe` header on cold mail (compliance at 3K/day).
4. Positive-reply push notification is a TODO — the 20-minute model needs a ping when someone replies "interested," not a page you remember to check.
5. If the sender pool and MTA are both misconfigured, dispatch falls through to Instantly **dry-run** and looks sent. Make that fail loudly.
