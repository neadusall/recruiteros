# Cold Email Setup — everything, end to end

> **⚠️ Status — interim sender.** Instantly is the **current, as-built** email
> sender, and this guide is accurate for it today. The **chosen direction is
> self-hosted email** (Postal MTA + our own domains/mailboxes/warm-up/deliverability)
> — see [`../../design/self-hosted-email-infrastructure.md`](../../design/self-hosted-email-infrastructure.md).
> When that ships, the `email` channel swaps off Instantly; the **Sequences Library /
> Campaign Studio / campaign + email-sequencing structure stays exactly the same** —
> only the sender underneath changes.

Goal: turn on RecruitersOS's **email channel** so campaigns actually send cold
outbound, get replies back into the inbox, and stay deliverable — using your own
warmed sending domains/inboxes orchestrated by **Instantly.ai**.

This is the cold-outbound companion to `email-resend.md` (which only handles
transactional auth email: password resets, magic links). They are SEPARATE
systems with separate keys:

| | Sends | Provider | Key | Doc |
|---|---|---|---|---|
| **Transactional** | password reset, magic link, verify | Resend | `RESEND_API_KEY` | email-resend.md |
| **Cold outbound** | campaign emails to prospects | Instantly | `INSTANTLY_API_KEY` | **this file** |

> Until `INSTANTLY_API_KEY` is set, the email channel still runs end-to-end but
> every send is a **dry-log no-op** (`[instantly:dry] ...` in the logs) — nothing
> leaves the building. That's by design: you can build, demo, and approve drafts
> with zero credentials, and it goes live the moment the key is added. No code
> change, no redeploy of logic.

---

## How cold email works here (the architecture)

RecruitersOS does NOT send email from its own server. The marginal cost and the
deliverability both live in **your own warmed inboxes on throwaway sending
domains**, kept separate from your primary domain to protect its reputation.
Instantly is the orchestration layer that holds those inboxes, runs the drip,
rotates across them, warms them, and reports opens/clicks/replies.

```
 Daily cadence (lib/campaigns/cadence.ts)
   7:00  pull signals            7:15  score/rank/dedupe vs ATS
   7:30  ENRICH  → find + verify a work email (waterfall)
   7:45  LLM DRAFT → Claude writes subject + body per prospect (A/B variants)
   8:30  APPROVAL QUEUE (human edits/kills/approves the batch)
   9:00  PUSH  → sendTouch(channel:"email")
                    │
                    ▼
          lib/channels/index.ts  dispatch("email")
                    │  instantly.addLeads(instantlyCampaignId, [{ email, … , custom_variables:{subject,body} }])
                    ▼
          Instantly campaign  ── sends from YOUR warmed inboxes/domains ──▶  prospect
                    │
   reply ◀──────────┘
     │  Instantly "lead replied" webhook
     ▼
  /api/response/webhook/instantly?ws=<workspaceId>
     → normalize (fromInstantly) → match prospect by email → classify (Claude,
       6-class) → route (SLA/escalate) → pause the lead in Instantly → log to ATS
```

Where each piece lives in code:

| Concern | File |
|---|---|
| Provider client (addLeads, pauseLead, analytics, vitals, inbox-placement, blocklist) | `integration/lib/providers/instantly.ts` |
| Channel dispatch (email → Instantly) | `integration/lib/channels/index.ts` |
| Daily cadence (draft → approve → 9:00 push) | `integration/lib/campaigns/cadence.ts` |
| Per-campaign wiring (`instantlyCampaignId`) | `integration/lib/core/types.ts` (`ChannelConfig`) |
| Email-find + verify waterfall | `integration/lib/channels/index.ts` (`enrich`), `lib/providers/tomba.ts`, RapidAPI/Icypeas rungs |
| Reply ingest (normalize Instantly payload) | `integration/lib/response/ingest.ts` (`fromInstantly`) |
| Reply webhook route + signature check | `integration/app/api/response/webhook/[source]/route.ts`, `lib/providers/signatures.ts` |
| Sequence builder blocks (`em_cold`, `em_followup`) | `assets/js/campaign-studio.js` |
| Cost rates (owner console) | `integration/lib/billing/rates.ts` |

