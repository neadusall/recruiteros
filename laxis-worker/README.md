# laxis-worker

A headless-Chromium sidecar that enriches a CSV through **app.laxis.tech/prospect-search**
because Laxis has no API. The main RecruiterOS app sends it the CSV that JD Sourcing
produced; the worker logs into Laxis, uploads the CSV, runs Laxis's enrichment, downloads
the enriched CSV, and hands the bytes back. The app then merges contacts onto the candidate
rows and (for anything Laxis left blank) runs its own cheap contact waterfall before you
promote them to Candidates.

It is **never exposed publicly** — only the app talks to it, on the internal Docker network
at `http://laxis-worker:3000`.

## How it fits

```
JD Sourcing rows ──serialize──▶ CSV ──POST /jobs──▶ [laxis-worker]
                                                        │ logs into Laxis (once, cookies persist)
                                                        │ uploads CSV to /prospect-search
                                                        │ runs enrichment, downloads result
                                                        ▼
candidate rows ◀──merge by LinkedIn URL── enriched CSV ◀┘
        │
        └─▶ in-house waterfall fills the gaps ─▶ promote to Candidates
```

## Configuration (`.env.production` on the Hetzner box)

| Var | Required | What |
|-----|----------|------|
| `LAXIS_EMAIL` | **yes** | Your Laxis login email |
| `LAXIS_PASSWORD` | **yes** | Your Laxis login password |
| `LAXIS_WORKER_TOKEN` | recommended | Shared secret; the app must send the same value. If unset, the worker accepts any internal caller. |
| `LAXIS_STATE_PATH` | no | Where the persisted session is stored. Defaults to `/data/laxis-state.json` (on the named volume). |
| `LAXIS_MAX_UPLOAD` | no | Per-import contact cap. Defaults to **1000** (Laxis's limit). The app paginates bigger lists into 1000-row chunks. |
| `LAXIS_HEADED` | no | `1` to run the browser headed (local debugging only). |

The app side needs `LAXIS_WORKER_URL=http://laxis-worker:3000` (already set in `docker-compose.yml`).

## Endpoints

- `POST /jobs` → `{ csv }` → `202 { jobId }` (returns `{ jobId, deduped:true }` if an identical CSV is already in flight)
- `GET /jobs/:id` → `{ status: queued|running|done|error, stage, phase, attempts, enrichedCsv?, error? }`
- `GET /health` → `{ ok, hasCreds, queued, running, lastCanary }`

Single concurrency on purpose: one browser session to Laxis at a time looks like one human
and minimizes the chance of tripping bot detection. Jobs queue.

## Durability — survives a restart mid-pull, never re-grabs (the safeguards)

A browser job can be interrupted at the worst time (crash, OOM, autoheal restart, redeploy).
The worker is built so that **no in-flight job is lost and no already-enriched data is
re-grabbed** (which would waste Laxis credits + time):

- **Every job is persisted to `/data/laxis-jobs/`** (the same durable volume as the session):
  metadata + the input CSV + the enriched result, each in its own file. The in-memory job
  list is just a cache of this.
- **Boot recovery** — on startup the worker reloads every persisted job. Any job that was
  mid-flight is re-queued and **resumed**, not restarted.
- **Token-keyed idempotency** — each job names its Laxis row with a unique `rosjob-<hex>`
  token. Before uploading, the worker checks `/prospect` for that row: **if it already exists
  (a previous run created it) it does NOT re-upload** — it just waits for it to finish and
  exports. So a resume re-attaches to the *same* Laxis enrichment instead of starting a new
  one. Duplicate `POST /jobs` of an identical CSV is de-duped to the same job too.
- **Bounded retries** — a transient failure re-queues the job (up to `LAXIS_MAX_ATTEMPTS`,
  default 3); because the row already exists on Laxis, the retry resumes rather than re-grabs.
  Only a deep structural break (`laxis_step_unresolved`) or bad creds fails fast.
- **Results are kept on disk** for `LAXIS_DONE_RETENTION_HOURS` (default 48h), so the app can
  still collect a result even if it polls late or was offline when the job finished.

On the **app side**, each sourcing run records which 1,000-row chunk offsets are already
enriched (`laxisProgress.doneOffsets` + `nextStart`). Re-running enrichment after the tab was
closed mid-pull **skips done chunks and resumes from the next offset** — it never re-pulls a
chunk that already came back.

| Var | Required | What |
|-----|----------|------|
| `LAXIS_MAX_ATTEMPTS` | no | Retries per job before giving up. Default **3**. |
| `LAXIS_DONE_RETENTION_HOURS` | no | How long a finished job's result is kept on disk. Default **48**. |
| `LAXIS_JOBS_DIR` | no | Where durable job state lives. Default `/data/laxis-jobs`. |

## Self-healing (the worker repairs itself when Laxis changes its UI)

The flow is **calibrated against the live site** and wrapped in a self-healing layer
([`heal.js`](./heal.js)), so a renamed button or moved label doesn't take the tool down:

1. **Fast path** — try the known label for each step (in `CONFIG.text`).
2. **Learned path** — fixes that healed before live in `/data/laxis-overrides.json` and are
   tried first, so a given change is repaired **once**.
3. **Heal path** — if all known labels fail, the worker dumps the page's clickable elements
   and asks Claude (`ANTHROPIC_API_KEY`, already in the env) which one matches the step's
   intent, clicks it, and **persists** the winner as an override.

A **canary** (`/selftest`, also run on a timer every `LAXIS_CANARY_HOURS`, default 12h) logs
in and confirms the enrich entry point is reachable — pre-emptively healing UI drift *before*
a real job ever hits it. Check it any time:

```bash
docker compose exec laxis-worker node -e "fetch('http://127.0.0.1:3000/selftest').then(r=>r.json()).then(console.log)"
```

Only a deep structural change (a brand-new multi-step flow) needs a human — and even then the
job fails with a precise `laxis_step_unresolved: '<step>'` error naming exactly what broke. To
re-learn the flow from scratch, run `node probe.js`.

The calibrated flow today (in `laxis-flow.js`): login is email/password behind
*"Other ways to sign in" → "Continue with Email"*; the CSV upload is on `/prospect` via
*"Enrich Prospects"*; completion is the job row flipping to *"Completed"*; results come from
the per-job *"Export"*.

Two data contracts to keep in mind:

1. **Import CSV format** — Laxis's importer expects exactly two snake_case columns,
   `email,linkedin_url` (confirmed from the `sample_enrich_template` Laxis hands out). The
   app already emits exactly this (`LAXIS_CSV_COLUMNS` in `integration/lib/sourcing/laxis.ts`),
   so the importer should auto-recognize the headers with no mapping step. Only touch
   `CONFIG.columnMap` here if Laxis ever shows a column-mapping dropdown.
2. **Export CSV headers** — what Laxis names the email/phone/LinkedIn columns. The app's
   merge is header-tolerant (fuzzy-matches `email`, `mobile`, `linkedin`…), but verify it
   actually picks the right columns on a real export.

## Re-seeding the session

If Laxis logs the worker out (password change, long idle), just run the login again — the
next job re-logs-in automatically too:

```bash
docker compose run --rm laxis-worker node login.js
```
