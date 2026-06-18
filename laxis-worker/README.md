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

## ⚠️ Calibration — required before first real use

The Laxis-specific selectors in [`laxis-flow.js`](./laxis-flow.js) (everything under
`CONFIG.selectors`, marked `// CALIBRATE`) are **educated guesses**. They must be confirmed
against the live site once, or jobs will fail with a clear `*_not_found (CALIBRATE …)` error
telling you which selector to fix.

To capture the real selectors:

```bash
# locally, with creds in your env — opens a browser you click through once
cd laxis-worker
npm install
npm run codegen          # Playwright records the selectors as you click upload → enrich → export
```

Paste the upload / enrich / export selectors it records into `CONFIG.selectors`, then verify
end to end:

```bash
LAXIS_HEADED=1 LAXIS_EMAIL=… LAXIS_PASSWORD=… npm run login   # confirms login + session save
```

Also confirm two data contracts during calibration:

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
