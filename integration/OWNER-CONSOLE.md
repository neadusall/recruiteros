# Owner Console (private back office)

A single-operator back office for **you, the owner** — not for recruiters, not for
workspace admins. It tracks everything from a cost standpoint across **both**
operating systems (Recruiting OS and Business Development OS, which share one
infrastructure), recommends what to charge, and gives you full control over every
account (see everyone, hard reset, delete).

It is **hidden** (no link anywhere in the app, `noindex`) and **secure**
(server-side owner-email gate on every call).

---

## How to reach it

1. **The link:** `https://app.recruitersos.co/owner-console.html`
   (locally: `/owner-console.html` served by the Next app, or open the file).
   It is not linked from any nav and is marked `noindex,nofollow`.

2. **Log in as the owner.** Set `OWNER_EMAIL` in the environment to your email
   (`neadusall@gmail.com` by default; comma-separate for more than one). Sign in
   through the normal `/login.html` with that account, then open the console link.

3. **Everyone else gets a 404.** `requireOwner()` wraps every `/api/owner/*`
   route: a valid session is not enough — the signed-in email must be on the
   allow-list, or the API returns `404 not_found` (it won't even confirm the
   console exists). The page reveals nothing until the API confirms you.

> Want it even more obscure? It's a static file — rename `owner-console.html` to
> anything (e.g. `owner-9f3a2c.html`) and the same gate still applies. The real
> lock is `OWNER_EMAIL`, server-side.

---

## What it tracks (everything, from a cost standpoint)

Every cost driver in the platform, with its **real unit cost** (not a price):

| Category | Driver | Default cost | Scales with |
|---|---|---|---|
| Enrichment | Email find (waterfall) | $0.006 / email | unique prospects |
| Enrichment | Email verification | $0.001 / email | unique prospects |
| Enrichment | Mobile find (cheap rung, gated/unverified) | $0.02 / mobile | unique prospects |
| Enrichment | Landline / direct-dial find (cheap rung) | $0.015 / landline | unique prospects |
| Enrichment | Mobile premium reveal (realistic source: Prospeo) | $0.39 / mobile | unique prospects |
| Enrichment | Landline premium reveal | $0.10 / landline | unique prospects |
| Enrichment | Phone classify mobile vs landline (Telnyx) | $0.0025 / number | unique prospects |
| Enrichment | Reverse lookup, number→owner (Trestle, optional) | $0.07 / lookup | unique prospects |
| Sending | Mailbox | $2.50 / inbox / mo | send volume |
| Sending | Sending domain | $1.00 / domain / mo | send volume |
| AI | Personalization (first line) | $0.004 / prospect | unique prospects |
| AI | Reply classification | $0.001 / reply | replies |
| Signals | Public hiring/intent signals | **$0** (free sources) | — |
| LinkedIn | Automation seat (Alfred internal) | **$0** | per account |
| Messaging | SMS segment / voice minute (Telnyx) | $0.004 / $0.007 | only if used |
| Infra | Hosting/db/monitoring (allocated) | $4.00 / account / mo | per account |

These are the shipped defaults in `lib/billing/rates.ts`. **Every one is editable
live** from the console's *Cost model* tab (persisted, no redeploy) so the pricing
re-bases the instant you change a number.

**Phone enrichment — the verified recommendation (deep research, May 2026).** Mobile
and landline are tracked as **separate fields** (`mobilePhone`, `landlinePhone`),
each with its own waterfall rung. Three distinct jobs, three different best tools:

- **FIND** a number (job A): there is **no trustworthy cheap RapidAPI listing** —
  every public hit-rate/accuracy benchmark for cheap scrapers was refuted under
  verification. The realistic reliable source is a premium finder: **Prospeo Mobile
  Finder ~$0.39/mobile** (`POST api.prospeo.io/mobile-finder`, LinkedIn URL or
  name+company), Datagma ~$0.33–0.49, Apollo ~$1.60. Any cheap RapidAPI rung you
  wire in should be treated as unverified and **gated behind classify**, not trusted.
- **CLASSIFY** mobile vs landline (job B) — *this is how the two fields get split
  cleanly and cheaply*: **Telnyx Number Lookup ~$0.0025/number** (line-type), which
  reuses the Telnyx integration you already have and programmatically returns
  mobile/landline/VoIP + carrier. Twilio Lookup Line Type ($0.008) is the alternative.
  Don't trust a scraper's own "mobile/landline" label — classify with Telnyx.
- **REVERSE** lookup (job C, optional): **Trestle Reverse Phone ~$0.07/query** (number
  → owner name + line type + alternate numbers), on RapidAPI or direct. For inbound
  caller-ID and list cleaning.

So the stack is: **Prospeo (find) → Telnyx (classify into mobile vs landline) →
Trestle (reverse, optional)**, with an optional cheap RapidAPI find rung in front,
always gated by the Telnyx classify step.

**Classify is LIVE-wired and metered.** During enrichment (`lib/channels/enrich`),
any known number with no line type is run through Telnyx Number Lookup
(`lib/signals/phoneClassify.ts`), routed into `mobilePhone` vs `landlinePhone`, and
**each lookup is written to the cost ledger** (category `enrichment`, source
`telnyx`, type `phone_classify`) — so it shows up in the console's Spend tab and on
the account's cost-by-category, exactly like every other cost. It is a no-op (charges
nothing) until `TELNYX_API_KEY` is set. Honest caveat: because no defensible cheap
hit-rate exists, the true cost *per usable mobile* can't be pinned precisely — budget
around the premium **~$0.39/mobile** found, plus **~$0.0025** to classify it. Email
stays the workhorse (80–95% coverage, ~$0.007); phone is opt-in for a reason.

