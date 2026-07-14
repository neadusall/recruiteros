# RecruitersOS — Infrastructure, Tech Stack & Cost Model

> **Status of this document:** a working reference for the *as-built* platform plus the
> decisions left to make it a fully provisioned production model.
> **Key finding from the codebase audit:** the large majority of the stack you asked to
> "build" is **already implemented and wired**. What's left is mostly *provisioning keys,
> two architecture decisions (email + hosting), and one data-layer migration* — not
> green-field building.
>
> Cost figures are unit costs from [`integration/lib/billing/rates.ts`](../integration/lib/billing/rates.ts)
> (the in-app cost catalog) plus vendor list pricing as of early 2026. Third-party prices
> drift — **verify against current vendor pricing before committing budget.** All figures
> are *our cost*, not a price charged to customers.

---

## 0. TL;DR

| Layer | What runs it | Built? | Cost shape |
|---|---|---|---|
| Hosting / deploy | **Hetzner VPS** + Docker Compose + Caddy + auto-deploy watcher | ✅ live | ~$8–30/mo fixed |
| Persistence | Postgres (`ros_kv`) **or** file-volume JSON snapshots | ✅ live | included in VPS |
| LLM / content | **Anthropic Claude** (Sonnet 4.6 + Haiku 4.5), direct calls | ✅ live | ~$0.005/prospect |
| Enrichment waterfall | Icypeas → RapidAPI → Telnyx classify → Apify/PDL (gated) | ✅ live | ~$0.007–0.40/contact |
| Hiring signals | 21+ free sources + Unipile/WARN/Adzuna | ✅ live | $0 (free tier) |
| Phone / voice | **Telnyx** (voice, Premium AMD, 10DLC SMS, number lookup) | ✅ live | ~$0.007/min + numbers |
| Direct dial | Apify `phone-number-finder` + People Data Labs | ✅ live, **gated** by $0.03 cap | ~$0.10/dial found |
| Email sending | **Instantly.ai** (campaign, interim → self-hosted MTA) + Resend (system) | ✅ Instantly wired | inbox-based, ~$0.004/send |
| SMS (OS Text) | **money-maker-sms** submodule on Telnyx | ✅ live | ~$0.004–0.008/segment |
| LinkedIn | Unipile API + Playwright scraper sidecar | ✅ live | $0–30/account/mo |
| Orchestration | Daily cadence runner (07:00→09:00) + campaign state machine | ✅ live | n/a |

**All-in modeled cost: ~$0.02–0.07 per prospect** (3-touch email motion), trending to ~$0.02
at scale. Phone/voice and premium mobile add-ons are separate and gated.

**The four real decisions** (detailed in §9):
1. **Email stack** — **DECIDED: build our own self-hosted sending infrastructure** (Postal MTA + domains/mailboxes/warm-up/deliverability). **Instantly.ai** is the as-built **interim** sender, being replaced (see §9.1).
2. **Hosting** — stay on **Hetzner** (cheap, working) or migrate to **AWS** (Amplify/App Runner + RDS — managed, ~5–15× cost).
3. **Data layer** — keep the KV snapshot model or migrate `ros_kv` → real relational tables.
4. **Orchestration** — keep direct one-shot LLM calls or add an agentic orchestration layer.

---

## 1. System architecture (as-built)

```
                              ┌─────────────────────────────────────────┐
   DNS: recruitersos.co  ───▶ │  Hetzner VPS (Ubuntu, Docker Compose)    │
   taltxt.recruitersos.co     │                                          │
                              │   ┌────────┐   serves TLS 80/443         │
                              │   │ Caddy  │  (auto Let's Encrypt)        │
                              │   └───┬────┘                              │
                              │       ├──────────────┬──────────────┐    │
                              │   ┌───▼────┐    ┌─────▼─────┐   ┌────▼──┐ │
                              │   │  app   │    │  taltxt   │   │scraper│ │
                              │   │ Next14 │    │ (OS Text) │   │Python │ │
                              │   │ +API   │    │  SMS app  │   │Playwr.│ │
                              │   └───┬────┘    └─────┬─────┘   └───────┘ │
                              │       │   ┌───────────┘                   │
                              │   ┌───▼───▼──┐        ┌──────────┐        │
                              │   │ Postgres │        │ /data vol│        │
                              │   │   16     │        │ snapshots│        │
                              │   └──────────┘        └──────────┘        │
                              └───────────────┬──────────────────────────┘
                                              │ outbound API calls
        ┌──────────────┬──────────────┬───────┴──────┬─────────────┬─────────────┐
        ▼              ▼              ▼              ▼             ▼             ▼
   Anthropic       Telnyx        Instantly      RapidAPI/      Apify+PDL     Unipile
   (Claude)     (voice/SMS)    (cold email)   Icypeas (enrich) (direct dial) (LinkedIn)
                                                                                +21 free
                                                                                signal feeds
```

