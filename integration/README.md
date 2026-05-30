# RecruiterOS · LinkedIn Engine (integration)

Drop-in LinkedIn outreach execution for the RecruiterOS framework. It enrolls
prospects into rapport-first sequences, personalizes every touch with AI, sends
through a provider, keeps accounts safe with strict limits, and reacts to
replies in real time.

It is **not standalone**. It mounts into your existing RecruiterOS app
(Next.js App Router + TypeScript) and reuses your data store.

## Design goals

- **Provider agnostic.** Integrate an external API (Unipile) or run on your own
  internal LinkedIn tools. One env var switches backends; nothing else changes.
- **Rapport before pitch.** Every sequence step is bound to a rung
  (recognize, relate, invite, pitch, release). The model cannot pitch early.
- **Account safe by default.** Conservative daily caps, working-hours windows,
  and human-like jitter, enforced before any action runs.
- **Framework agnostic persistence.** The engine talks to a `Repository`
  interface, so it sits on Prisma/Postgres or whatever RecruiterOS already uses.

## Folder layout

```
integration/
  lib/linkedin/
    types.ts           Domain types (Account, Prospect, Sequence, Enrollment…)
    provider.ts        Provider interface + Unipile + internal-tools adapters
    rateLimiter.ts     Daily caps, working hours, human jitter (account safety)
    personalize.ts     AI message generation, bound to the rapport ladder
    classify.ts        AI reply classification (positive/soft_yes/timing/…)
    sequenceEngine.ts  The cadence brain (run steps, accept-triggers, pause)
    repository.ts      Persistence boundary (+ in-memory reference impl)
    auth.ts            Bearer / cron / webhook-signature guards
    sdk.ts             Typed client your RecruiterOS backend imports
  app/api/linkedin/
    enroll/route.ts    POST enroll a prospect into a sequence
    actions/route.ts   POST fire a single action now
    webhook/route.ts   POST provider events (accepts, replies)
    cron/route.ts      GET/POST advance the cadence
  openapi.yaml         REST contract
  .env.example         Configuration
```

## Install

```bash
npm i @anthropic-ai/sdk
# copy the integration/ folder into your RecruiterOS app, then:
cp integration/.env.example .env.local   # fill in values
```

Routes assume the App Router. If your app root differs, move
`integration/app/api/linkedin` under your own `app/`.

## Choose a backend

```bash
# Use the Unipile API
RECRUITEROS_OUTREACH_PROVIDER=unipile
UNIPILE_DSN=...
UNIPILE_API_KEY=...

# Or use your own internal LinkedIn outreach service
RECRUITEROS_OUTREACH_PROVIDER=internal
RECRUITEROS_OUTREACH_URL=https://outreach.internal.recruiteros.co
RECRUITEROS_OUTREACH_TOKEN=...
```

The internal adapter POSTs to `/connect`, `/message`, `/inmail`, `/voice`,
`/view`, `/endorse`, `/withdraw`, `/resolve`, `/messages` on your service and
expects an `ActionResult`-shaped reply. Match those and the engine just works.

## Use it from RecruiterOS

```ts
import { LinkedInClient } from "@/integration/lib/linkedin/sdk";

const li = new LinkedInClient({
  baseUrl: process.env.APP_URL!,
  token: process.env.RECRUITEROS_API_TOKEN!,
});

// Start a rapport-first sequence
await li.enroll({
  accountId: "acct_jamie",
  sequenceId: "seq_senior_react",
  prospect: {
    id: "p_anja",
    campaignId: "camp_react_berlin",
    fullName: "Anja Kohler",
    firstName: "Anja",
    providerProfileId: "ACoAAB...",
    headline: "Senior Frontend Engineer at Trade Republic",
    connectionDegree: 2,
    context: {
      signal: "web platform team reorg",
      recognition: "the Trade Republic order-entry flow, partial fills without a full re-render",
      role: { title: "Staff React Engineer", comp: "$120k to $145k", remote: true, stack: ["React", "TypeScript"] },
    },
  },
});
```

## Wire the cadence

Hit the cron route every 1 to 5 minutes:

```
POST /api/linkedin/cron
header: x-cron-secret: <RECRUITEROS_CRON_SECRET>
```

Each tick processes due enrollments, runs the next allowed step, and
reschedules. Accept-triggered follow-ups and pause-on-reply are handled the
moment the provider webhook fires.

## Connect the webhook

Point your provider (Unipile dashboard) at:

```
POST /api/linkedin/webhook
```

Inbound events are normalized and routed to the engine:
- `invite_accepted` releases the accept-triggered follow-up immediately.
- `message_received` pauses automation, classifies the reply, and stops on opt-out.

## Account safety

Defaults (`defaultLimits()`): 20 invites, 80 messages, 10 InMail, 60 profile
views per day, business hours Monday to Friday, 45 to 150 seconds between
actions. Override per account via `LinkedInAccount.limits`. In production, swap
the in-memory counter store with Redis or your DB via `setUsageStore()`.

## Production checklist

- Replace `getRepository()` with a Prisma-backed `Repository`.
- Call `setUsageStore()` with a shared store so caps hold across workers.
- Set `UNIPILE_WEBHOOK_SECRET` so webhook signatures are verified.
- Keep `RECRUITEROS_API_TOKEN` and `RECRUITEROS_CRON_SECRET` server-side only.