There are **5 parts**. A + C alone make the channel send. B is what makes it
*deliverable*. D links a campaign. E (enrichment) fills in missing emails. F
(replies) closes the loop.

```
  A. Instantly account + API key
  B. Sending domains + inboxes + warmup (the deliverability work)
  C. Put the key on the server + redeploy
  D. Create an Instantly campaign + link it to a RecruitersOS campaign
  E. Email-finding waterfall (so prospects without an email still get one)
  F. Wire the reply webhook (replies flow back into the inbox)
```

================================================================
PART A — Instantly account + API key
================================================================
1. Go to https://instantly.ai and sign up. The sending features need a paid plan
   (Growth ~$37/mo or Hypergrowth ~$97/mo); the cost shows up in the owner
   console as `email_platform_month` (a flat SaaS line, not per-email).
2. In Instantly: **Settings → Integrations → API** (or **Settings → API**).
3. Create an API key. Copy it. Paste into Notepad for a minute.
   KEEP IT PRIVATE — never paste it into chat or commit it to GitHub.

> The key is a v2 Bearer token. The client calls `https://api.instantly.ai/api/v2`
> (`integration/lib/providers/instantly.ts`).

================================================================
PART B — Sending domains, inboxes, and warmup (deliverability)
================================================================
This is the part that decides whether your email lands in the inbox or in spam.
Do NOT send cold mail from `recruitersos.co` — burning your primary domain's
reputation also kills your transactional/auth email.

1. **Buy throwaway sending domains.** 1–3 lookalike domains (e.g.
   `getrecruitersos.com`, `recruitersos-team.com`). ~$8–12/yr each. Instantly can
   buy + auto-configure these for you (Instantly → "Domains" / "Buy domains"),
   which sets the DNS for you — strongly recommended over hand-configuring.
2. **Create inboxes** on each domain (Google Workspace or Microsoft 365 reseller
   mailboxes, ~$2.50/inbox/mo). Reference capacity assumption: **3 inboxes per
   domain**, **~750 safe cold sends per inbox per month** (see
   `DEFAULT_CONSTANTS` in `integration/lib/billing/rates.ts`). Provision enough
   inboxes to carry your monthly volume at that safe rate, then let Instantly
   rotate across them.
