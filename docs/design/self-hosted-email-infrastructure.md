# Self-Hosted Email Infrastructure — Build Plan

> **Decision (owner, this thread):** do NOT use Instantly or Winnr. Build our own sending
> stack — domains, mailboxes, MTA(s), warm-up, deliverability monitoring — and plug it into
> the existing RecruiterOS campaign engine. This doc is the concrete build plan, the cost
> model, the real risks, and the phased rollout.
>
> Pairs with [`../INFRASTRUCTURE.md`](../INFRASTRUCTURE.md) §7b/§9.1 (this replaces the
> "keep Instantly" recommendation with the chosen self-hosted direction).

---

## 0. The honest framing (read first)

You said it yourself: *"the SMTP portion is the easiest part; the hard part is maintaining
inbox placement at scale."* That is exactly right, and it drives the whole plan:

1. **The software is free and easy.** Postal/Mailcow/Haraka get you sending in an afternoon.
2. **IP + domain reputation is the actual product.** Unlike Google Workspace/M365 mailboxes
   (which inherit Google/Microsoft's warm reputation), a self-hosted IP starts at **zero trust**
   and must be warmed for weeks before it can carry real volume. This is an **ongoing ops
   function**, not a one-time build.
3. **Target volume (owner-set): 20,000–30,000 emails/month.** This is the real number — ~10×
   smaller than the 500-mailbox spec. The 500/30-server build is sized for 150k–500k/mo and is
   **not needed** unless RecruiterOS goes multi-tenant/agency. At 20–30K/mo the right-sized,
   production-grade footprint is:

   | Component | Right-sized for 20–30K/mo | Why |
   |---|---|---|
   | Mailboxes | **~30–45** | ~750 safe sends/mailbox/mo (start 20–30/day, mature ~40–50/day). 30K ÷ 750 ≈ 40. |
   | Domains | **~10–15** | ~3 mailboxes/domain to isolate reputation (4–5/domain → ~8–10 domains if preferred). |
   | MTA (Postal) VPS | **1–2** | 30K/mo ≈ 1,000 sends/day — trivial for one box; a 2nd only for a separate IP/pool. |
   | Dedicated IPv4 | **1–2** | One well-warmed IP carries this easily; 2 lets you isolate pools. |
   | Monitoring | Postmaster + SNDS + EasyDMARC | free tiers cover this scale |

   **This footprint is the whole build — no pools-of-10, no 500 mailboxes.** The architecture
   below still scales to 500 later, but we build for ~40.
4. **Two real risk areas to design around** (see §6): warm-up-network detection (Google's
   bulk-sender rules + filter sophistication increasingly flag synthetic engagement loops) and
   cold-email compliance (CAN-SPAM / GDPR / CASL).

Net: I'll build this, but the plan front-loads a **pilot that proves inbox placement** before we
spend on 50–100 domains and 30 servers.

---

## 1. Architecture (target)

```
  RecruiterOS app (cadence/campaignFlow)         ← already built
        │  dispatch(touch) via lib/channels
        ▼
  lib/providers/mta.ts  (NEW: our sending provider, swaps Instantly)
        │  pick mailbox by pool + reputation + daily cap
        ▼
  lib/sending/  (NEW: domains · mailboxes · IP pools · warmup state · caps · suppression)
        │  send via SMTP/API
        ▼
  ┌──────────────┬──────────────┬──────────────┐
  │  MTA Pool A  │  MTA Pool B  │  MTA Pool C  │   ← Postal on cheap VPS, dedicated IP each
  │ (Postal)     │ (Postal)     │ (Postal)     │
  └──────┬───────┴──────┬───────┴──────┬───────┘
         ▼              ▼              ▼
     domains+mailboxes (SPF/DKIM/DMARC/PTR per domain)
         │
         ├─▶ Warm-up engine (NEW: inbox↔inbox engagement, gradual ramp)
         └─▶ Deliverability monitor (NEW: ingest Google Postmaster + MS SNDS + DMARC agg)
```

---

## 2. The 9 layers → concrete choices + where they live in code

| Layer (your spec) | Choice / decision | RecruiterOS home |
|---|---|---|
| **1. Domains** | 5–8 to start → 50–100 at scale. Lookalike, NOT the corp domain. Register via Cloudflare/Porkbun (cheap + API for DNS automation). | `lib/sending/domains.ts` (registry + state) |
| **2. DNS** | Per domain: SPF (`v=spf1 include:<mta> ~all`), DKIM 2048-bit, DMARC (`p=none`→`quarantine`→`reject`), PTR/rDNS matching mail host. Automate via Cloudflare API. | `lib/sending/dns.ts` (generate + verify records) |
| **3. Mailboxes** | Self-hosted on the MTA = addresses on our domains at **$0 marginal** (not paid Google seats). ~10/domain. | `lib/sending/mailboxes.ts` |
| **4. SMTP servers** | **Postal** on cheap VPS, 1 dedicated IPv4 each, grouped into pools. Start 1–2; grow to pools of 10. | infra (VPS) + `lib/sending/pools.ts` |
| **5. MTA software** | **Postal** (recommended — open-source, HTTP API + SMTP, per-domain DKIM, suppression, webhooks; built for programmatic SaaS sending). Mailcow = human mailboxes (overkill). Haraka = max flexibility, more DIY. PowerMTA = enterprise/$$$. | `lib/providers/mta.ts` → Postal API |
| **6. Warm-up** | Gradual ramp + real engagement. Pooled inboxes seed-list each other on an organic-looking schedule. **(Risk — §6.)** | `lib/sending/warmup.ts` + scheduler |
| **7. Monitoring** | Google Postmaster Tools + Microsoft SNDS (both free) + DMARC aggregate reports (EasyDMARC free tier). Ingest → owner dashboard. Auto-pause a mailbox/IP when spam-rate spikes. | `lib/sending/reputation.ts` + owner view |
| **8. Campaign platform** | **Already built.** Sequences (`lib/sequences`), cadence runner (`lib/campaigns/cadence.ts`), state machine (`lib/signals/campaignFlow.ts`), merge vars, per-mailbox caps. We extend caps/rotation, not rebuild. | existing + cap/rotation logic |
| **9. AI layer** | **Already built.** Signals → research → Claude personalization → queue. | existing (`lib/signals`, `lib/sourcing`, Anthropic) |

**The build is really layers 1–7.** Layers 8–9 exist; we wire the new sender under them by
swapping the `email` channel in [`lib/channels/index.ts`](../../integration/lib/channels/index.ts)
from Instantly to `lib/providers/mta.ts`.

---

## 2a. The deliverability engine — where ~70% of the real engineering goes

> Owner's framing (correct): *"The technically challenging part is not sending email. It's
> maintaining deliverability and reputation over time. The companies that survive — Instantly,
> Smartlead, Winnr — invest heavily in bounce management, complaint monitoring, abuse prevention,
> reputation tracking, and inbox-placement testing."*

Sending (the Postal integration) is a few days. **This is the rest of the project**, and it is
ongoing, not one-time. It is the actual moat. Treat every item below as a first-class subsystem,
each metered into the same owner dashboard and each able to **auto-pause** a mailbox/domain/IP:

| Capability | What it does | Module | Signal it acts on |
|---|---|---|---|
| **Pre-send list hygiene** | Verify every address (MX/SMTP) + drop catch-all/role/disposable BEFORE it touches a warmed inbox. Bounces are the #1 reputation killer. | `lib/sending/verify.ts` (reuse `email_verify` waterfall) | bounce rate ↓ |
| **Bounce management** | Parse Postal delivery/bounce webhooks; hard-bounce → permanent suppression; soft-bounce → backoff+retry; per-domain bounce-rate tracking. | `lib/sending/bounces.ts` + suppression | hard/soft bounce % |
| **Complaint / FBL handling** | Ingest feedback-loop + spam complaints (Postmaster, SNDS, ARF); one complaint → instant global suppress; per-mailbox complaint-rate ceiling. | `lib/sending/complaints.ts` | complaint rate (Google ceiling 0.3%) |
| **Reputation tracking** | Daily pull Google Postmaster (domain/IP reputation, spam rate, auth %) + Microsoft SNDS (complaint/trap rate); trend per domain + IP + pool. | `lib/sending/reputation.ts` | reputation tier, spam % |
| **Inbox-placement testing** | Seed accounts across Gmail/Outlook/Yahoo; send before/early in each campaign; measure **inbox vs spam vs promotions** per provider; block scale-up until placement passes. | `lib/sending/seedtest.ts` + seed inboxes | placement % by provider |
| **Abuse prevention / throttling** | Per-mailbox daily caps + ramp curve, per-IP hourly throttle, pool isolation, kill-switch on spam-trap hits; never let one bad list sink a pool. | `lib/sending/caps.ts` + `pools.ts` | trap hits, send velocity |
| **Auth + alignment enforcement** | Verify SPF/DKIM/DMARC alignment per domain continuously; refuse to send from a domain whose DNS/auth drifted. | `lib/sending/dns.ts` | auth pass %, DMARC alignment |
| **Auto-pause governor** | The supervisor: any metric over threshold (bounce > 2%, complaints > 0.1%, reputation drop, trap hit) → pause the offending mailbox/domain/IP and alert, before the whole pool burns. | `lib/sending/governor.ts` | all of the above |

**Compliance is part of deliverability, not separate** (complaints are what regulators *and*
mailbox providers punish): every send carries a real physical address + one-click List-Unsubscribe
(RFC 8058), honored instantly via `suppression.ts`. CAN-SPAM / GDPR / CASL.

This table — not the Postal hookup — is the work. It's why a pilot must **prove placement** (via
`seedtest.ts`) before we spend on 50–100 domains.

