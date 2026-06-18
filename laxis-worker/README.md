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

- `POST /jobs` → `{ csv }` → `202 { jobId }`
- `GET /jobs/:id` → `{ status: queued|running|done|error, stage, enrichedCsv?, error? }`
- `GET /health` → `{ ok, hasCreds, queued, running }`

Single concurrency on purpose: one browser session to Laxis at a time looks like one human
and minimizes the chance of tripping bot detection. Jobs queue.

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