3. **DNS auth on each sending domain** (if you didn't let Instantly auto-buy):
   - **SPF** (TXT): `v=spf1 include:_spf.google.com ~all` (or the M365 include)
   - **DKIM** (TXT): the selector record your mailbox provider gives you
   - **DMARC** (TXT `_dmarc`): start `v=DMARC1; p=none; rua=mailto:you@…`
   - A custom **tracking domain** (CNAME) if you use open/click tracking.
4. **Connect each inbox to Instantly** (Instantly → "Accounts" → add the mailbox
   via Google/Microsoft OAuth or IMAP/SMTP).
5. **Turn on warmup** for every inbox and let it ramp for **2–3 weeks** before
   real volume. Instantly's warmup auto-sends/receives to build reputation.
6. RecruitersOS reads these vitals back: `instantly.vitals(accountId)` (bounce +
   warmup status, the nightly health sweep) and `instantly.inboxPlacementTest()`
   (SpamAssassin / inbox-placement). These surface on the integrations health
   view — keep every domain "green" before scaling sends.

================================================================
PART C — Put the key on the server + redeploy
================================================================
1. SSH in:  `ssh root@178.156.170.244`  (root password; nothing shows as you type)
2. `cd /opt/recruiteros` then `git pull`
3. `nano .env.production` — set:
   ```
   INSTANTLY_API_KEY=your_instantly_api_key
   INSTANTLY_WEBHOOK_SECRET=a_long_random_string_you_make_up
   ```
   (`INSTANTLY_WEBHOOK_SECRET` is used in Part F. Generate a random string now,
   e.g. `openssl rand -hex 24`, and keep it for the webhook step.)
4. Save: `Ctrl+O`, Enter, then `Ctrl+X`.
5. Apply: `docker compose up -d --build`  (wait a couple minutes).
6. Verify it's recognized: on the **Integrations / Connected** view, Instantly
   should flip from grey/red to configured (green), driven by
   `providerStatuses()` and `verify()` hitting `GET /campaigns`. If it errors,
   see Troubleshooting.

================================================================
PART D — Create an Instantly campaign + link it to RecruitersOS
================================================================
RecruitersOS pushes leads into a *specific* Instantly campaign per RecruitersOS
campaign. The link is the field `ChannelConfig.instantlyCampaignId`.

1. In Instantly, create a **campaign** (this holds the sending schedule, the
   inbox rotation, and tracking settings). Open it and copy its **campaign ID**
   from the URL (e.g. `…/campaign/<this-id>`).
2. In RecruitersOS, on the campaign's **Connect Channels** step, set the email
   channel's Instantly campaign ID. This writes
   `campaign.channels.instantlyCampaignId`, which the 9:00 push reads
   (`cadence.ts` → `pushApproved` → `sendTouch`).
3. In the **Campaign Studio** sequence builder, add an **Email → Cold email**
   block (`em_cold`, fields: subject + message; merge fields like
   `{{firstName}}`, `{{company}}`, `{{role}}`, `{{signal}}` are supported) and an
   **Email → Follow-up email** (`em_followup`) on a delay. The LLM fills the
   subject/body per prospect at 7:45; the human approves at 8:30.

> What actually gets pushed: `addLeads(instantlyCampaignId, [{ email, first_name,
> company_name, custom_variables: { subject, body } }])`. The subject/body ride as
> custom variables so your Instantly template can render them, OR you keep the
> copy in Instantly and use RecruitersOS only to enroll the lead — either works.

================================================================
PART E — Email-finding waterfall (resolve a work email)
================================================================
The email step only fires for prospects that HAVE an email. The 7:30 enrich step
resolves one cheapest-first (`enrich()` in `lib/channels/index.ts`). Set as many
rungs as you want in `.env.production`; each is optional and skipped if blank:

```
RAPIDAPI_KEY=                 # a cheap RapidAPI email-finder listing
RAPIDAPI_EMAIL_HOST=          # host of that listing
RAPIDAPI_EMAIL_PATH=          # path template: {first} {last} {name} {company} {domain}
ICYPEAS_API_KEY=              # recommended primary (~$0.003/email)
ICYPEAS_API_SECRET=
EMAIL_VERIFY_HOST=            # re-score/verify a found email before sending
EMAIL_VERIFY_PATH=
```

Tomba is also wired as a finder rung (`lib/providers/tomba.ts`,
`tomba.emailFinder(domain, first, last)`). With no rungs set, only prospects who
already carry an email (e.g. from the ATS or a CSV import) will be emailed —
everyone else is simply skipped on the email channel.

Cost reference (owner console, `rates.ts`): `email_find` ~$0.006 blended,
`email_verify` ~$0.001. Verifying before a send protects your warmed inboxes from
bounces.

================================================================
PART F — Wire the reply webhook (close the loop)
================================================================
So that a prospect's reply pauses their sequence and lands in the unified inbox:

1. In Instantly, open **Settings → Integrations → Webhooks** (or the campaign's
   webhook settings) and add a webhook for the **reply / "lead replied"** event.
2. Point it at:
   ```
   https://recruitersos.co/api/response/webhook/instantly?ws=<workspaceId>
   ```
   Replace `<workspaceId>` with the target workspace's id. (Alternatively send it
   as an `x-workspace-id` header.)
3. Set the webhook's signing secret to the **same** `INSTANTLY_WEBHOOK_SECRET`
   you put in `.env.production` (Part C). The route verifies an
   `x-instantly-signature` HMAC-SHA256 over the raw body
   (`lib/providers/signatures.ts`). If the secret is blank the check is skipped
   (dev only) — set it in production.