**Deploy mechanism** (already automated):
- `deploy.sh` — one-time bootstrap on a fresh Ubuntu box (installs Docker, clones repo, generates secrets, `docker compose up`).
- `auto-deploy.sh` — systemd timer, polls `origin/main` ~every 2 min, `git reset --hard` + `docker compose up -d --build` on a new commit. Graceful fallback to core (app+db+caddy) if the full stack fails.
- **Implication:** shipping = `git push origin main`. No manual deploy step. (See [`docs/platform`](./platform) and the memory on deploy/persistence.)

---

## 2. Hosting & deploy

| Item | Detail |
|---|---|
| Provider | **Hetzner Cloud VPS** (single box today) |
| Orchestration | Docker Compose (`docker-compose.yml` at repo root) |
| Services | `app` (Next.js 14 + API), `db` (Postgres 16), `taltxt` (OS Text SMS submodule), `scraper` (Python Playwright, 1 worker by design), `caddy` (TLS proxy) |
| TLS / proxy | Caddy 2, automatic Let's Encrypt |
| Cost | **~$8/mo** entry VPS (CPX/CX line); ~$15–30/mo once RAM is bumped for Playwright + Postgres + two Node apps |

**Recommended VPS sizing:** Playwright (Chromium) + Postgres + two Next apps want **≥8 GB RAM**. Budget **Hetzner CPX31/CX41 (~$15–30/mo)** for headroom. The $8 entry box works for low volume but will swap under scraping load.

> AWS Amplify (which you mentioned) is covered as an option in §9.2 — short version: it doesn't fit this Dockerized multi-service + Postgres + Playwright shape, and the AWS-native equivalent costs ~5–15× the Hetzner box.

---

## 3. Persistence

Three-tier backend in [`integration/lib/db/index.ts`](../integration/lib/db/index.ts), selected by env:

1. **Postgres** (when `DATABASE_URL` set) — single table `ros_kv (k text PK, v jsonb, updated_at)`.
2. **File** (when `ROS_DATA_DIR` set, the prod default) — atomic JSON snapshots in the `/data` volume. **This is what survives redeploys in production.**
3. **Memory** (neither set) — dev only, resets on restart.

**How it works:** each module keeps a fast in-memory store, calls `loadSnapshot(key)` on boot and a debounced `saveSnapshot(key, data)` (~250 ms) on mutation. **Everything is a JSON blob** — there are no relational tables for prospects/campaigns/etc. today.

**Trade-off & decision (§9.3):** the KV/snapshot model is zero-migration and bulletproof for small/medium scale, but it loads whole blobs into memory and can't do server-side queries/joins. The **Data warehouse** (the new Data tab) uses this same model (`data_warehouse_v1` snapshot) — fine for tens of thousands of records, but a large ZoomInfo import (hundreds of thousands+) is the first thing that will pressure it toward real Postgres tables.

---

## 4. LLM / content / orchestration

| Aspect | Detail |
|---|---|
| Provider | **Anthropic** (`@anthropic-ai/sdk`) |
| Models | `claude-sonnet-4-6` (default: drafting, reply classification, SMS) · `claude-haiku-4-5` (JD parsing — cheap/fast) |
| Config | `ANTHROPIC_API_KEY`, `RECRUITEROS_LLM_MODEL`, `RECRUITEROS_SOURCING_MODEL` |
| Where | JD→ICP parsing (`lib/sourcing`), message personalization (`lib/linkedin/personalize`), reply classification (`lib/response`, `lib/linkedin/classify`), 2-way SMS (`lib/sms/conversation`) |
| Style | **Direct one-shot calls** with cached system prompts (`cache_control: ephemeral`) + deterministic fallbacks. **No agentic/tool-use orchestration layer.** |

