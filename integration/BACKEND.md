# RecruitersOS Backend, built from the GTM-OS spec

This is the server-side engine for RecruitersOS, modeled tab-for-tab on the GTM
Operating System reference (gtm-os-cyan.vercel.app). One workspace, two motions
(Recruiting OS + Business Development OS), one shared engine. Every module is
framework-agnostic with an in-memory reference store and a clear seam to swap in
Postgres/Prisma. AI uses the Anthropic SDK with prompt caching.

## How to see it work in the morning

The static site is fully clickable with no backend:

1. Open `signup.html` (or click "Open app" on any page). Sign up with your email.
2. You land in `command.html`, the Command Center, signed into your workspace.
3. Click through the left nav. The headline screen is **Response**: a unified
   inbox with AI classification + the routing matrix.
4. Toggle **Recruiting / BD** in the sidebar to relabel the pipeline per motion.

To run the real backend, deploy `integration/` as a Next.js app, set the env
vars in `.env.example`, set `window.RECRUITEROS_API_BASE` on the pages, and
`POST /api/dev/seed` once. The UI auto-switches from `demo` to `live`.

## Tab -> module map

| GTM-OS tab | Backend module | API route | What it does |
|---|---|---|---|
| **Login/enterprise** | `lib/auth` | `/api/auth/{register,login,magic-link,session}` | Email sign-up/login, magic links, sessions, workspaces auto-provisioned from the email domain |
| **Overview** | `lib/overview` | `GET /api/overview` | Capacity RAG stats, appointments, warm convos, active drips |
| **Campaigns** | `lib/campaigns` | `/api/campaigns`, `/api/campaigns/cadence` | Campaign builder, 7-phase deploy spec, A/B kill rule, daily cadence loop |
| **Prospects** | `lib/prospects` | `/api/prospects` | Lifecycle, add/bulk-upload (ATS upsert), transitions, Day-28 nurture rule |
| **Outreach** | `lib/campaigns/sequence` | (served via campaigns) | 28-day multi-channel touch reference + decision rules |
| **Response** | `lib/response` | `/api/response/webhook/[source]`, `/list`, `/actions` | Ingest -> classify -> route -> log. The unified inbox |
| **Accounts** | `lib/accounts` | `/api/accounts` | LinkedIn accounts, sending domains, API keys, health sweep |
| **Connected** | `lib/connected` | `/api/connected` | Integration pre-flight (red/yellow/green) + activation gate |
| **ATS** | `lib/ats` | `GET /api/ats` | Loxo adapter (verified) + object mapping; vendor catalog |
| **Content Library** | `lib/content` | `/api/content` | Assets injected into Touch 2/3 |
| **Core (shared)** | `lib/core` | n/a | Campaign / Prospect / Activity models + the platform repository |

## The Response pipeline (the Money Maker)

`processInbound(source, workspaceId, payload)` runs the whole flow and is
idempotent on the provider message id:

```
webhook (Instantly | Unipile/SalesRobot | TalTxt)
  -> normalize            lib/response/ingest.ts
  -> match prospect       by email / linkedin url / phone
  -> classify             lib/response/classify.ts (fast-path STOP, else Claude)
  -> route                lib/response/router.ts (executes the rule's actions)
  -> log person_event     lib/ats (Loxo)
```

The classification + routing matrix lives in `lib/response/rules.ts` (edit there
to change inbox behavior). It encodes the reference table exactly:

| Class | Action | SLA |
|---|---|---|
| Positive | notify -> call in 24h -> pause all sequences | same day |
| Soft yes | send asset, tag engaged, advance +1 | 4 hours |
| Timing | capture timing, 90-day nurture | same day |
| Fit | 6-month nurture, suppress signals | same day |
| Referral | capture referral, tag advocate, notify | same day |
| STOP | suppress all channels + ATS do-not-contact | immediate |

## Daily cadence

`lib/campaigns/cadence.ts` runs the 7:00 -> 9:00 loop: pull signals -> score &
dedupe -> enrich -> LLM draft -> (8:30 human approval queue) -> push to channels.
Wire `runDailyCadence(workspaceId)` to a cron (Vercel Cron / QStash).

## Auth + enterprise

`lib/auth` issues PBKDF2-hashed passwords and 14-day sessions (HttpOnly cookie or
Bearer). Sign-up from a corporate domain auto-joins (or creates) that domain's
workspace as enterprise; free-mail domains get a personal trial workspace.
Passwordless magic-link sign-in is supported end to end.