On each reply the pipeline normalizes it (`fromInstantly`), matches the prospect
by email, classifies it with Claude into one of 6 classes
(interested / OOO / referral / not-now / no / unsub), routes per SLA, calls
`instantly.pauseLead()` so no further drip goes out, and logs a person_event to
the ATS. Unsub/"no" also feed suppression + the Instantly block-list
(`instantly.blocklistAdd()`) so they're never contacted again.

================================================================
Test it
================================================================
1. **Dry-run first (no key):** run a campaign through to 9:00. Logs show
   `[instantly:dry] POST …/leads/bulk` — proves the wiring without sending.
2. **Live test:** with the key set (Part C) and a campaign linked (Part D),
   approve one draft for a prospect whose email is *your own address*, push, and
   confirm it arrives. Then reply to it and confirm the webhook (Part F) flips the
   prospect's status and the reply shows in the inbox.
3. **Connected/Integrations health:** Instantly green, every sending domain warm.

================================================================
Deliverability, limits & safety (keep it landing)
================================================================
- **Warm before volume.** New inboxes: warmup 2–3 weeks, then ramp slowly.
- **Volume ceiling.** ~750 cold sends / inbox / month, ~3 inboxes / domain. Add
  inboxes/domains to scale, don't push a single inbox harder.
- **Separate domains.** Never cold-send from `recruitersos.co`.
- **Verify emails** (Part E) before sending; bounces wreck reputation.
- **Honor opt-outs.** Unsub/hard-no → suppression + Instantly block-list, enforced
  automatically by the reply pipeline.
- **Health sweep.** `vitals()` (bounce/warmup) + `inboxPlacementTest()` run the
  nightly check; investigate any domain that drops out of green.
- **Compliance.** Cold email is regulated (CAN-SPAM / GDPR / CASL): real physical
  address in the footer, working unsubscribe, accurate from/subject, only email
  people with a lawful basis.

================================================================
Costs (what cold email actually costs you)
================================================================
From `integration/lib/billing/rates.ts` (owner console; editable at runtime):

| Driver | Unit cost | Scales |
|---|---|---|
| Mailbox (warmed inbox) | ~$2.50 / inbox / month | capacity |
| Sending domain | ~$1.00 / domain / month | capacity |
| Email find (waterfall) | ~$0.006 / email resolved | per prospect |
| Email verify | ~$0.001 / email verified | per prospect |
| AI personalization (first line) | ~$0.004 / prospect | per prospect |
| AI reply classification | ~$0.001 / reply | per reply |
| Instantly platform | ~$37–97 / month flat (`email_platform_month`) | monthly |

The marginal cost of a send is the **inbox**, not a per-email API fee — that's
why the model is "own warmed inboxes, orchestrated by Instantly."

================================================================
Troubleshooting
================================================================
Check logs: `cd /opt/recruiteros && docker compose logs --tail 80 app`

- `[instantly:dry] …` on every send → `INSTANTLY_API_KEY` not set/loaded. Redo
  Part C (key didn't save, or container not rebuilt).
- `instantly_401` → wrong/expired API key. Recreate it in Instantly (Part A).
- `instantly_404` on push → the `instantlyCampaignId` is wrong or the campaign
  was deleted. Re-copy the ID (Part D).
- Emails send but land in spam → deliverability, not wiring. Warm longer, lower
  daily volume, check SPF/DKIM/DMARC + `vitals()`/inbox-placement (Part B).
- Replies don't pause sequences → webhook not firing or `bad_signature`. Confirm
  the URL + `?ws=` (Part F) and that the Instantly secret matches
  `INSTANTLY_WEBHOOK_SECRET` exactly.
- "No email sent" for many prospects → they have no email; set the finder
  waterfall (Part E).

================================================================
Notes
================================================================
- All keys live ONLY in `/opt/recruiteros/.env.production` on the server —
  gitignored, never committed.
- Templates updated alongside this guide: `integration/.env.example` and
  `.env.production.example` now document `INSTANTLY_API_KEY`,
  `INSTANTLY_WEBHOOK_SECRET`, and the email-finding/verify keys.
- The same Response pipeline also handles LinkedIn (Unipile/SalesRobot) and SMS
  (OS Text) replies — see `../server/integration-architecture.md` for the LinkedIn outreach side.