---

## 3. New code (`integration/lib/sending/` + provider)

> **Built so far (shipped — full pipeline in code):**
> - **Foundation:** registry + DNS automation + Hetzner provisioning + the **Sending** admin tab.
>   Feed domains → DKIM generated, Hetzner DNS zone created, full record set
>   (A/MX/SPF/DKIM/DMARC/tracking/return-path) written, PTR set on the IP, DoH verification.
> - **Send path:** Postal install via cloud-init on the provisioned box (`postal.ts`), the MTA send
>   provider (`lib/providers/mta.ts`) with caps/rotation, wired into `lib/channels` (swaps Instantly
>   when `SENDING_EMAIL_PROVIDER=mta`, falls back during warm-up).
> - **Deliverability engine (§2a):** suppression, Postal webhook (`/api/sending/webhook`) →
>   bounce/complaint ingest, the auto-pause **governor** (bounce>2% / complaint>0.1%), reputation
>   ingestion (SNDS real, Postmaster seam), seed-list **inbox-placement testing**.
> - **Warm-up:** per-mailbox ramp + graduation, daily tick (`runSendingDaily`), optional synthetic
>   engagement gated behind `SENDING_WARMUP_ENGAGE=1`.
>
> Files: `lib/sending/{types,store,dkim,dns,provision,postal,caps,governor,ingest,reputation,seedtest,warmup,daily,index}.ts`,
> `lib/sending/providers/{hetznerDns,hetznerCloud}.ts`, `lib/providers/mta.ts`,
> `app/api/sending/{route,webhook}.ts`, `renderSending` in `assets/js/command.js`.
>
> **Env to activate:** `HCLOUD_TOKEN`, `HETZNER_DNS_TOKEN` (provisioning); `SENDING_EMAIL_PROVIDER=mta`
> (route email through the MTA); Postal host/key pasted per server in the UI; optional `SNDS_KEY`,
> `POSTMASTER_*` (reputation), `SENDING_WEBHOOK_SECRET`, `SENDING_WARMUP_ENGAGE=1`,
> `SENDING_DMARC_RUA`, `SENDING_SERVER_TYPE` (cx22), `SENDING_LOCATION` (ash), `SENDING_MAILBOX_CEILING` (50).
> One-time manual step per domain: point the registrar's nameservers at Hetzner (UI shows them).
>
> **Remaining real-world wiring (needs live creds/infra, not more code):** finish Postal's OAuth-y
> bits — register each domain in Postal with our DKIM key (UI surfaces the key + commands), and the
> Postmaster OAuth token exchange.
>
> **Seed connector + staff portal + safeguards (shipped 2026-06-12):** staff self-register the
> Gmail/Outlook/Yahoo inboxes they create at `/seed-portal.html?token=…` (token-guarded by
> `SENDING_SEED_PORTAL_TOKEN`, no per-submission limit). The server captures an **app password**, runs
> `verifySeedLogin` (real IMAP login) so the connector is proven, and from then on the SERVER holds the
> IMAP/SMTP session — nothing stays logged in on a laptop. Long-term safeguards now built in:
> - **Encryption at rest** — app passwords are AES-256-GCM encrypted via `lib/sending/secrets.ts`
>   (`SENDING_SECRET_KEY`); legacy plaintext still decrypts; GET never returns the secret.
> - **Daily self-heal** — `runSeedMaintenance()` (in `/api/sending/cron`) re-verifies every seed login
>   each tick, so a locked account / revoked app password shows up as "failing" in the console.
> - **Automatic placement reader** — `readPlacement` + `readDuePlacements` connect to the seed inboxes
>   and record inbox/spam/missing for pending probes (closes the old manual gap). Manual buttons:
>   `reverify-seeds`, `read-placements`.
> - **Readiness gate** — GET returns `seedSummary` (counts by provider, connected/drivable/failing,
>   `warmupEngageOn`, `credsEncrypted`, `portalEnabled`) so the console shows whether warming can run.
> - **OAuth seam** — `SeedAccount.authMethod` reserves the future Gmail/MS OAuth path (app passwords
>   are being deprecated by both); not built yet — the one genuine remaining long-term item.


