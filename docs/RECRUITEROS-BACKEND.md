# RECRUITEROS-BACKEND.md — Wiring the sending + voice-drop backend

> Companion to CLAUDE.md. That file is the **brain** (who to contact + what to say, daily).
> This file is the **machine** that actually sends, tracks opens, and fires voice drops.
> RecruiterOS is YOUR app (UI + orchestration). The engines below plug into its backend.
>
> **Email-stack note (read first):** the email sender is **self-hosted** — our own domains,
> mailboxes, **Postal MTA**, warm-up, and deliverability monitoring (see
> [`design/self-hosted-email-infrastructure.md`](design/self-hosted-email-infrastructure.md)).
> **Instantly is the interim sender** still wired in code (`lib/providers/instantly.ts`)
> until the MTA send-provider ships; it is being replaced, not extended. **Winnr, Mailivery,
> OutEngine, Zapmail, Mailforge, Infraforge, Smartlead are NOT used** — they were considered
> and dropped. The campaign engine (Sequences Library / Campaign Studio / campaigns / email
> sequencing) is unchanged by the swap — **only the sender underneath changes.**

---

## 1. ENGINE MAP

```
                         ┌──────────────────────────────────────────┐
                         │   RECRUITEROS  (your app)                 │
                         │   campaigns · contacts/CRM · scheduler ·  │
                         │   rules engine · webhook receiver · UI    │
                         └───┬───────────┬───────────┬───────────┬───┘
            email send +     │           │ LinkedIn  │ voice     │ signals
            OWN open pixel   │           │ send/recv │ drops     │ (open roles)
                             ▼           ▼           ▼           ▼
                     Self-hosted MTA  Unipile      Telnyx       Apify
                     (Postal: own     (LinkedIn    (Call Control (job
                     domains/mailboxes API +       + AMD)        scraping)
                     /warm-up/deliv.  webhooks)
                     monitoring)
                     [interim: Instantly]
                             ▲
                             └── Claude Code: builds these integrations + runs CLAUDE.md daily
```

**Key rule:** RecruiterOS must OWN the email-open event (inject its own tracking pixel when
sending through our own mailboxes via Postal SMTP/API). The voice-drop trigger depends on it.
Self-hosting makes this native — we control the MTA, so the pixel and the open/bounce/complaint
webhooks are all ours.

---

## 2. COST (chosen stack — self-hosted email at 20–30K sends/mo + voice + LinkedIn)

| Engine | Role | Cost/mo |
|---|---|---|
| **Self-hosted email (Postal)** | Our own MTA on a cheap VPS + 1–2 dedicated IPv4 + ~10–15 domains + ~40 self-hosted mailboxes (mailboxes are $0 marginal). Owns SMTP, DKIM/SPF/DMARC/PTR, tracking pixel, bounce/complaint webhooks. | **~$30–45** |
| Email deliverability monitoring | Google Postmaster + Microsoft SNDS + EasyDMARC (free tiers cover this scale) | $0 |
| _(interim) Instantly_ | _Optional bridge while the MTA send-provider is finished; being replaced — do not invest in it_ | _$0–97_ |
| **Unipile** | LinkedIn API for all profiles (≤10 linked accounts = $55 floor); do NOT route cold email through it | ~$55 |
| LinkedIn seats | 4× **Premium Business** (~$60) to message/Open-Profile. Sales Nav (~$99 ea) adds Open-Profile filters + 50 InMail/mo but pushes over $800 | ~$240 |
| **Apify** | Open-role signals ($1/1k) + discovery ($3–10/1k) + email & **ryanclinton direct-dial** ($0.03/found) + plan | ~$70 |
| **Telnyx** | Number + Number Lookup validation (~$0.005) + AMD drop minutes | ~$30 |
| **ElevenLabs** | Cloned voice for the voicemail drop (flat — recorded once per campaign) | ~$22 |
| **Claude Code** | Brain + builder | $20–100 |
| Hosting + Postgres | Run the app + DB (Hetzner VPS) | ~$25 |
| Enrichment usage | Direct dials @ ~$0.03 + emails, pay-on-success | ~$50–100 |

