# RecruiterOS Backend, built from the GTM-OS spec

This is the server-side engine for RecruiterOS, modeled tab-for-tab on the GTM
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

## Production seams (search for `TODO(prod)`)

- `lib/core/repository.ts`, every `getRepository()` -> swap for Prisma.
- `lib/response/suppression.ts` -> real DNC mirror to Instantly/SalesRobot/TalTxt.
- `lib/ats/loxo.ts` -> set `LOXO_API_KEY` to go live.
- `lib/connected/index.ts` -> real per-service verify endpoints.
- `lib/auth/index.ts` `sendEmail` -> SMTP / Resend / SES.
- webhook routes -> verify provider signatures before processing.