- `lib/providers/mta.ts` — implements the send interface `lib/channels` already dispatches to; talks to Postal's API; returns message id + accepts delivery/bounce/complaint webhooks.
- `lib/sending/domains.ts` · `dns.ts` · `mailboxes.ts` · `pools.ts` — the **infrastructure registry** (what exists, its DNS/auth state, which pool/IP, health). Snapshot-persisted like the rest of the app.
- `lib/sending/caps.ts` — per-mailbox daily cap + ramp curve; pick-next-mailbox by pool, reputation, remaining cap; domain/IP rotation.
- `lib/sending/warmup.ts` — the warm-up engine + its schedule (gated, ramped — see §6).
- `lib/sending/reputation.ts` — ingest Postmaster/SNDS/DMARC; compute per-domain/IP health; trip auto-pause.
- `lib/sending/suppression.ts` — global unsubscribe/bounce/complaint suppression (compliance + reputation).
- `app/api/sending/*` — admin/owner routes (provision domain, verify DNS, view health) + Postal webhook receiver.
- A **"Sending" tab** (owner/admin) — domains, mailboxes, pools, warm-up status, reputation, caps.

---

## 4. Cost model

### 4a. Target build — 20–30K emails/mo (THE plan)
~30K sends/mo · ~40 mailboxes · ~12 domains · 1–2 MTA VPS · 1–2 IPs.

