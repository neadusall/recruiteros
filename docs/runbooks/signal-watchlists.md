# Signal Watchlists (real-time target-job outreach)

Define your target jobs once. The system polls the job feed every 15 minutes, keeps only
genuinely-new hiring companies, enriches 3 decision-makers per company, drops them into the
Clients tab, builds the first email + PiP Studio video email, and releases them into the Send
Queue on the next free daily slot. Fully server-side. No browser tab open.

## The pipeline (what happens to a signal)

```
Watchlist (your target job)
  -> [every 15 min]  previewJobFeed()        real postings from JSearch      (paid, budget-capped)
  -> drop companies already actioned          net-new only, pitch a company once
  -> curateFromPool()                         3 decision-makers -> Clients tab (free enrichment)
  -> runAutofill()                            enroll into the BD Send Queue campaign
  -> first email (MPC) + PiP video email       built server-side, no click
  -> prospectReadiness() == ready             gate: BOTH emails exist
  -> Send Queue -> runAutopilot -> Sending.ac  released on the next free 2/day slot
```

Only the first three rows are new code (`lib/signals/watch/*`). Everything from `curateFromPool`
onward is the existing In-Market + Send Queue machinery, already running on its own timers.

## What is "real time" here (be honest)

The job feed is **pull, not push**, nothing alerts us the instant a job posts. Freshness is
bounded by (a) how fast JSearch indexes a posting (minutes to a few hours) and (b) our 15-min poll.
Realistic outcome: **same-hour outreach**, not the literal second it goes live. The `datePosted`
default of `today` keeps each poll focused on fresh postings.

## One-time setup

### 1. Required env (on the app server, in the app's environment)

| Var | Why | Notes |
|-----|-----|-------|
| `RAPID_JOBS_KEY` + `RAPID_JOBS_HOST` | the JSearch job feed | already live if JD Sourcing's feed works; `RAPID_JOBS_HOST=jsearch.p.rapidapi.com` |
| `RECRUITEROS_CRON_SECRET` | authes the 15-min timer | same secret the other crons use |
| `AUTOMATION_ENABLED=1` | lets the downstream autopilot draft + send | master gate for hands-off sending |
| `INMARKET_AUTOVIDEO=1` | builds the PiP video email hands-off | needs your base clip + voice (below) |
| `INMARKET_DM_PER_COMPANY` | contacts per company | default `3` |

Optional tuning:

| Var | Default | Effect |
|-----|---------|--------|
| `SIGNALS_WATCH_DAILY_FETCH_CAP` | `500` | hard ceiling on feed fetches/day (spend guard) |
| `SIGNALS_WATCH_MAX_LISTS_PER_TICK` | `50` | lists polled per 15-min tick |
| `SIGNALS_WATCH_KICK_AUTOFILL` | on | set `0` to let the 5-min autofill timer handle enrollment instead of kicking it immediately |

### 2. The base video (once)

The PiP email personalizes **your one webcam clip** over each job posting. Record it once in PiP
Studio (`/pip-studio`) and set your voice. After that every signal reuses it automatically.

### 3. The BD Send Queue campaign (once)

There must be one BD campaign with `sendQueue:true`, an assigned `recruiterId` (routes the
Sending.ac inbox pool), an approved model, `autoRun:true`, `status:"active"`. Set via
`POST /api/send-queue { action:"campaign_setup", campaignId, recruiterId }`.

### 4. Install the 15-min timer (on the app server, as root)

```bash
RECRUITEROS_CRON_SECRET=<secret> bash /opt/recruiteros/install-signals-watch-timer.sh
```

Verify:

```bash
systemctl list-timers recruiteros-signals-watch.timer      # next fire time
systemctl start recruiteros-signals-watch.service          # poll once now
curl -s -H "x-cron-secret: $RECRUITEROS_CRON_SECRET" \
  "http://127.0.0.1:3000/api/signals/watch?status=1" | jq  # budget + per-list stats
```

## Creating watchlists (the API the UI calls)

```
POST /api/signals/watch   { action:"save", watchlist: {
  name:"VP Sales · SaaS · US remote",
  query:"VP of Sales",            // JSearch role/keywords (required)
  location:"United States",        // optional; folded into the query
  remoteOnly:true,                 // optional
  datePosted:"today",              // all|today|3days|week|month  (default today)
  limit:30,                        // jobs pulled per poll (feed cost scales with this)
  minScore:0,                      // only curate companies at/above this intent score
  perPollCompanyCap:25,            // max net-new companies actioned per poll
  everyMinutes:15                  // cadence
}}
```

Other actions: `{action:"toggle", id, active}` pause/resume · `{action:"delete", id}` ·
`{action:"run", id}` poll this list now (test button) · `GET` lists everything + budget + feed status.

## Reliability guarantees (why it is "solid")

- **Idempotent, pitch-once.** A company is fingerprinted (`jobfeed_<slug>`) and only marked *seen*
  **after** its curate succeeds, so a failed poll retries cleanly and the same company is never
  actioned twice, even across overlapping watchlists.
- **Single-flight.** `tickWatchlists()` has a mutex; overlapping timer hits are no-ops.
- **Deploy-proof.** State (definitions, seen-set, budget) is awaited to the durable `/data` volume
  on every write. A redeploy mid-tick just means the next tick re-polls.
- **Spend-capped.** Every paid fetch is reserved against a per-UTC-day ceiling; at the cap the tick
  stops fetching until the day rolls over. Enrichment is free and unmetered.
- **Fail-soft.** Feed off / budget hit / fetch error / curate error are each recorded on the list
  (`stats.lastError`) and surfaced in `?status=1`; one bad list never wedges the sweep.
- **No double-contact.** Downstream send still passes the existing DNC + 14-day first-touch guards,
  and `renderGuard` holds any email whose personalization came out empty rather than sending it.

## Troubleshooting

| Symptom | Check |
|--------|-------|
| lists never poll | timer installed? `systemctl status recruiteros-signals-watch.timer`; secret matches app |
| `feed not configured` in stats | `RAPID_JOBS_KEY`/`RAPID_JOBS_HOST` missing in the app env |
| `daily feed budget reached` | raise `SIGNALS_WATCH_DAILY_FETCH_CAP` or lower per-list `limit`/cadence |
| companies land in Clients but never send | BD Send Queue campaign not set up (step 3), or `AUTOMATION_ENABLED`/video not configured |
| no PiP email built | base clip/voice not set in PiP Studio, or `INMARKET_AUTOVIDEO` off |
