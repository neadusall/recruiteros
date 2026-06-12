# Lume Onboarding Runbook — full messaging backend

Living checklist to stand up the **Lume** workspace with a functioning messaging
backend (email + SMS/voice + content + n8n orchestration). Tick items as they
complete. Decisions locked: **owned Postal MTA from day one** (no Instantly
fallback for cold email).

> Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (external clock)

The platform is ~95% built and shipped on `main`. Every send path is dry-run
safe and gated behind credentials/env vars. Onboarding is **configuration + two
external approval clocks + standing up the n8n conductor** — not building.

---

## Critical path (dependency order)

1. Workspace provisioned + isolated (`HOUSE_WORKSPACE_ID`)
2. Two external clocks started day one — Telnyx 10DLC, email domain warmup
3. Provider credentials entered per-workspace
4. Content engine fed (ICP, persona, signals, assets)
5. n8n workflow deployed (the only piece not yet running)

---

## 1. Workspace + isolation  *(do first — ~1 hr)*

- [ ] Set `HOUSE_WORKSPACE_ID=<house workspace id>` in `.env.production`.
      **Hard prerequisite.** Without it, `integration/lib/connected/credentials.ts`
      mirrors every workspace's saved keys into shared `process.env` — Lume's keys
      collide with other clients'. With it, only the house workspace mirrors; Lume
      stays isolated. (Hardened 2026-06-11 — see Isolation hardening section below.)
- [ ] Lume admin signs up at `/signup.html` → auto-provisions `ws_xxxxx`, lands on
      `#setup/branding`. (No operator bulk-create UI yet — one manual signup.)
- [ ] Branding (Setup → Branding): logo dark/light, brand name, accent color.
- [ ] Custom domain `app.lumesp.com`: add CNAME + TXT, click Verify → `live`.
- [ ] (Optional) Hardcode a Lume preset in `integration/lib/branding/presets.ts`
      so the login page is branded before sign-in.

## 2. External clocks — START DAY ONE  *(days–weeks, out of our control)*

### A. Telnyx 10DLC (SMS + voice) — in Telnyx portal; walkthrough in `helpcenter.html`
- [!] Telnyx account + payment → create API key
- [!] Create **Brand** (legal name, EIN, address, website)
- [!] Create **Campaign** (use case "Mixed", sample messages, opt-in + STOP/HELP)
      — *campaign approval is the wait*
- [ ] Buy number(s) with **both SMS + Voice**
- [ ] Create Messaging Profile + link to approved campaign
- [ ] Assign number to a Call-Control connection (for voice)

### B. Email domain warmup (owned MTA) — see §3; **2–4 week mailbox warmup is unavoidable**
- [!] Warmup ramp begins the moment mailboxes are added. Plan launch volume around it.

## 3. Email backend — owned Postal MTA  *(Setup → Sending; `lib/sending/`)*

6-card Sending tab at `assets/js/command.js` `renderSending()`. Fully built.

- [ ] Env: `HCLOUD_TOKEN`, `HETZNER_DNS_TOKEN` (provisioning)
- [ ] Env: `SENDING_EMAIL_PROVIDER=mta`, `SENDING_WEBHOOK_SECRET`
- [ ] Sending tab → provision MTA server (auto-installs Postal on Hetzner)
- [ ] SSH the box → `postal make-user` → create org + mail server in Postal UI
- [ ] Copy server X-Server-API-Key → paste into Sending tab → MTA server → Postal creds
- [ ] Add sending domains (auto-generates DKIM + DNS zone)
- [ ] **Manual:** point each domain's nameservers to Hetzner at the registrar → Verify
- [ ] Add mailboxes (start warming, day 0, cap ~10/day)
- [ ] (Optional) Seed inboxes + `SENDING_WARMUP_ENGAGE=1` for the engagement loop
- [ ] Cron: `/api/sending/cron` **daily** (warmup ramp, caps, reputation, governor)
- [ ] Cron: `/api/sending/warmup/cron` **every 2–5 min** (if engagement enabled)
- [ ] (Optional) Reputation: `POSTMASTER_CLIENT_ID` + `POSTMASTER_REFRESH_TOKEN`, `SNDS_KEY`
- [ ] Transactional email (resets/magic links): `RESEND_API_KEY` + `EMAIL_FROM`

## 4. Telnyx backend  *(Setup → Integrations → Telnyx; per-workspace isolated)*

Activate once 10DLC (§2A) is approved.

- [ ] Paste **per-workspace**: `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER` (E.164),
      `TELNYX_MESSAGING_PROFILE_ID` → Test (red→yellow→green)
- [ ] **Global env** (`TELNYX_PUBLIC_KEY` webhook sig). NOTE: the *connection id* is
      now resolved workspace-first (`cred()`), so a customer that saves their own
      `TELNYX_CONNECTION_ID` uses it; otherwise it falls back to the house env.
- [ ] Voice Drops (optional): `TELNYX_TRANSFER_NUMBER`, `TELNYX_VOICEMAIL_AUDIO_URL`
- [ ] AI Vetting (optional): `VOICE_CLONE_API_KEY` + `VOICE_CLONE_VOICE_ID`
      (ElevenLabs) → assign a real number via picker → "Go live"