**Cost (modeled):** `ai_personalize` **$0.004/prospect** (once, not per send; ~800 in / 150 out tokens, cached prompt) + `ai_classify_reply` **$0.001/reply** (only fires on the ~4% who reply). Effectively **~$0.004/prospect**.

**Orchestration today** = the **daily cadence runner** (`lib/campaigns/cadence.ts`) + the **campaign state machine** (`lib/signals/campaignFlow.ts`: draft→approved→enriching→drafting→ready→live). It's deterministic scheduling, not LLM agents. See §9.4 if you want a true orchestration layer.

---

## 5. Enrichment waterfall (email + phone)

Cheapest-first, with provenance, in [`lib/signals/waterfall.ts`](../integration/lib/signals/waterfall.ts) + [`rapidapi.ts`](../integration/lib/signals/rapidapi.ts). Order:

| # | Rung | Cost | Notes |
|---|---|---|---|
| 0 | Domain guess + email-pattern permutations | **$0** | local heuristics |
| 1 | **Icypeas** email finder | ~$0.003 | recommended primary |
| 2 | **RapidAPI** email finder(s) | ~$0.006 blended | configurable host/path |
| 3 | **Email verify** (SMTP/MX) | $0.001 | upgrades confidence pre-send |
| 4 | Phone classify (**Telnyx** number lookup) | $0.0025 | mobile vs landline routing |
| 5 | Landline (cheap RapidAPI) | $0.015 | often a switchboard |
| 6 | **Apify** direct-dial + **PDL** | $0.10/found | the person's own line; **gated** |
| 7 | Premium mobile (Prospeo/Datagma) | **$0.39** | realistic floor for real mobiles |

**Hard cost guard:** `RECRUITEROS_MAX_DIAL_USD` (default **$0.03/contact**) skips rungs 6–7 unless raised. This is intentional — see the dial-cost-cap memory. Email-only enrichment blends to **~$0.007/prospect**; real direct-dial is the expensive part and is off by default.

**Keys:** `RAPIDAPI_KEY` (+ `RAPIDAPI_EMAIL_HOST/PATH`, `_PERSON_`, `_PHONE_`, `_MOBILE_`, `_LANDLINE_`), `ICYPEAS_API_KEY`/`_SECRET`, `EMAIL_VERIFY_HOST/PATH`, `APIFY_TOKEN`, `PDL_API_KEY`, `TELNYX_API_KEY` + `TELNYX_NUMBER_LOOKUP=1`.

---

## 6. Hiring signals

[`lib/signals/registry.ts`](../integration/lib/signals/registry.ts) defines 50+ signal types across 6 categories; sources in `sources.ts` + `freeSources.ts` + `hiring/`.

- **Free (no key): 21 connectors** — Greenhouse/Lever/Ashby/Workable/SmartRecruiters/Recruitee public boards, SEC EDGAR, USAspending, HN "who is hiring", GitHub, Google News RSS, Product Hunt, RemoteOK/Remotive/Arbeitnow/Jobicy/TheMuse/Himalayas/WorkingNomads/WeWorkRemotely/Jobspresso, Indeed-via-proxy.
- **Keyed/optional:** Unipile people-graph (`UNIPILE_DSN`/`_API_KEY`), `WARN_FEED_URL`, `LAYOFFS_FEED_URL`, `GITHUB_TOKEN` (rate limits), Adzuna (`ADZUNA_APP_ID`/`_KEY`, free tier).
- **Cost:** `signals_free` = **$0**. Optional paid augment (RapidAPI JSearch) ~$0.002/search or ~$25–50/mo flat.

---

## 7. Outreach delivery

### 7a. Phone / voice — **Telnyx** (`lib/providers/telnyx.ts`, `lib/voice/*`, `app/api/voice/*`)
Programmable voice with **Premium AMD** (answering-machine detection), 10DLC SMS, number lookup, call control (warm transfer, voicemail playback, TTS). Voice Drops campaign engine with timezone windows + consent gates is built.
- **Cost:** `voice_minute` **$0.007/min** (incl. Premium AMD); SMS `sms_segment` **$0.004/segment**; number rental **~$1–2/number/mo**; classify $0.0025/lookup. Voice clone synthesis (ElevenLabs) **$0.02/segment on cache-miss only**, trends to $0.
- **Keys:** `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_TRANSFER_NUMBER`, `TELNYX_VOICEMAIL_AUDIO_URL`, `TELNYX_PUBLIC_KEY`; voice clone: `VOICE_CLONE_API_KEY`/`_VOICE_ID`.