| Item | Qty | Unit | Monthly |
|---|---|---|---|
| Sending domains | 12 | ~$10/yr | ~$10 |
| Mailboxes (self-hosted on Postal) | 40 | $0 | $0 |
| Postal MTA VPS | 1–2 | $15 | $15–30 |
| Dedicated IPv4 | 1–2 | ~$2 | ~$2–4 |
| Monitoring (Postmaster/SNDS/EasyDMARC) | — | free tier | $0 |
| **Total sending infra** | | | **~$30–45/mo** + setup labor |

Add the per-prospect variable from [`../INFRASTRUCTURE.md`](../INFRASTRUCTURE.md) §8 (~$0.011
enrichment+AI). 30K sends ÷ 3 touches ≈ 10K prospects → ~$110/mo variable. **All-in ≈ $150–200/mo.**

> Compare: ~40 Google reseller inboxes via Instantly's model ≈ **$100/mo** in seats + Instantly's
> ~$37–97/mo platform fee. Self-hosted is cheaper *and* fully owned — the trade is the reputation/ops
> work you now own (manageable at this scale: ~10 min/day with the governor + dashboard).

### 4b. Future scale only — 500-mailbox / 30-server (~150k–500k sends/mo, NOT the current plan)
Documented for reference; only relevant if RecruiterOS goes multi-tenant/agency. **Skip for now.**