**Full login workflows** (all wired to pages on the marketing site):
- Sign up -> `signup.html` -> `POST /api/auth/register`
- Sign in -> `login.html` -> `POST /api/auth/login`
- Forgot password -> `forgot-password.html` -> `POST /api/auth/reset` (never
  reveals whether an email exists)
- Reset password -> `reset-password.html?token=` -> `GET /api/auth/reset?token=`
  to pre-validate, then `PUT /api/auth/reset` to set the new password; this
  revokes all of that user's existing sessions and issues a fresh one.
- Magic link -> `PUT /api/auth/magic-link`
- `app.html` is now a portal redirect: signed-in -> `command.html`, else
  `login.html`, so every "Open app" CTA flows into the auth workflow.

**RBAC / admin sub-accounts** (`lib/auth/permissions.ts` + `lib/auth/team.ts`):
three roles (owner / admin / member) with a capability matrix. Admins add
recruiters (members) via emailed invite links (`?invite=` on signup);
`AuthResult.capabilities` drives what the UI shows, and `api.requireCapability()`
gates the routes. Recruiters are walled off from the Telnyx/SMS account, API
keys, sending domains, the ATS connection, the Connected pre-flight, billing,
and team management (those return 403). Endpoints: `GET/POST /api/team`,
`PUT /api/team/accept`.

## Integrations (all wired)

Every external integration named in the reference has a real client in
[`lib/providers/`](lib/providers/). Each extends a shared base that makes live
`fetch` calls when its key is set and **dry-logs (no-op) when it isn't**, so the
whole engine runs end to end with zero credentials and each integration lights
up the instant you add its key, no code change.

| Provider | File | Channel / use | Wired into |
|---|---|---|---|
| Instantly | `providers/instantly.ts` | Email send, pause, vitals, block-list | channels send, suppression DNC, health sweep |
| Unipile | `providers/unipile.ts` | LinkedIn invite / DM / voice note | channels send |
| SalesRobot | `providers/salesrobot.ts` | LinkedIn alt: add/pause/reply/tag/remove | channels send, suppression DNC |
| TalTxt | `providers/taltxt.ts` | Post-engagement SMS, opt-out | channels send, suppression DNC |
| Telnyx | `providers/telnyx.ts` | Raw 10DLC SMS, voice dialer + Premium AMD | channels send |
| RapidAPI (JSearch) | `providers/rapidapi.ts` | Job scraper / signal pull | cadence signal step |
| Fresh LinkedIn | `providers/freshlinkedin.ts` | Enrichment rung 1 (title/company) | channels `enrich()` |
| Tomba | `providers/tomba.ts` | Enrichment rung 2 (email finder) | channels `enrich()` |
| Loxo | `ats/loxo.ts` | ATS system of record | every person_event |

**Webhook signatures** ([`providers/signatures.ts`](lib/providers/signatures.ts)):
Instantly / Unipile / SalesRobot use HMAC-SHA256; TalTxt / Telnyx use ED25519.
The Response webhook route verifies the signature over the raw body before
processing (no-op until the secret is set).

**Confirm wiring:** `GET /api/providers` returns every provider's
configured-status (`configured N / total`); `POST /api/providers
{"action":"verify-all"}` runs a live health check on all of them. The Connected
tab's "Test all" calls each provider's real `verify()`.

**Send + enrich:** [`lib/channels/`](lib/channels/) routes a touch to the right
provider (email→Instantly, linkedin→Unipile/SalesRobot, sms→TalTxt/Telnyx,
voice→Telnyx AMD) and logs a person_event per touch. The daily cadence calls
`enrich()` at 7:30 and `pushApproved()` at 9:00 (`POST /api/campaigns/cadence
{"action":"push"}`).

## Production seams (search for `TODO(prod)`)

- `lib/core/repository.ts`, every `getRepository()` -> swap for Prisma.
- `lib/auth/index.ts` `sendEmail` -> SMTP / Resend / SES.
- set each provider key in `.env` to flip it from dry-log to live (DNC mirror,
  verify endpoints, channel sends, and webhook signatures all activate per-key).

Already wired (no longer TODO): the DNC mirror, the Connected verify endpoints,
webhook signature verification, and the channel send + enrichment layer.