- [ ] **Leave `RECRUITEROS_MAX_DIAL_USD` at $0.03** — standing hard cap, do not raise.

## 5. Content engine  *(the part that needs human input)*

Copy is LLM-generated and confidence-gated (`lib/bd/draftContent.ts`,
`lib/bd/personaMessaging.ts`). **No seeded sequence library** — authored per-motion
in Campaign Studio. Keep Recruiting and BD motions **separate** (standing rule).

- [ ] ICP: account profile, persona, disqualifiers
- [ ] Signals enabled: fundraising / hiring_velocity / leadership_change / expansion / …
- [ ] Persona + voice: sender name, signature, tone (`lib/bd/houseVoice.ts`)
- [ ] Content assets: case studies / comp benchmarks / value props (`lib/content/index.ts`)
      — injected into touches 2 & 3
- [ ] Per-motion sequences (28-day anatomy in `lib/campaigns/sequence.ts`)
- [ ] Confidence gate `RECRUITEROS_BD_MIN_CONFIDENCE` (default 0.7) — drafts below hold for review
- [ ] Prospect data in: name, email, phone (mobile/landline), LinkedIn URL, company,
      title, hiring signal — via Loxo sync (Setup → ATS) or import

## 6. n8n conductor  *(designed, NOT deployed — the real build task)*

Reference workflow: `docs/runbooks/n8n/BUILDER-PROMPT.md`. Every endpoint it calls
already works; build the workflow and point it at RecruiterOS.

- [ ] Deploy n8n instance
- [ ] Env: `RECRUITEROS_BASE_URL`, `RECRUITEROS_API_TOKEN`, `RECRUITEROS_CRON_SECRET`,
      `RECRUITEROS_WS` (=Lume id), `RECRUITEROS_SEQUENCE_ID`,
      `RECRUITEROS_LINKEDIN_ACCOUNT_ID`, `RECRUITEROS_VOICE_CAMPAIGN_ID`
- [ ] Flow A — Funnel (every 30 min): `GET /api/prospects/queue` → split →
      `POST /api/email/send` + `POST /api/linkedin/enroll` → wait 4d → voice-note gate →
      `POST /api/linkedin/actions`
- [ ] Flow B — Ticks: `/api/linkedin/cron` (3 min), `/api/voice/cron` (15 min),
      `/api/sending/cron` (daily 07:00), `/api/bd/nurture/cron` (6 hr)
- [ ] Flow C — LinkedIn accept webhook → mark connected
- [ ] Flow D — Reply/opt-out webhook → `POST /api/bd/nurture {action:"pause"}`

Queue endpoint returns prospects with content **pre-attached** (subject, html,
LinkedIn message, voice script, voicemail script, confidence) — n8n routes only.

---

## Isolation hardening (done 2026-06-11)

The white-label credential seam is closed in code. What changed:

- **`cred()` resolver** added to `lib/providers/http.ts` — resolves a key from the
  active `withWorkspaceCreds()` context first, then `process.env`, but **never**
  falls back to env inside an isolated (customer) context.
- **Bypasses converted** from direct/module-load `process.env` reads to `cred()`:
  `lib/sms/provider.ts`, `lib/voice/provider.ts`, `lib/linkedin/provider.ts`,
  `lib/signals/sources.ts`, `lib/signals/rapidapi.ts`, `lib/sourcing/discovery.ts`,
  `lib/channels/index.ts` (Telnyx connection id), `lib/voice/campaign.ts`,
  `lib/bd/draftContent.ts`, `lib/bd/nurtureSend.ts`, `lib/vetting/assistant.ts`.
- **Nurture cron wrapped**: `app/api/bd/nurture/cron/route.ts` now runs each
  enrollment inside `withWorkspaceCreds(e.workspaceId, …)`.
- **Visible guard**: a `key_isolation` item in the readiness/preflight report and a
  loud boot `console.warn` when >1 workspace exists with `HOUSE_WORKSPACE_ID` unset.
- LLM drafting (`ANTHROPIC_API_KEY`) is intentionally house-provided and unaffected.

**Still your action:** set `HOUSE_WORKSPACE_ID` — the hardening is inert until it is.

---

## Blocker board

| Blocker | Type | Lead time | Status |
|---|---|---|---|
| Telnyx 10DLC campaign approval | External | days–weeks | `[!]` |
| Email mailbox warmup (owned MTA) | Time | 2–4 weeks | `[!]` |
| n8n workflow build + deploy | Work to do | main build task | `[ ]` |
| `HOUSE_WORKSPACE_ID` not set | Config / isolation | minutes | `[ ]` |
| Content inputs (ICP, persona, signals, assets) | Human input | TBD | `[ ]` |
| Custom domain DNS verify | Manual | hours | `[ ]` |

Everything else — email infra, Telnyx send/voice/vetting, content generation,
webhooks, crons — is built and on `main`. No stubs in those paths.

## Go-live verification

- [ ] Email: approve one draft to your own inbox → push → arrives in inbox (not spam)
- [ ] SMS: send a test from the approved 10DLC number → STOP/HELP replies work
- [ ] Voice: place one AMD dial → webhook records outcome
- [ ] Isolation: Lume's keys NOT visible in another workspace's Connected tab
- [ ] n8n: queue pull returns Lume prospects with content attached; fan-out fires