The **usage ledger** (`lib/billing/ledger.ts`) is an append-only record of every
cost event, per account, per operating system. Background workers report into it
via `POST /api/owner/usage/ingest` (owner session or `USAGE_INGEST_KEY`). The
*Spend* tab rolls it up by category, provider, motion, and account.

---

## What to charge (the recommendation)

The dominant variable cost is **enrichment**, exactly as expected. Sending cost is
the warmed-inbox count, not a per-email API fee (you send through the customer's
own mailboxes). Signals are free.

**Assumptions** (all tunable in the console): 3-step sequences (so unique
prospects ≈ emails ÷ 3), 750 safe sends per warmed inbox per month, email find +
verify at ~$0.007 blended, AI personalization at $0.004/prospect, 85% target gross
margin, phone OFF by default.

### Recruiting OS

| Emails / mo | ~Prospects | Inboxes | Our cost / mo | **Recommended price** | Gross margin |
|---|---|---|---|---|---|
| 5,000 | ~1,667 | 7 | ~$43 | **$299** | ~86% |
| 10,000 | ~3,333 | 14 | ~$81 | **$549** | ~85% |
| 20,000 | ~6,667 | 27 | ~$154 | **$999** | ~85% |

### Business Development OS

Same infrastructure, same cost — but a BD seat that lands a new client is worth
more, so it carries a **1.3× willingness-to-pay multiplier**:

| Emails / mo | Our cost / mo | **Recommended price** | Gross margin |
|---|---|---|---|
| 5,000 | ~$43 | **$399** | ~89% |
| 10,000 | ~$81 | **$699** | ~88% |
| 20,000 | ~$154 | **$1,299** | ~88% |

**Why these numbers hold up against the market:** RecruiterOS replaces a stack
(Clay-style enrichment $149-800/mo + Instantly-style sending $37-358/mo + Apollo
$49-119/user + an AI layer). Bundling that into one "operating system" at
$299-1,299/mo is well inside what those tools cost separately, while leaving you
85-89% gross margin. The console's **Pricing** tab shows this table live and has a
calculator for any custom volume, sequence length, phone on/off, and margin.

> The exact published numbers are a business call — the console gives you the
> cost floor and a defensible recommendation; nudge the margin slider to taste.

---

## Full account control

The **Accounts** tab lists every workspace with members, plan, monthly price,
window cost, and gross margin. Click any row for a detail drawer:

- **See everything:** members + roles + emails, created/last-active, active
  sessions, price, cost by category, data on file (prospects, campaigns, LinkedIn
  accounts, sending domains, API keys, content assets), and recent cost events.
- **Billing:** set the monthly price (drives margin), tier label, and notes.
- **Suspend / unsuspend:** suspending kills every live session and locks login
  until you reverse it.
- **Revoke sessions:** force re-login everywhere.
- **Reset password:** issue a fresh temp password per member (shown once).
- **Hard reset:** composable — purge ALL data (prospects, campaigns, content,
  sending infra, usage ledger), reset passwords, suspend, revoke sessions, in any
  combination. Irreversible.
- **Delete account permanently:** removes the workspace, its users, and all data.

---

## API surface (all owner-gated)

```
GET    /api/owner/overview?window=today|7d|30d|all     business pulse: MRR, cost, margin
GET    /api/owner/accounts?window=...                  every account, fully joined
GET    /api/owner/accounts/:id?window=...              full detail + recent cost events
PATCH  /api/owner/accounts/:id                         { monthlyPriceUsd?, tier?, notes?, suspended? }
DELETE /api/owner/accounts/:id                         delete account + all data
POST   /api/owner/accounts/:id/reset                   { purgeData?, resetPasswords?, suspend?, revokeSessions?, deleteAccount? }
GET    /api/owner/costs                                rate catalog + constants (with overrides)
PATCH  /api/owner/costs                                { rateOverrides?, constants? }
GET    /api/owner/pricing?emails=&steps=&phone=&ai=&margin=&motion=   preset table + live calculator
GET    /api/owner/spend?window=...                     unified spend rollup
POST   /api/owner/usage/ingest                         append a cost event (owner or USAGE_INGEST_KEY)
```

## Files

- `lib/billing/rates.ts` — cost-rate catalog + pricing constants (the defaults above)
- `lib/billing/pricing.ts` — cost estimator + price recommender + preset table
- `lib/billing/ledger.ts` — append-only usage/cost ledger + rollups
- `lib/owner/index.ts` — owner-email gate, joined account view, hard reset
- `lib/owner/store.ts` — per-account price/tier/notes (margin source)
- `lib/owner/config.ts` — runtime rate/constant overrides (persisted)
- `app/api/owner/*` — the routes above, each behind `requireOwner()`
- `owner-console.html` + `assets/js/owner.js` + `assets/css/owner.css` — the UI

State persists to Postgres when `DATABASE_URL` is set (same snapshot mechanism as
auth); in-memory otherwise.