**Total ≈ $540–680/mo** with Premium LinkedIn seats — under $800, and the email line is now
**owned infra (~$30–45)** instead of a per-inbox SaaS bill. Swing factor: 4× Sales Navigator
(~$396 vs $240) pushes ~$150 over; start Premium, upgrade seats as placements pay for them.
Per voicemail drop all-in ≈ $0.04–0.05 (direct dial + lookup + ~30–45s call; AMD is free).

> The hidden cost of self-hosting is **deliverability ops** (~10–15 min/day with the dashboard +
> auto-pause governor), not cash. See the design doc §2a — that engine is where ~70% of the email
> build effort goes; the Postal hookup itself is a few days.

---

## 2.5 THROUGHPUT, SAFE LIMITS & THE UI LAYER

**Daily volume (steady-state, AFTER a 2–4 week ramp). LinkedIn safety is the hard constraint.**

| Channel | Safe rate / unit / day | Units | Total/day |
|---|---|---|---|
| LinkedIn connection requests | 15–20 / account | 4 accounts | 60–80 |
| LinkedIn messages (1st-degree + Open-Profile free InMail) | 25–40 / account | 4 accounts | 100–160 |
| Cold email (own warmed mailboxes) | 30–40 / mailbox | 15 → ~40 mailboxes | 450–600 → ~1,000–1,200 |
| Voicemail AMD drops (fire on email-sent, validated direct lines) | ~30–50% of emails, capped | cap 100–150 | 100–150 |

> Email volume is sized to the owner-set **20–30K sends/month** target on ~40 self-hosted
> mailboxes (~750 safe sends/mailbox/mo). The 500-mailbox spec is future/multi-tenant only.

Rules that keep this alive:
- **Ramp:** LinkedIn starts ~5/account/day, email ~5–10/mailbox/day, build to the above over 2–4 weeks.
  Self-hosted IPs start at **zero reputation** and must be warmed for weeks before real volume —
  this is the gating constraint on the email side (see design doc §6).
- **One dedicated IP per LinkedIn profile** — never share an IP across profiles; Unipile keeps a separate
  session per account. Each profile must look like independent, natural human activity. (Same isolation
  principle applies to email sending pools/IPs.)
- **Open Profiles** (~5–10% of people) can be messaged free without spending connection-request quota or
  InMail credits — route those to direct messages, save connection requests for everyone else.
- Quality gates volume: low reply rate + high volume = restriction even under the numeric caps. On email,
  bounce/complaint spikes auto-pause a mailbox/domain/IP before it burns a pool.
- The scheduler enforces every per-account and per-mailbox cap; recruiters never set raw volumes by hand.

**UI layer — three surfaces on the `campaigns`/`campaign_steps`/`messages`/`events` tables.
These are CRITICAL and stay exactly as-is regardless of the email sender swap:**
- **Sequences Library** — reusable multi-channel templates (ordered `campaign_steps`: channel + delay +
  body + voicemail `audio_url`). Recruiters clone, never build from scratch. One per BD play (§ CLAUDE.md).
- **Campaign Studio** — launch flow: pick a signal-sourced list → pick a Library sequence → assign sending
  identities (which of the 4 LinkedIn accounts + which mailboxes) → system auto-applies the safe caps above
  → pre-flight (all channels green) → launch.