| Item | Qty | Unit | Monthly |
|---|---|---|---|
| Sending domains | 50–100 | ~$10/yr | ~$42–83 |
| Mailboxes (self-hosted) | 500 | $0 | $0 |
| MTA VPS (3 pools × 10) | 30 | $15 | ~$450 |
| Dedicated IPv4 | 30+ | ~$2 | ~$60 |
| DMARC/monitoring tooling | — | — | ~$40–100 |
| **Total infra** | | | **~$600–700/mo** |
| **+ Ongoing deliverability ops** | | | **a real part/full-time function** |

> Compare: 500 Google reseller inboxes ≈ **$1,250/mo**. Self-hosted roughly **halves** the
> cash cost at scale — *if* you can hold inbox placement. The labor to do so is the hidden cost.

**Variable cost is unchanged** from the main doc (~$0.011/prospect enrichment+AI). Self-hosting
changes only the **sending** line — from per-inbox SaaS to owned infra + ops.

---

## 5. Phased rollout (for the 20–30K/mo target)

- **Phase 0 — Stand up + prove placement.** ~12 domains, 1 Postal server, 1 dedicated IP, start with ~10–15 mailboxes. Full SPF/DKIM/DMARC/PTR. 2–4 week IP/domain warm-up ramp. Google Postmaster + SNDS live. Send a small real campaign through `seedtest.ts`, measure inbox vs spam. **Gate: don't ramp volume until placement passes.**
- **Phase 1 — Wire into the app + grow to ~40 mailboxes.** `lib/providers/mta.ts` + `lib/sending/*` registry + caps/rotation; swap the `email` channel from Instantly → MTA; Postal webhooks → bounce/complaint/suppression; warm-up engine; reputation ingestion + auto-pause governor; Sending admin tab. Ramp to the full ~40 mailboxes as warm-up completes. **This is the finish line for 20–30K/mo.**
- **Phase 2 — (Future, only if volume 5×+.)** Pools-of-10, more IPs/domains, per-pool isolation, automated DNS provisioning. Not needed for the current target.

---

## 6. Risks to design around (not blockers — design choices)

1. **Warm-up-network detection.** Synthetic A→B "reply/star/mark-important/remove-spam" loops are a known pattern; Google's Feb-2024 bulk-sender rules + ongoing filter ML increasingly detect and discount them, and large warm-up pools have been penalized. **Design:** favor a *gradual, organic-looking* ramp and genuine engagement over high-volume synthetic loops; keep per-IP volume growth slow; never treat warm-up as a substitute for real positive reply behavior. Treat the synthetic-engagement layer as reputation-*assisting*, not reputation-*guaranteeing*, and accept it carries Gmail/Outlook ToS gray-area risk.
2. **Cold-email compliance.** Cold recruiting email is regulated: **CAN-SPAM** (real physical postal address, working one-click opt-out, no deceptive from/subject), **GDPR/CASL** for EU/CA recipients. **Design:** a suppression + unsubscribe + sender-identity layer is mandatory, not optional — it also protects reputation (complaints are the #1 reputation killer).
3. **Cold-IP reputation ramp.** Self-hosted IPv4 starts at zero trust; expect **2–4 weeks** of warm-up per IP before meaningful volume, and IPv4 is increasingly scarce/justified at acquisition. **Design:** treat IPs as slow-to-provision assets; keep spares warming ahead of need.
4. **Single-blacklist blast radius.** One bad mailbox/domain can taint a shared IP. **Design:** pool isolation + auto-pause on spam-rate spike (built into `reputation.ts`) so one bad actor doesn't sink a pool.
5. **Ops burden = the real cost.** Someone watches Postmaster/SNDS/blacklists daily. **Design:** the Sending dashboard + auto-pause exist to make this a 15-min/day job instead of a fire drill — budget for it regardless.

---

## 7. Recommended first build step

Start **Phase 0 pilot** + the **`lib/sending/` registry and `lib/providers/mta.ts` against Postal**
in parallel — because the registry/provider is needed regardless of scale and is safe to build now,
while you (or I, with infra access) stand up the first Postal box + DNS for the pilot domains.

Open question for you: **pilot scale first (recommended), or build straight for the 500-mailbox
target?** And do you want me to start with the **software side** (provider + `lib/sending` + Sending
tab) while the **VPS/DNS/Postal** infra is provisioned separately?