### 7b. Email — **Instantly.ai** (as-built, interim) → **self-hosted MTA** (chosen, being built) — see §9.1
- **As-built (interim):** `lib/providers/instantly.ts` + `lib/channels/index.ts` push leads to Instantly campaigns, pause-on-reply, pull analytics. Sends go through **your own warmed inboxes** → marginal cost is the mailbox, not a per-email API fee.
- **System email:** Resend (`RESEND_API_KEY`) for auth/magic-link/reset; logs-to-console without a key.
- **Cost:** `inbox_month` **$2.50/inbox** (≈750 safe sends/mo), `domain_month` **$1.00/domain** (~3 inboxes each). Instantly platform fee optional ~$37–97/mo or **$0** on own inboxes.
- **Direction:** Instantly is the **interim** sender; the chosen path is **self-hosted** (Postal MTA + our own warm-up/deliverability engine), with the Phase-1 foundation already shipped in `lib/sending/` (see §9.1 + the design doc). `Winnr`/`Mailivery` were considered and **dropped** — never in the codebase.

### 7c. SMS (OS Text)
`money-maker-sms` submodule (self-hosted Postgres), embedded via SSO iframe. Telnyx-backed, QStash (`QSTASH_*`) for scheduled sends.

### 7d. LinkedIn
Unipile API (`UNIPILE_*`) for connect/DM/voice-note, **or** the Playwright scraper sidecar (`LINKEDIN_LI_AT` cookie, `SCRAPER_URL`). Internal "Alfred" engine default = **$0**; Unipile ~$10–30/account/mo; SalesRobot ~$99/mo legacy alt.

---

## 8. Cost model

### 8a. Per-prospect variable (email motion, base)
| Driver | Cost |
|---|---|
| Email find (waterfall) | $0.006 |
| Email verify | $0.001 |
| AI personalization | $0.004 |
| AI reply classify (× 4% reply) | $0.00004 |
| **Subtotal (enrichment + AI)** | **~$0.011 / prospect** |

Add-ons (only when used): person-enrich (company-level signal → name) **+$0.005**; direct-dial **+$0.10** (cap must be raised); real mobile **+$0.39**; voice drop **~$0.03/call**; SMS **$0.004/segment**.

### 8b. Sending capacity (scales with send volume, 3 touches/prospect)
Inboxes = `ceil(sends / 750) × $2.50`; domains = `ceil(inboxes / 3) × $1.00`.

### 8c. Fixed monthly
Hetzner VPS **~$8–30** + RapidAPI flat **~$40** (covers email/people-search listings) + optional Instantly **$0–97**. Anthropic/Telnyx/Icypeas/Apify are pay-as-you-go (already in variable).

### 8d. Worked examples (3-touch email, own inboxes)
| Prospects/mo | Sends | Inboxes/Domains | Variable | Capacity | Fixed | **Total** | **Per prospect** |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 3,000 | 4 / 2 | $11 | $12 | ~$48 | **~$71** | **~$0.071** |
| 5,000 | 15,000 | 20 / 7 | $55 | $57 | ~$48 | **~$160** | **~$0.032** |
| 25,000 | 75,000 | 100 / 34 | $275 | $284 | ~$78 | **~$637** | **~$0.025** |

> Per-prospect cost falls as fixed overhead amortizes — matching the catalog's design target
> (85% gross margin, ~2¢/prospect floor). Voice/SMS/direct-dial are **not** in these rows; they're
> opt-in per campaign and gated by `RECRUITEROS_MAX_DIAL_USD`.

---

## 9. Open decisions (to reach a "fully provisioned" model)

### 9.1 Email stack — **DECIDED: build our own self-hosted infrastructure**
Owner decision: **not Instantly, not Winnr** — build our own sending stack (domains, mailboxes,
MTA, warm-up, deliverability monitoring) on **Postal**, plugged into the existing campaign engine
by swapping the `email` channel in `lib/channels/index.ts`.

**Target volume (owner-set): 20,000–30,000 emails/month** → right-sized to **~40 mailboxes / ~12
domains / 1–2 Postal VPS / 1–2 IPs ≈ $30–45/mo infra** (~$150–200/mo all-in with enrichment+AI).
The 500-mailbox/30-server spec is future/multi-tenant only — not the current build.