- **Campaigns** — running dashboard: live per-step status, the **approval queue** (Daily Cadence), the unified
  reply inbox (email via the MTA's inbound/IMAP + LinkedIn via Unipile), hot-lead escalation, per-signal analytics.

The recruiter's whole job: open Studio → pick list + sequence + identities → launch → work the approval
queue and hot replies. Sourcing, enrichment, direct-dial lookup, validation, caps, and drops run automatically.

---

## 3. DATA MODEL (minimum — adapt to whatever ORM the repo uses)

```
contacts(id, company, domain, first_name, last_name, title, email,
         phone, phone_type[landline|voip|mobile|unknown], company_phone,
         linkedin_url, desk, consent_email, consent_voice, timezone, status)
campaigns(id, name, desk, status)
campaign_steps(id, campaign_id, step_no, channel[email|linkedin|voicedrop],
               delay_days, template, audio_url)
messages(id, contact_id, campaign_id, channel, provider_msg_id,
         status[queued|sent|opened|replied|failed], sent_at)
events(id, contact_id, message_id, type[open|click|reply|li_accept|
       voicemail_left|bounce|unsub], payload_json, created_at)   ← heart of the system
voice_drops(id, contact_id, telnyx_call_id, result[machine|human|no_answer], left_at)
```

The **events** table is what the rules engine reads. Every webhook from every engine writes a row here.

---

## 4. THE CORE EVENT FLOWS (this is the product)

**A. Email send + open tracking**
1. Scheduler picks due `messages` (channel=email) → send through one of our own warmed mailboxes via
   **Postal** (SMTP or HTTP API), injecting a unique 1×1 tracking-pixel URL keyed to `message_id`.
   (Interim: the same dispatch currently routes through Instantly; the swap is one channel adapter in
   `lib/channels/index.ts` → `lib/providers/mta.ts`.)
2. On pixel hit → `POST /webhooks/email/open` → write `events(type=open)` → run §4-C rule engine.
3. Reply detection: receive via the MTA's inbound route / IMAP (and Unipile syncs LinkedIn) →
   `events(type=reply)` → mark contact hot, pause sequence, notify the user.
4. Bounce/complaint: Postal delivery webhooks → `events(type=bounce)` → suppression + per-domain
   bounce/complaint-rate tracking → auto-pause governor (the deliverability engine — design doc §2a).

**B. LinkedIn (Unipile)**
1. User links their LinkedIn account once (Unipile hosted-auth) → store `account_id`.
2. Connect request → on `users.invite.accepted` webhook → `events(type=li_accept)` → send follow-up
   message via `POST /chats/{id}/messages`.
3. Inbound LinkedIn message webhook → `events(type=reply)` → same hot-lead path as email.

**C. Voice drop (Telnyx + AMD) — triggered when an email is SENT to the person (not on open)**
```
TRIGGER: a message row reaches status = sent (channel = email)   ← the send is the trigger
RULE (run per sent contact; optionally after a short delay e.g. +1 day):
  IF contact.consent_voice = true
  AND local_time(contact.timezone) within calling window (e.g. 9am–7pm)
  AND no voice_drops row for this contact in last N days
  AND daily_drop_count < DAILY_CAP                         (cost + safety rail)
  -- optional: AND contact.tier = A  (only if you want to spend less; with $0.03 dials you needn't)
  THEN:
    IF contact.phone IS NULL:
      call ryanclinton "Phone Number Finder — Direct Dials" for the PERSON'S own line
      (name + company, ~$0.03 only if found)
      → Telnyx Number Lookup → set phone_type from carrier.type; SKIP if none found
    IF contact.phone IS NOT NULL AND phone_type IN (fixed line, voip):   (skip mobiles + switchboards)
      enqueue voice_drop ; daily_drop_count++
```
The drop is triggered by **having emailed the person**, not by an open. Everyone you email becomes eligible;
the only filters are a validated direct line (fixed line/VoIP — mobiles + switchboards quarantined), consent,
calling window, and a daily cap. At ~$0.03/dial you can afford to drop on the whole emailed list; keep the
Tier-A line commented-in only if you want to spend even less. Opens still log `events` rows for prioritizing order.

Voice-drop worker:
1. `POST /calls` (Telnyx Call Control) with `answering_machine_detection = "detect_beep"`,
   your number as `from`, a webhook `connection_id`.
2. On `call.answered` → wait. On `call.machine.detection.ended` (machine) → wait for
   `call.machine.greeting.ended`.
3. On `call.machine.greeting.ended` → `call_control_playback_start` with the **cloned-voice audio** for
   this campaign (pre-generate once per sequence with ElevenLabs in the recruiter's own consented voice,
   host the file, store its URL on `campaign_steps.audio_url`) → then hang up. Log `voice_drops(result=machine)`.
   Use a recorded clone, not live TTS, so every drop is identical and natural.
4. If human/no-answer → hang up, log result, do NOT drop. (Optional: schedule a retry.)
5. **Reply to every Telnyx webhook with 200 OK** or it retries.

---

## 5. INTEGRATION SPECS (what Claude Code needs to call)

**Email sender — self-hosted MTA (Postal), the chosen stack.** RecruiterOS sends from **our own
warmed mailboxes on our own domains**, through **Postal** (open-source MTA: HTTP API + SMTP, per-domain
DKIM, suppression, delivery/bounce/complaint webhooks — built for programmatic SaaS sending). We own the
tracking pixel so RecruiterOS owns the open event natively. The full architecture, the 9 infra layers, the
deliverability engine (bounce/complaint/reputation/inbox-placement/abuse-prevention/auto-pause), the cost
model, the risks, and the phased rollout live in
[`design/self-hosted-email-infrastructure.md`](design/self-hosted-email-infrastructure.md). Code home:
`integration/lib/sending/` (registry + DNS + provisioning + Sending tab — Phase-1 shipped) and the
to-build `integration/lib/providers/mta.ts` (Postal send provider) swapped into `lib/channels/index.ts`.
- **Phase-1 already shipped:** domain registry + DKIM + Hetzner DNS automation + server/PTR provisioning +
  DoH verification + the **Sending** admin tab. Env to activate: `HCLOUD_TOKEN`, `HETZNER_DNS_TOKEN`,
  optional `SENDING_DMARC_RUA`, `SENDING_SERVER_TYPE`, `SENDING_LOCATION`, `SENDING_IMAGE`.
- **Still to build:** Postal install + `mta.ts` send provider, the deliverability engine, warm-up.
- **Interim:** Instantly (`lib/providers/instantly.ts`) remains the live email path until `mta.ts` ships.
  Keep it working; do **not** extend it. **Deliverability > having an API** — warm IPs/domains before volume.
- **Do NOT use** Winnr / Mailivery / OutEngine / Zapmail / Mailforge / Infraforge / Smartlead. Dropped.

**Unipile** — base `https://{subdomain}.unipile.com/api/v1`, header `X-API-KEY`.
- **Use for LinkedIn only** (1–2 accounts = the $55 floor). Each linked account is billed, and an email
  inbox counts as an account — so do NOT connect cold inboxes here; cold email goes through our own MTA.
- Link account: hosted auth → returns `account_id`. Send LinkedIn: `POST /chats` / `POST /chats/{id}/messages`.
- Webhooks: subscribe to message + invitation events → your `/webhooks/unipile`.
- Respect provider limits (LinkedIn daily connect/message caps) — Unipile documents these.

**Telnyx** — Programmable Voice / Call Control, bearer API key.
- `POST /v2/calls` with `answering_machine_detection: "detect_beep"`.
- Webhook events to consume: `call.answered`, `call.machine.detection.ended`,
  `call.machine.greeting.ended` (drop the message here), `call.hangup`.
- Commands: `playback_start` (recorded audio) or `speak` (TTS). Buy one number (~$1/mo).

**Apify** — token in `APIFY_TOKEN`. Does three jobs, all pay-per-result on one platform:
1. **Signals** — open-role scrapers per CLAUDE.md §4 ($1/1k jobs).
2. **Discovery** — LinkedIn people/company scraper filtered to the desk's buyer titles → person + `linkedin_url` ($3–10/1k).
3. **Enrichment** — email + **direct-dial/company phone** actors (see below). Charged only on a successful find.

**Enrichment (Apify-native, default)** — feed the person (name + company/domain, or `linkedin_url`) into Apify actors:
- Email: a LinkedIn-URL→email actor (e.g. "Personal/Business Email Finder"), pay-on-success, good + cheap coverage.
- **The person's DIRECT line (NOT mobile, NOT the company switchboard).** **Chosen default: ryanclinton
  "Phone Number Finder — Direct Dials"** (~$0.03/found, waterfall DB→website, name + company/domain input).
  Looked up lazily at the email-sent trigger (§4-C). Fallbacks if coverage is thin: josrade "B2B Waterfall
  Enrichment" (BYO tokens, `maxBudgetUsd` cap) or coladeu "Apollo Person Phone + Email" (strong direct-dials).
  Take only the **person-level** direct-dial field. **Never** use a company/HQ number for a voice drop.
- **Validate every number with Telnyx Number Lookup** (same vendor as your dialer):
  `GET https://api.telnyx.com/v2/number_lookup/{number}` → read `carrier.type` / `portability.line_type`.
  Keep `fixed line` or `voip`; quarantine `mobile`; discard `unknown/invalid`. Cost ~$0.0015–0.007 each — negligible.
- Company main/HQ line: store as `company_phone` for **human-dial reference only** — it is never auto-dialed.
- Everything stays on one `APIFY_TOKEN` (+ your existing Telnyx key) — no separate enrichment vendor.

**Confirm coverage before scaling:** run a 25-contact sample through ryanclinton + Telnyx validation and
check the **cost per correct person-level direct dial**. If the hit rate is weak for your Admin/Healthcare/
Accounting niches, switch to a fallback actor. A cheap actor that returns empty/switchboard rows has
infinite real cost — coverage is what matters, not the $0.03 sticker.

**Enrichment (external, optional)** — only if Apify direct-dial coverage proves too low at volume: Apollo
(strong direct-dials, via the coladeu Apollo bridge actor) or Pipe0/BYO-keys. Same person/`linkedin_url` input.

---

## 5.5 DECISION-MAKER DISCOVERY + ENRICHMENT — the bottleneck, solved

A job post gives you a **company + role**, not a person with contact details. This 3-step pipeline closes
that gap and is the single most important thing to get right:

1. **Discover** (Apify): for each hiring company, run a LinkedIn people/company scraper filtered to that
   desk's buyer titles (CLAUDE.md §1) — Controller/CFO/HR for Accounting, DON/Practice Manager for
   Healthcare, Office/Ops/HR Manager for Admin. Take the best 1–2 matches → `first_name`, `last_name`,
   `title`, **`linkedin_url`** (this URL is the key for everything downstream). (Some job actors also
   return the posting's recruiter — keep as a fallback contact.)
2. **Enrich email** (Apify, from `linkedin_url`): a LinkedIn-URL→email actor, pay-on-success, cheap and
   good coverage. This is what makes the email campaign possible. Do this for the whole qualified list.
3. **Enrich the person's DIRECT line** (Apify, **not mobile, not the switchboard**): for BD you want their
   own direct office line / VoIP. **Default actor: ryanclinton "Phone Number Finder — Direct Dials"** (~$0.03/
   found). This runs **lazily at the email-sent trigger** (§4-C) — when you email someone, you look up their
   direct line. Take only the **person-level** number; never voice-drop a company/HQ line. Then **validate each
   number with Telnyx Number Lookup** (`carrier.type` → keep `fixed line`/`voip`, quarantine `mobile`),
   ~fractions of a cent. A daily cap is the spend rail; confirm hit rate on a 25-contact sample first.

Cost math (illustrative): emails for 1,000 contacts via Apify ≈ low tens of dollars. Person-level direct
dials at ~$0.03/found + ~$0.005 Telnyx validation each — cheap enough to look up for everyone you email,
not just Tier-A (far better economics than the ~10× personal-mobile situation). Coverage is the variable
that matters; if it's thin for your niche, switch to a fallback actor (josrade/coladeu) or Apollo (§5).

---

## 6. BUILD ORDER — minimum working loop first, then layer

1. **Audit** the existing repo (the prompt does this first — see §8). Report stack + what's broken.
2. **One email** through a mailbox to YOUR OWN address, with the tracking pixel. Confirm the send is logged
   as `messages(status=sent)` and an `events(type=open)` row appears when you open it. (Interim, this can go
   through Instantly today; the target is the self-hosted MTA. Opens are tracked for prioritization — they're
   no longer the voice-drop trigger.)
3. **Voice drop on SEND** to YOUR OWN phone: on `messages(status=sent)`, run the §4-C rule — ryanclinton
   direct-dial lookup → Telnyx Number Lookup validation → Telnyx AMD drop. Verify a voicemail lands.
4. **LinkedIn via Unipile**: link one account, send one connect + follow-up, receive the accept webhook.
5. **Discovery + enrichment pipeline (§5.5)**: Apify job pull → Apify decision-maker discovery →
   Apify email enrichment. Confirm real contacts with verified emails land in `contacts`.
6. **Self-hosted email cutover (§5 + design doc):** stand up Postal + DNS/IP/warm-up for the pilot domains,
   build `lib/providers/mta.ts` + the deliverability engine, prove inbox placement via seed tests, then swap
   the `email` channel off Instantly. **Gate: don't ramp volume until placement passes.**
7. **Scheduler + rules engine + approval queue**: real multi-step campaigns, caps, quiet hours, consent.
8. **Import bridge**: load `out/campaign_*.csv` from CLAUDE.md into `contacts` + assign to a campaign.
9. Scale mailbox count and voice volume only after the loop is clean.

Do not build all channels at once. Get email-sent → direct-dial + validation → voice drop working end to end
on test contacts before touching production volume.

---

## 7. COMPLIANCE GUARDRAILS (build in, don't bolt on)

- **Email (CAN-SPAM):** real physical address + working one-click unsubscribe (RFC 8058 List-Unsubscribe) in
  every email; honor `unsub` events immediately (set `consent_email=false`, stop all sequences). On self-hosted
  infra this suppression layer is also your #1 reputation protection — complaints are what both regulators and
  mailbox providers punish.
- **Voice drops (TCPA + state law, US):** target **business direct-dials/landlines only** — the line-type
  validation gate keeps mobiles out, which materially lowers (does not eliminate) risk, since the strictest
  prerecorded-call/auto-dialer rules center on cell phones. Still gate on `consent_voice`, enforce a calling
  window per contact timezone, suppress on opt-out, and cap volume. Prerecorded business calls and some state
  laws still apply. (Not legal advice — confirm your obligations for the states you call into.)
- **LinkedIn:** stay within Unipile's documented per-account limits; one human-owned account per seat.

---

## 8. AUDIT-FIRST CLAUDE CODE PROMPT — paste this in your RecruiterOS repo

> Read RECRUITEROS-BACKEND.md and CLAUDE.md. Do NOT change any code yet.
>
> STEP 1 — AUDIT. Inspect this repository and produce a written report:
> - Stack: language, framework, DB, ORM, where it's hosted, how background jobs run (if at all).
> - Inventory: which of these already exist and their state (working / partial / broken) —
>   contacts/CRM, campaigns, scheduler/queue, webhook receiver, email send, open tracking,
>   the self-hosted sending registry (`lib/sending/`), LinkedIn, voice, any Instantly/Unipile/
>   Telnyx/Apify code.
> - Gap list: exactly what's missing or broken to reach the §6 "minimum working loop"
>   (email sent → direct-dial lookup + Telnyx validation → voice drop), ranked by what blocks the loop first.
> - Confirm the §3 data model against what exists; propose the smallest migration to fit it.
> Stop and show me this report before writing code.
>
> STEP 2 — after I approve, implement ONLY the minimum loop (§6 steps 2–3):
> send one email through a mailbox with a tracking pixel and log it as `messages(status=sent)`; on that
> sent event, look up the person's direct dial (ryanclinton actor), validate it via Telnyx Number Lookup
> (keep fixed line/voip), and fire a Telnyx AMD voice drop (`detect_beep`) to a test phone.
> Add `.env.example` with: email sender creds (interim `INSTANTLY_API_KEY`, or the self-hosted MTA/Postal
> creds + `HCLOUD_TOKEN`/`HETZNER_DNS_TOKEN` once `mta.ts` exists), `UNIPILE_API_KEY`, `UNIPILE_SUBDOMAIN`,
> `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`, `APIFY_TOKEN`. Use test contacts only. Stop and let me test.
>
> STEP 3 — after the loop works, add the §5.5 discovery + enrichment pipeline (Apify jobs → Apify
> decision-maker discovery → Apify email enrichment; direct dials looked up lazily at send per §4-C),
> then Unipile LinkedIn (§4-B), then the self-hosted email cutover (§6 step 6 + the design doc: Postal +
> `mta.ts` + deliverability engine + warm-up, swapping off Instantly), then the scheduler + rules engine +
> approval queue + consent/quiet-hours (§7), then the CSV import bridge.
>
> Rules: build incrementally, one channel at a time; reply 200 OK to every webhook; never exceed
> provider limits; warm IPs/domains before volume; keep all secrets in `.env`; write a quick test for
> each webhook handler.
