# ATS integration — Loxo → RecruiterOS

Pulls **People → Candidates** (the Data warehouse) and **Companies → the BD
company book**, and keeps them fresh via **webhooks + a polling cron**.
Credentials are entered per-workspace in the portal (Admin → **ATS** → click
**Loxo**), never baked into server env, so each workspace connects its own Loxo
account.

## How a user connects it
1. Admin opens **ATS**, clicks **Loxo**.
2. Enters **agency domain** (e.g. `app.loxo.co`), **agency slug**, and the
   **API key** (Loxo → Settings → API Keys; admin-only, paid feature).
3. **Test connection** → we `GET /job_categories` (a cheap authenticated call;
   surfaces the documented 403/401 hints on failure).
4. **Sync now** → pulls People + Companies immediately.
5. **Enable real-time** → registers Loxo webhooks (person/company ×
   create/update/destroy) pointing back at us.

The same **⟳ Sync Loxo** action is on the Candidates toolbar and the Companies
tab header (admin-only).

## Object mapping
| Loxo | RecruiterOS | Where |
| --- | --- | --- |
| Person | `DataRecord` (`recordType: "Candidate"`, `source: "loxo"`) | Data warehouse → Candidates tab |
| Company | `CompanyRecord` (`source: "loxo"`) | BD Companies tab |

Dedupe is by the Loxo id (`providerId`), so re-syncs update rather than
duplicate. User-owned fields (company **status**/**tags**) are never clobbered by
a sync.

## Code map
- `lib/ats/credentials.ts` — per-workspace connection store (durable, masked reads).
- `lib/ats/loxoClient.ts` — `{domain}/api/{slug}/…` Bearer client: list/get people & companies, `ping`, webhook CRUD.
- `lib/ats/map.ts` — Loxo person/company → normalized records (defensive field reads).
- `lib/ats/sync.ts` — `syncLoxo()` (paged, cursor-based), `syncOnePerson/Company`, `registerLoxoWebhooks`.
- `lib/companies/*` — the new durable Companies store (mirrors the data warehouse).
- `app/api/ats/route.ts` — GET config + POST `save|test|set-active|sync|register-webhooks|disconnect`.
- `app/api/companies/route.ts` — list/upsert/patch/delete/sync.
- `app/api/loxo/cron/route.ts` — `requireCronAuth` → `syncLoxo` for every connected workspace.
- `app/api/loxo/webhook/route.ts` — per-workspace secret-verified receiver; fetches the changed record and upserts/deletes it.

## Keeping it updated
- **Webhooks** (real-time): registered on **Enable real-time**; each event re-fetches the record by id.
- **Polling** (safety net): point a scheduler at `GET /api/loxo/cron` with header
  `x-cron-secret: $RECRUITEROS_CRON_SECRET` every few minutes. It re-pulls
  anything changed since each workspace's cursor, backfilling missed webhooks.

## Server env (see `.env.production.example`)
- `APP_BASE_URL` — public origin, for the webhook callback URL (else derived from the request host).
- `RECRUITEROS_CRON_SECRET` — auth for `/api/loxo/cron`.
- `ROS_DATA_DIR` **or** `DATABASE_URL` — persistence; without one, synced data is memory-only.
- `LOXO_API_KEY` — legacy/global fallback for the original push-only adapter only; leave blank when using in-portal setup.

## Notes
- Loxo "Loxo Source" profiles return only name/id/custom fields (proprietary);
  those still map cleanly — contact fields are simply absent. Data you brought
  into your own Loxo database comes back in full.
- Other ATS vendors are clickable in the same UI and will store credentials, but
  verification/sync light up as each adapter ships (Loxo is the implemented one).