→ Full build plan, cost model, deliverability engine, risks, and phased rollout:
**[`design/self-hosted-email-infrastructure.md`](./design/self-hosted-email-infrastructure.md)**.

Key reality (owner-emphasized): the MTA software is the easy part; **bounce/complaint management,
reputation tracking, inbox-placement testing, and abuse prevention are where ~70% of the
engineering goes** — that's the deliverability engine (design doc §2a). Phase 0 proves placement
before ramping to the full ~40 mailboxes.

### 9.2 Hosting — Hetzner (built) vs AWS (Amplify/App Runner + RDS)
- **AWS Amplify** is built for frontend/SSR hosting — it does **not** fit this Dockerized multi-service stack (Postgres + Playwright sidecar + always-on cadence). The real AWS port is **App Runner or ECS Fargate** (app + taltxt + scraper) + **RDS Postgres** + **EFS** (snapshots) + ALB.
- **Cost delta:** Hetzner **~$8–30/mo** all-in vs an AWS baseline **~$70–150/mo** (App Runner/Fargate ~$25–60 + RDS ~$25–50 + ALB ~$18 + data/EFS). You gain managed scaling, backups, and enterprise/compliance posture; you pay 5–15×.
- **Recommendation:** stay on Hetzner until a customer/compliance requirement forces AWS. If/when you move, target **ECS Fargate + RDS**, not Amplify. (I can produce a Terraform/CDK plan when you decide.)

### 9.3 Data layer — KV snapshots vs relational Postgres
The snapshot model is great until a single blob gets large. The **ZoomInfo Data warehouse** is the first feature likely to outgrow it. **Recommendation:** keep KV for everything now; when the warehouse passes ~100k records, migrate *just that store* to real Postgres tables (indexed search), leaving the rest on snapshots.

### 9.4 Orchestration — direct calls vs agentic layer
Today's LLM usage is one-shot extraction/drafting — robust and cheap. An agentic orchestration layer (tool-use, multi-step research/verification) is only worth it for harder autonomous tasks (e.g., multi-source candidate research, self-verifying enrichment). **Recommendation:** keep direct calls for the cadence; introduce orchestration narrowly if/when a feature genuinely needs multi-step reasoning.

---

## 10. Go-live provisioning checklist (keys to actually turn it on)

**Required to operate the core email motion:**
- `ANTHROPIC_API_KEY` (LLM)
- `RAPIDAPI_KEY` + `RAPIDAPI_EMAIL_HOST/PATH` (+ `ICYPEAS_API_KEY`/`_SECRET`) (enrichment)
- `INSTANTLY_API_KEY` (+ warmed inboxes/domains) **or** the chosen email stack
- `RESEND_API_KEY` + `EMAIL_FROM` (system/auth email)
- `RECRUITEROS_SESSION_SECRET`, `OWNER_EMAIL`, `RECRUITEROS_APP_URL`
- `POSTGRES_PASSWORD` or `ROS_DATA_DIR` (persistence)

**Add for phone/voice:**
- `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_TRANSFER_NUMBER`, `TELNYX_VOICEMAIL_AUDIO_URL`, `TELNYX_NUMBER_LOOKUP=1`
- Voice clone: `VOICE_CLONE_API_KEY`, `VOICE_CLONE_VOICE_ID`
- Direct dial (optional): `APIFY_TOKEN`, `PDL_API_KEY`, and raise `RECRUITEROS_MAX_DIAL_USD` ≥ 0.10

**Add for LinkedIn / signals / SMS:**
- `UNIPILE_DSN`/`_API_KEY` or `LINKEDIN_LI_AT` + `SCRAPER_URL`/`SCRAPER_TOKEN`
- `WARN_FEED_URL`, `LAYOFFS_FEED_URL`, `GITHUB_TOKEN`, `ADZUNA_APP_ID`/`_KEY` (optional signals)
- `QSTASH_*` (OS Text scheduled SMS)

**Data warehouse / ZoomInfo (the Data tab):**
- `ZOOMINFO_API_KEY` + `ZOOMINFO_API_BASE` (when the official key lands; CSV import works today without it)

> The full deduplicated env-var list (~110 vars across ~18 vendors) lives in
> [`integration/.env.production.example`](../integration/.env.production.example). This checklist is
> the minimal subset to bring each motion online.
```
