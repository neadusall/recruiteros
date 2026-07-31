/**
 * RecruitersOS · Owner · Spend register (OWNER ONLY)
 *
 * THE master record of what this business pays for: every subscription, every server,
 * every domain, every one-time purchase and credit top-up, in one editable list. The
 * usage ledger (lib/billing/ledger.ts) already captures METERED cost per call; it cannot
 * see a $150/mo RapidAPI plan, a Hetzner invoice, or a $9 domain renewal, because those
 * never pass through the engine. This module holds that other half, so the console can
 * finally answer "what is the true monthly burn" instead of "what did the API calls cost".
 *
 * WHY IT IS EDITABLE: most of these figures exist only on a vendor invoice, so the store
 * ships a SEED of everything the running system can prove it uses (see SEED below) and
 * the owner corrects amounts in place. Seeded rows with no known price arrive at 0 and
 * flagged `needsAmount`, so the dashboard asks for a number rather than inventing one.
 *
 * LIVE BINDING: each row can name a RapidAPI host, a ledger `source` tag, and the env
 * keys that wire it. attachLive() joins those against the real quota meter, the real
 * ledger, and the real credential store, which is what turns a static price list into
 * "this $150 subscription has had zero traffic for 30 days".
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import { spendRollup, type SpendWindow } from "../billing/ledger";
import { getRapidQuota, getRapidQuotaHistory, type RapidQuotaSnapshot } from "../sourcing/rapidQuota";
import { lookupDomains, daysUntil } from "./domainLookup";

/* ============================ types ============================ */

/** How a line item recurs. `metered` rows are pass-throughs: their real number comes
 *  from the usage ledger, not from `amountUsd`. */
export type BillingType = "monthly" | "annual" | "one_time" | "credit" | "metered";

export type SpendCategory =
  | "search"      // SERP + job feeds
  | "people"      // profile / people-search / phone data
  | "ai"          // LLM + voice
  | "messaging"   // SMS + voice minutes
  | "email"       // sending, verification, mailboxes
  | "infra"       // servers, storage, bandwidth
  | "domain"      // domains and DNS
  | "software"    // ATS and other SaaS seats
  | "other";

export type SpendStatus = "active" | "cancelled";

export interface SpendLink {
  /** RapidAPI listing host, joins this row to the live quota meter. */
  rapidHost?: string;
  /** Ledger `source` tag, joins this row to real metered cost. */
  ledgerSource?: string;
  /** Env keys that must be present for this vendor to actually be reachable. */
  envKeys?: string[];
  /** Connected-hub integration id, joins to per-workspace credential status. */
  integrationId?: string;
  /** OS Text phone-accuracy `source` tag, joins this vendor to what its data DID:
   *  cell-check pass rate, delivery, replies, wrong-number rate. */
  outcomeSource?: string;
}

export interface SpendItem {
  id: string;
  /** Vendor as it appears on the invoice, e.g. "RapidAPI", "Hetzner". */
  vendor: string;
  /** The specific thing bought, e.g. "JSearch (Ultra)". */
  label: string;
  category: SpendCategory;
  billing: BillingType;
  /** Per-period for monthly/annual; total paid for one_time/credit; ignored for metered. */
  amountUsd: number;
  /** ISO date the subscription started or the purchase was made. */
  at: string;
  status: SpendStatus;
  /** One line on what this buys the business. */
  purpose?: string;
  /** How the line item actually builds the business: which motion it feeds and what
   *  disappears if it is switched off. This is the column that makes a cancel-or-keep
   *  decision possible without reverse-engineering the codebase. */
  impact?: string;
  link?: SpendLink;
  /** true once the figure came from a real invoice rather than an estimate. */
  verified?: boolean;
  /** Seeded with no known price: the dashboard prompts for it instead of showing $0. */
  needsAmount?: boolean;
  /** Bought outright, once: the licence does not renew, so no charge is ever due again.
   *  A lifetime row costs $0/mo forever and has NOTHING to receipt, which is different
   *  from a subscription whose receipt merely has not arrived. The reconciler reports it
   *  as settled instead of chasing a missing invoice, and stops the moment the vendor is
   *  put back on a paid plan (buying credits again makes it a normal credit row). */
  lifetime?: boolean;
  notes?: string;
  /** The product name the VENDOR's own account page prints for this row, e.g. their
   *  "KVM VPS - 8GB" against our "Mailcow mail server (8GB)". Recorded the first time a
   *  plan check matches or a human confirms the pairing, so the vendor can be re-read
   *  every month without asking again. */
  vendorLabel?: string;
  /** The vendor's own id for the service, which survives a product rename. */
  vendorRef?: string;
  /** Came from the shipped seed rather than being hand-entered. */
  seeded?: boolean;
  createdAt: string;
  updatedAt: string;

  /* ---- domain rows only: the registration lifecycle ----
     `at` carries the purchase date and `amountUsd` the price paid, exactly as for any
     other one-time buy. These add what a domain uniquely needs: when the registration
     lapses, what the renewal costs (which is rarely the promotional first-year price),
     and whether it renews on its own. registeredAt/expiresAt/registrar are refreshed
     automatically from the public registry, so only the money fields are hand-entered. */
  /** Registrable name, e.g. "lumerecruit.com". Presence marks this row as a domain. */
  domain?: string;
  /** Registry-reported first registration date, ISO. */
  registeredAt?: string;
  /** Registry-reported expiry, ISO. Drives the renewal warnings. */
  expiresAt?: string;
  /** Registrar of record, from the registry. */
  registrar?: string;
  /** What the NEXT renewal costs, when it differs from the price first paid. */
  renewalUsd?: number;
  /** Whether the registrar will renew it without intervention. */
  autoRenew?: boolean;
  /** Which mailbox provider serves this domain, in words: "Sending.ac", "Google Workspace". */
  mailProvider?: string;
  /** How many inboxes sit on it. A domain carrying 50 is not the same asset as one
   *  carrying 1, though both renew at the same price. */
  mailboxCount?: number;
  /** When the registry lookup last succeeded, ISO. */
  registryCheckedAt?: string;
  /** Last registry lookup failure, kept for display. */
  registryError?: string;
}

/* ============================ seed ============================ */

/**
 * Everything the live system can be shown to depend on, as of the 2026-07-30 audit.
 * Prices marked `verified` were read off the vendor's own billing page; the rest arrive
 * at 0 with `needsAmount` so nothing here is a made-up number.
 *
 * The five RapidAPI rows carry their real plan prices from the RapidAPI billing
 * dashboard, and their `rapidHost` binds each one to the live credit meter.
 */
type SeedItem = Omit<SpendItem, "id" | "createdAt" | "updatedAt" | "seeded">;

const SEED: SeedItem[] = [
  /* ---- RapidAPI subscriptions (prices verified on the RapidAPI billing dashboard) ---- */
  {
    vendor: "RapidAPI", label: "JSearch (Ultra)", category: "search", billing: "monthly",
    amountUsd: 75, at: "2026-06-24", status: "active", verified: true,
    purpose: "Paid job-posting feed: every company hiring becomes an In-Market lead and a Hire Signals trigger.",
    impact: "Top of the BD funnel. A company posting a role is the buying signal the whole Business Development motion is built on, so this feed is what the outreach engine has to talk about. Without it the In-Market pool falls back to free sources and their few-hundred-company ceiling.",
    notes: "Ultra plan, 50,000 requests/month, verified live. TARGETED-ONLY by design: the background rotation is off unless RAPID_JOBS_AUTOPILOT=1, so the plan only bills when someone runs a Targeted Search. Zero searches means zero requests against a plan that still charges in full.",
    link: { rapidHost: "jsearch.p.rapidapi.com", envKeys: ["RAPID_JOBS_KEY"], ledgerSource: "rapidapi" },
  },
  {
    vendor: "RapidAPI", label: "Real-Time Web Search", category: "search", billing: "monthly",
    amountUsd: 150, at: "2026-07-01", status: "active", verified: true,
    purpose: "Paid Google SERP for decision-maker naming (the site:linkedin.com/in X-ray), bought to replace the throttled free scrapers.",
    impact: "The naming bottleneck. A company lead is worth nothing until it has a named decision maker attached, and that step currently runs on free scrapers measured at a 0% success rate. This is the piece that turns company signals into people you can actually contact.",
    notes: "PRICE PROVED BY THE INVOICE: $150/mo, Mega plan, charged 2026-07-01 (rapidapi-2026-07-01-real-time-web-search, filed in the receipt vault). It was seeded at $75 off an ambiguous billing screenshot. Still active, and RAPID_WEBSEARCH_KEY is not set anywhere, so lib/inmarket/webSearch.ts no-ops: this is the most expensive line in the business that the engine cannot call at all, $1,800/yr for a feed that has never answered a request. Wire it or cancel it.",
    link: { rapidHost: "real-time-web-search.p.rapidapi.com", envKeys: ["RAPID_WEBSEARCH_KEY"] },
  },
  {
    vendor: "RapidAPI", label: "Realtime LinkedIn Fresh Data", category: "people", billing: "monthly",
    amountUsd: 99.99, at: "2026-06-01", status: "active", verified: true,
    purpose: "Deep-vet profile reads (person_deep): full work history behind AI Vetting and JD Sourcing scoring.",
    impact: "Quality control on the candidate side. Full work history is what lets vetting score a person properly instead of guessing from a job title, which is the difference between a submittable shortlist and a pile of names.",
    link: { rapidHost: "realtime-linkedin-fresh-data.p.rapidapi.com", envKeys: ["RAPIDAPI_KEY"], integrationId: "jd_sourcing" },
  },
  {
    vendor: "RapidAPI", label: "Fresh LinkedIn Scraper API", category: "people", billing: "monthly",
    amountUsd: 49, at: "2026-06-01", status: "active", verified: true,
    purpose: "People search: turns a job description into a candidate list. The primary JD Sourcing supply rung.",
    impact: "Direct candidate supply. Measured at 23% of all candidates produced across 14 sourcing runs, second only to Serper. Every JD Sourcing list starts here, so losing it cuts roughly a quarter of the pipeline at the source.",
    link: { rapidHost: "fresh-linkedin-scraper-api.p.rapidapi.com", envKeys: ["RAPIDAPI_KEY"], integrationId: "jd_sourcing" },
  },
  {
    vendor: "RapidAPI", label: "Skip Tracing Working API", category: "people", billing: "monthly",
    amountUsd: 60, at: "2026-07-01", status: "active", verified: true,
    purpose: "Recruiter-triggered Boost phones: name + city/state to cell numbers from US public records.",
    impact: "The best-performing phone source in the stack: a 92.9% cell-check pass rate and the highest reply count of any source. Phones are what convert a sourced name into a conversation, and at $60 for 22,500 requests this is the cheapest reliable way to get them.",
    link: { rapidHost: "skip-tracing-working-api.p.rapidapi.com", envKeys: ["RAPIDAPI_SKIPTRACE_HOST"], ledgerSource: "skiptrace", outcomeSource: "skiptrace" },
  },

  /* ---- Metered vendors: real cost comes from the usage ledger ---- */
  {
    vendor: "Anthropic", label: "Claude API", category: "ai", billing: "metered",
    amountUsd: 0, at: "2026-06-01", status: "active",
    purpose: "Every AI surface: vetting, reply classification, email personalization, call notes, JD parsing.",
    impact: "Every judgement the platform makes. Vetting scores, reply classification, personalization and call notes all run on it, so this is the line item that turns raw data into work a recruiter would otherwise do by hand.",
    link: { ledgerSource: "claude", envKeys: ["ANTHROPIC_API_KEY"], integrationId: "ai" },
  },
  {
    vendor: "Telnyx", label: "SMS, voice and numbers", category: "messaging", billing: "metered",
    amountUsd: 0, at: "2026-05-01", status: "active",
    purpose: "OS Text sending, the BD Phone browser dialer, per-recruiter numbers, and the fail-closed cell check.",
    impact: "The revenue channel itself. OS Text is where sourced candidates actually reply, and the same account carries the BD Phone dialer and the fail-closed cell check that keeps texts off landlines.",
    link: { ledgerSource: "telnyx", envKeys: ["TELNYX_API_KEY"], integrationId: "telnyx" },
  },
  {
    vendor: "ElevenLabs", label: "Voice cloning", category: "ai", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "The Lukas voice used by AI Vetting calls and the personalized video pipeline.",
    link: { ledgerSource: "elevenlabs", envKeys: ["VOICE_CLONE_API_KEY"], integrationId: "elevenlabs" },
  },

  /* ---- Data and enrichment ---- */
  {
    vendor: "Serper.dev", label: "Google SERP credits", category: "search", billing: "credit",
    amountUsd: 0, needsAmount: true, at: "2026-07-30", status: "active",
    purpose: "The JD Sourcing wide pass. Measured at 62% of all candidate supply, roughly $0.0002 per candidate.",
    impact: "The single biggest supply source in the business: 61.8% of all candidates across 14 measured runs, at roughly $0.0002 per candidate. Nothing else in the stack is close on cost per result, and losing it removes about two thirds of sourcing output.",
    link: { ledgerSource: "serper", envKeys: ["SERPER_API_KEY"] },
  },
  {
    vendor: "Reoon", label: "Email verifier", category: "email", billing: "one_time",
    amountUsd: 0, lifetime: true, at: "2026-06-24", status: "active",
    purpose: "Mailbox-level verification of curated decision-maker emails. Port 25 is blocked on the app box, so this replaces the SMTP probe.",
    impact: "Deliverability insurance. Port 25 is blocked on the app box, so this is the only way a guessed decision-maker email gets proven before it touches a warmed inbox. It protects domain reputation, which is the asset the whole cold-email motion rests on.",
    notes: "Lifetime licence bought outright years ago, before this register existed: no subscription, no monthly fee, and the credits it came with are still running. The purchase price is a sunk cost outside these books, which is why the row carries $0 rather than a guess. It becomes a real spend line the day volume forces a credit top-up: change the billing type to Credit top-up, enter what the pack cost, and the receipt for it will arrive by email on its own.",
    link: { ledgerSource: "reoon", envKeys: ["REOON_API_KEY"] },
  },
  {
    vendor: "Adzuna", label: "Job feed API", category: "search", billing: "monthly",
    amountUsd: 0, at: "2026-06-01", status: "active", verified: true,
    purpose: "Free-tier job feed alongside JSearch.",
    link: { envKeys: ["ADZUNA_APP_ID"] },
  },

  /* ---- Email and outreach ---- */
  {
    vendor: "Smartlead", label: "Inbox warm-up", category: "email", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "Warms the cold-email fleet. Sending itself runs through the in-house pool, not Smartlead.",
    link: { envKeys: ["SMARTLEAD_API_KEY"] },
  },
  {
    vendor: "Resend", label: "Transactional SMTP", category: "email", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-07-01", status: "active",
    purpose: "Platform mail for the Lume tenant on port 587 (465 is blocked on the app box).",
    link: { envKeys: ["RESEND_API_KEY"] },
  },
  {
    vendor: "Unipile", label: "LinkedIn automation", category: "software", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-07-01", status: "active",
    purpose: "The one LinkedIn engine: connects each recruiter seat and runs every LinkedIn action.",
    impact: "The LinkedIn channel end to end. Every connection request, message and post publishes through it, so it is the difference between having a LinkedIn motion and not having one.",
    link: { envKeys: ["UNIPILE_API_KEY"], integrationId: "unipile" },
  },

  /* ---- Infrastructure ---- */
  {
    // ONE line for every Hetzner box, by owner decision (2026-07-31): Hetzner bills the
    // whole project on a single monthly invoice, so splitting it per box invented a
    // reconciliation problem (three rows, one receipt, no way to prove any of them) in
    // exchange for detail nobody was buying separately. Server cost is server cost.
    vendor: "Hetzner", label: "Servers (all boxes)", category: "infra", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-02", status: "active",
    purpose: "All server cost in one line: the app server, the sourcing worker and the scraper fleet, on a single monthly invoice.",
    impact: "The product itself. Everything the business sells runs on these boxes, so this is the fixed cost of being switched on rather than a line to trade against volume.",
    notes: "Combined from three per-box rows on 2026-07-31, at the owner's direction. Covers the app server (ubuntu-8gb-ash-1, CCX13: portal, API, Postgres, Caddy, OS Text and every worker container), the sourcing worker (recruiteros-worker-2, CPX11) and the 5-box rotated-IP scraper fleet. Hetzner invoices all of them together, so one receipt now reconciles against one row instead of needing a guessed split across three.",
  },
  {
    vendor: "RackNerd", label: "Mailcow mail server (8GB)", category: "email", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "mail.lumesp.com: the self-hosted mailbox fleet behind white-label sending.",
    impact: "Owning the mailboxes is what makes cold email economical: sending cost is the inbox, not a per-email API fee, and white-label tenants send from their own domain.",
  },
  {
    vendor: "RackNerd", label: "Validation nodes (3 boxes)", category: "infra", billing: "annual",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "Port-25-open nodes for email validation probes.",
    notes: "ANNUAL plans, per the owner (2026-07-31). RackNerd sells these boxes on a yearly term; only the 8GB mail server is monthly. `node plans.mjs check racknerd` in the spend-ledger tool reads the real term and price off the client area.",
  },
  {
    vendor: "RackNerd", label: "Extra IPv4 address", category: "infra", billing: "annual",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "Additional dedicated IPv4 on the RackNerd account, so sending is not pinned to one address.",
    impact: "An extra IP is a second sending identity: reputation can be split across addresses, and one burnt IP does not take the whole mail server down with it.",
    notes: "Billed as its own line on the RackNerd account rather than folded into a box. Term and price to be confirmed by the plan check.",
  },
  {
    vendor: "Object storage", label: "S3 bucket (video fleet, 30d retention)", category: "infra", billing: "metered",
    amountUsd: 0, at: "2026-07-01", status: "active",
    purpose: "Holds rendered personalized videos for the 4K/day video fleet.",
    link: { envKeys: ["ROS_S3_BUCKET"] },
  },

  /* ---- Every remaining account the platform runs on -----------------------------------
   *
   * The register started as the things with a known price, which quietly made it a list of
   * what had already been costed rather than a list of what the business pays for. These
   * are the rest, taken one for one off the Passwords catalogue (lib/owner/vaultCatalog).
   * They go in with NO amount on purpose: the row exists so it can be seen, priced, and
   * pointed at a receipt route, one at a time. A tool that is genuinely free stays here
   * too, priced at zero, because "we checked and it costs nothing" is an answer and a
   * blank space is not. */
  {
    vendor: "Sending.ac", label: "Managed mailboxes (tal + lume domains)", category: "email", billing: "monthly",
    amountUsd: 0, at: "2026-06-01", status: "active", needsAmount: true,
    purpose: "The 1,450 managed mailboxes the cold-email fleet actually sends from.",
    impact: "Every BD email leaves through these. Losing them stops outbound entirely, and mailbox count is the hard ceiling on how many first emails a day the business can send.",
    notes: "Billed per mailbox, so the figure moves with the fleet size. Sign-in goes through sso.ac.",
  },
  {
    vendor: "Zapmail", label: "Google Workspace mailboxes", category: "email", billing: "monthly",
    amountUsd: 0, at: "2026-07-30", status: "active", needsAmount: true,
    purpose: "53 Google Workspace inboxes across 31 domains, the newest slice of the sending fleet.",
    impact: "Deliverability spread. Sending the same volume from a second mailbox estate on a different provider means one provider throttling the fleet cannot stop outbound on its own.",
    notes: "Zapmail also REGISTERED those 31 domains, through its reseller registrar PDR Ltd, on the same day the mailboxes appeared (2026-07-30). That is why they show on no Dynadot or Porkbun order: the domain money and the mailbox money both go to Zapmail, and the Domains panel attributes them here.",
  },
  {
    vendor: "Microsoft 365", label: "lumesp.com mailboxes", category: "email", billing: "monthly",
    amountUsd: 0, at: "2026-05-01", status: "active", needsAmount: true,
    purpose: "The real human mailboxes on lumesp.com, including ryan@lumesp.com, and the DKIM records for the domain.",
    impact: "Reply handling and anything a candidate or client sends to a named person. Also the mailbox the receipt sweep is meant to read.",
  },
  {
    vendor: "Mailcow", label: "Self-hosted mail server (mail.lumesp.com)", category: "email", billing: "monthly",
    amountUsd: 0, at: "2026-06-01", status: "active",
    purpose: "The mail server behind the Lume sending mailboxes.",
    notes: "Open source: there is no licence fee and no invoice will ever arrive. The real cost of it is the RackNerd 8GB box it runs on, which is its own line.",
  },
  {
    vendor: "Vercel", label: "Marketing site hosting", category: "infra", billing: "monthly",
    amountUsd: 0, at: "2026-06-01", status: "active", needsAmount: true,
    purpose: "Hosting for claimie.ai, the GTM OS site and glassnwa.com.",
    notes: "Free tier covers a lot of this; confirm whether a Pro seat is being billed.",
  },
  {
    vendor: "Dynadot", label: "Domain registrations", category: "domain", billing: "one_time",
    amountUsd: 0, at: "2026-06-01", status: "active", needsAmount: true,
    purpose: "Registrar for the tal-brand fleet, talentrecru.com and the lume batch.",
    notes: "Domains are bought and renewed one at a time, so this line is the account; individual names carry their own renewal dates in the Domains panel.",
  },
  {
    vendor: "Porkbun", label: "Domain registrations", category: "domain", billing: "one_time",
    amountUsd: 0, at: "2026-06-01", status: "active", needsAmount: true,
    purpose: "Registrar for the 15 Lume sending domains and the registrar of record for Claimie.",
  },
  {
    vendor: "Namecheap", label: "Domain registrations", category: "domain", billing: "one_time",
    amountUsd: 0, at: "2026-05-01", status: "active", needsAmount: true,
    purpose: "Registrar for glassnwa.com.",
  },
  {
    vendor: "LinkedIn", label: "Sales Navigator seat", category: "software", billing: "monthly",
    amountUsd: 0, at: "2026-05-01", status: "active", needsAmount: true,
    purpose: "The Sales Navigator searches JD Sourcing pulls from, and the account the LinkedIn OS acts as.",
    impact: "The people side of sourcing. Without the seat, Sales Navigator URLs stop resolving and JD Sourcing falls back to the free search paths.",
  },
  {
    vendor: "Icypeas", label: "Email finding and verification", category: "people", billing: "monthly",
    amountUsd: 0, at: "2026-06-01", status: "active", needsAmount: true,
    purpose: "A rung in the email-finding chain alongside Reoon.",
  },
  {
    vendor: "People Data Labs", label: "Person enrichment", category: "people", billing: "monthly",
    amountUsd: 0, at: "2026-06-01", status: "active", needsAmount: true,
    purpose: "Person enrichment fallback when the cheaper rungs come back empty.",
  },
  {
    vendor: "Telnyx", label: "Lume account (white-label numbers)", category: "messaging", billing: "metered",
    amountUsd: 0, at: "2026-07-01", status: "active",
    purpose: "Lume's own Telnyx account: its five per-recruiter 929 lines and everything its recruiters send.",
    notes: "A SEPARATE Telnyx account from the house one, with its own invoices. Keep the two apart or the tenant's usage lands on the house bill.",
  },
];

/* ============================ store ============================ */

interface RegisterStore {
  items: SpendItem[];
  /** Seed version already applied, so a redeploy never re-adds rows the owner deleted. */
  seededVersion: number;
}

const SEED_VERSION = 14;
const SNAP_KEY = "owner_spend_register_v1";

/**
 * Rows this register should never have carried, dropped once on a version bump.
 *
 * Taking a vendor out of SEED only stops it being re-added: a row already seeded into the
 * live store stays there forever. These were all owner calls (2026-07-31): Instantly and
 * Hume are not used at all; KoldInfo, Laxis and Loxo are used but are not billed to this
 * book; TidyCal costs nothing ongoing; and GitHub and GoDaddy carry no charge to this book
 * either, so a $0 "no price on file" line for any of them is noise the owner has to look
 * past every time. The second batch is the same call on the four accounts whose seed notes
 * were still asking whether anything was billed at all: the owner confirmed (2026-07-31)
 * that Apify, AWS, Cartesia and Cloudflare charge this business nothing, so the question
 * is settled and the rows go rather than sitting there unpriced forever.
 *
 * Guarded the same way a correction is: only a row that came from the seed and carries no
 * owner-entered money is removed, so a figure someone typed can never be deleted by a
 * redeploy. If any of these ever starts billing, add it back to SEED with the real price.
 */
const SEED_RETIREMENTS: Array<{ vendor: string; label: string }> = [
  { vendor: "Instantly", label: "Outreach sending (alternate provider)" },
  { vendor: "Hume", label: "Empathic voice" },
  { vendor: "KoldInfo", label: "People and business email database" },
  { vendor: "Laxis", label: "Contact enrichment" },
  { vendor: "Loxo", label: "ATS seats" },
  { vendor: "TidyCal", label: "Booking links" },
  { vendor: "GitHub", label: "Repositories" },
  { vendor: "GoDaddy", label: "Domain registrations" },
  { vendor: "Apify", label: "Direct-dial phone actor" },
  { vendor: "AWS", label: "S3 and anything else on the account" },
  { vendor: "Cartesia", label: "Voice cloning fallback" },
  { vendor: "Cloudflare", label: "DNS" },
];

/**
 * Facts learned about a row AFTER it was already seeded into the live store.
 *
 * `applySeed` only ever ADDS missing rows, deliberately: a redeploy must never overwrite
 * a figure the owner typed. But a seeded row can also be seeded WRONG. Reoon went in as
 * an active credit line with a price still to find, when it is in fact a lifetime licence
 * bought outright years ago with no recurring fee at all. That is a correction to a guess,
 * not a change to anything the owner entered, so it is applied once, on the version bump,
 * and ONLY while the row is still untouched (`seeded`, no owner-entered amount).
 *
 * `force` lifts the untouched guard, for the one case it cannot handle: a row an EARLIER
 * correction marked verified, which is this list's own mark, not the owner's. Pair it with
 * `when` so the patch still only lands on the value known to be wrong; a bare `force` would
 * overwrite whatever the owner has since typed on every deploy.
 */
const SEED_CORRECTIONS: Array<{
  vendor: string; label: string; patch: Partial<SpendItem>;
  force?: boolean; when?: (i: SpendItem) => boolean;
}> = [
  {
    vendor: "Reoon", label: "Email verifier",
    patch: {
      billing: "one_time", lifetime: true, needsAmount: false, amountUsd: 0,
      notes: SEED.find((s) => s.vendor === "Reoon")?.notes,
    },
  },
  {
    // Seeded as annual off the RackNerd Black Friday-style yearly pricing; the owner
    // confirmed (2026-07-31) the Mailcow box is billed MONTHLY.
    vendor: "RackNerd", label: "Mailcow mail server (8GB)",
    patch: { billing: "monthly" },
  },
  {
    // NOT a guess this time: the RapidAPI portal invoice of 2026-07-01 reads
    // "Mega ($150.00 /mo)", so the $75 seeded off the ambiguous billing screenshot was
    // wrong by half. The receipt is in the vault, which is why this one arrives verified.
    vendor: "RapidAPI", label: "Real-Time Web Search",
    patch: {
      amountUsd: 150, verified: true, needsAmount: false,
      notes: SEED.find((s) => s.label === "Real-Time Web Search")?.notes,
    },
  },
  {
    /* This line started in JULY, not June. RapidAPI's invoices for June are 0001 (Jun 16),
       0002 (Jun 19) and 0004 (Jun 24), none of them Web Search; its first is 0005, dated
       2026-07-01. A June start date makes Month by month expect $150 that was never
       charged, which reads as a missing receipt for a charge that does not exist and drags
       the coverage figure down with it.
       Forced past the verified guard because `verified` here is this list's own doing (the
       $150 correction above set it), not a figure the owner typed. `when` keeps that narrow:
       only the wrong seeded date is rewritten, so a date the owner has since set stands. */
    vendor: "RapidAPI", label: "Real-Time Web Search",
    force: true,
    when: (i) => String(i.at).slice(0, 10) === "2026-06-01",
    patch: { at: "2026-07-01" },
  },
  {
    // The three validation nodes are NOT on the mail server's cycle: the owner corrected
    // this to ANNUAL on 2026-07-31, having first been told monthly. Guessing from a
    // sibling row is what got it wrong twice, which is why the plan check now exists.
    vendor: "RackNerd", label: "Validation nodes (3 boxes)",
    patch: {
      billing: "annual",
      notes: SEED.find((s) => s.vendor === "RackNerd" && s.label.startsWith("Validation"))?.notes,
    },
  },
];

/**
 * Rows that were seeded SEPARATELY but should have been ONE line, folded together once on
 * a version bump. Different from a correction: a correction rewrites a row in place, a
 * merge deletes rows from the live store, so it only ever runs against rows this seed put
 * there and it carries their money forward rather than dropping it.
 *
 * First case: the three Hetzner boxes (owner, 2026-07-31, "just server cost"). Hetzner
 * bills all of them on ONE monthly invoice, so three rows could never be reconciled
 * against it individually and every per-box figure would have been a guess at a split.
 */
const SEED_MERGES: Array<{
  into: { vendor: string; label: string };
  from: Array<{ vendor: string; label: string }>;
}> = [
  {
    into: { vendor: "Hetzner", label: "Servers (all boxes)" },
    from: [
      { vendor: "Hetzner", label: "App server (ubuntu-8gb-ash-1, CCX13)" },
      { vendor: "Hetzner", label: "Sourcing worker (recruiteros-worker-2, CPX11)" },
      { vendor: "Hetzner", label: "Scraper fleet (5 boxes)" },
    ],
  },
];

const store: RegisterStore = { items: [], seededVersion: 0 };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;

export function ensureSpendRegisterReady(): Promise<void> {
  if (!hydrated) {
    hydrated = (dbEnabled() ? loadSnapshot<RegisterStore>(SNAP_KEY) : Promise.resolve(null))
      .then((s) => {
        if (s && Array.isArray(s.items)) {
          store.items = s.items;
          store.seededVersion = Number(s.seededVersion) || 0;
        }
        if (store.seededVersion < SEED_VERSION) applySeed();
        else void adoptDomainsOnce();
      })
      .catch(() => { if (store.seededVersion < SEED_VERSION) applySeed(); });
  }
  return hydrated;
}
void ensureSpendRegisterReady();

/** Add any seed row not already present (matched on vendor + label), apply the corrections
 *  to rows the owner has never touched, drop the retired ones, then mark the version
 *  applied. Never overwrites or deletes an amount the owner has edited. */
function applySeed(): void {
  const have = new Set(store.items.map((i) => key(i.vendor, i.label)));
  for (const s of SEED) {
    if (have.has(key(s.vendor, s.label))) continue;
    store.items.push({ ...s, id: rid("spend"), seeded: true, createdAt: nowIso(), updatedAt: nowIso() });
  }
  for (const c of SEED_CORRECTIONS) {
    const item = store.items.find((i) => key(i.vendor, i.label) === key(c.vendor, c.label));
    // Untouched means: it came from the seed and no owner-entered figure sits on it.
    if (!item || !item.seeded) continue;
    if (item.verified && !c.force) continue;
    if (c.when && !c.when(item)) continue;
    Object.assign(item, c.patch, { updatedAt: nowIso() });
  }
  store.items = mergeSeedRows(store.items);
  store.items = retireSeedRows(store.items);
  store.seededVersion = SEED_VERSION;
  persist();
  void adoptDomainsOnce();
}

/**
 * Pull the sending fleet's domains in and name their registrars, without anyone pressing
 * anything.
 *
 * The Domains panel has always had an Import button and a Refresh button, and for as long
 * as nobody pressed them the register carried 75 domains it knew nothing about: no
 * registrar, no expiry, no renewal cost, and no way to notice one lapsing. Two buttons is
 * two more than a dashboard should need to tell the truth about money already spent.
 *
 * It runs on the version bump AND on any later boot that finds work outstanding, because
 * once was not enough in practice: the first live run resolved 48 of 76 domains and the
 * container was recreated by a deploy before the rest were retried, which on a
 * bump-only trigger would have left 28 rows permanently unattributed. Outstanding work is
 * a domain with no registrar on it, so a finished fleet costs one array scan and no
 * network at all.
 *
 * Deliberately fire-and-forget and deliberately quiet: this runs during hydration, and a
 * registry that is slow or down must never hold up the console or throw into it. Failure
 * leaves the buttons exactly where they were.
 */
let adopting = false;
async function adoptDomainsOnce(): Promise<void> {
  if (adopting) return;
  const rows = store.items.filter((i) => i.domain);
  /* Outstanding is either a row with no answer yet, or a row still displaying a failure
     that a later pass disproved. The second case costs no network at all: the refresh
     finds nothing to look up and just clears the stale text. */
  const outstanding =
    rows.length === 0 ||
    rows.some((i) => !i.registrar) ||
    rows.some((i) => i.registrar && i.registryError);
  if (!outstanding) return;
  adopting = true;
  try {
    await importSendingDomains();
    // Keyless RDAP, four at a time with a slow serial retry behind it. Only the rows
    // still missing a registrar are looked up, so a resumed run is cheap and the
    // registry is not asked the same 48 questions it already answered.
    await refreshDomainFacts({ onlyMissing: rows.length > 0 });
  } catch {
    /* the buttons remain the manual route */
  } finally {
    adopting = false;
  }
}

/** Drop the rows this register should not be carrying at all. A row is only removed while
 *  it is still exactly as the seed left it: seeded, unverified, and with no money on it.
 *  Anything the owner priced or confirmed stays, because a redeploy deleting a real figure
 *  would be a silent hole in the burn number.
 *  Pure and exported so the rule can be pinned by scripts/test-spend-merge.mts. */
export function retireSeedRows(
  items: SpendItem[],
  retirements: typeof SEED_RETIREMENTS = SEED_RETIREMENTS,
): SpendItem[] {
  const gone = new Set(retirements.map((r) => key(r.vendor, r.label)));
  return items.filter((i) => {
    if (!gone.has(key(i.vendor, i.label))) return true;
    return !i.seeded || i.verified === true || Number(i.amountUsd) > 0;
  });
}

/** Fold the old per-item rows into the single row that replaced them, then drop them.
 *  Money is carried forward, never dropped: if the owner had priced the separate rows, the
 *  merged row inherits their total, so the burn figure cannot quietly fall on a redeploy.
 *  A figure already sitting on the merged row wins over anything folded in.
 *  Pure and exported so the fold can be pinned by scripts/test-spend-merge.mts. */
export function mergeSeedRows(items: SpendItem[], merges: typeof SEED_MERGES = SEED_MERGES): SpendItem[] {
  let out = items.slice();
  for (const m of merges) {
    const target = out.find((i) => key(i.vendor, i.label) === key(m.into.vendor, m.into.label));
    if (!target) continue;
    const sources = m.from
      .map((f) => out.find((i) => key(i.vendor, i.label) === key(f.vendor, f.label)))
      .filter((i): i is SpendItem => Boolean(i) && i !== target);
    if (!sources.length) continue;

    const priced = sources.filter((s) => Number(s.amountUsd) > 0);
    if (priced.length && !(Number(target.amountUsd) > 0)) {
      target.amountUsd = round2(priced.reduce((t, s) => t + Number(s.amountUsd || 0), 0));
      target.needsAmount = false;
      // Only as proven as the weakest figure that went into it.
      target.verified = priced.every((s) => s.verified === true);
    }
    // Oldest start date wins: the spend started when the FIRST of these boxes was bought.
    const earliest = sources.map((s) => s.at).filter(Boolean).sort()[0];
    if (earliest && (!target.at || earliest < target.at)) target.at = earliest;
    // Nothing left running means nothing left to pay for.
    if (sources.every((s) => s.status === "cancelled")) target.status = "cancelled";

    const gone = new Set(sources.map((s) => s.id));
    out = out.filter((i) => !gone.has(i.id));
    target.updatedAt = nowIso();
  }
  return out;
}
function key(vendor: string, label: string): string {
  return (vendor + "|" + label).toLowerCase();
}

/* ============================ CRUD ============================ */

export async function listSpendItems(): Promise<SpendItem[]> {
  await ensureSpendRegisterReady();
  return store.items.slice().sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label));
}

export async function addSpendItem(input: Partial<SpendItem>): Promise<SpendItem> {
  await ensureSpendRegisterReady();
  const item: SpendItem = {
    id: rid("spend"),
    vendor: String(input.vendor || "").trim() || "Unnamed vendor",
    label: String(input.label || "").trim() || "Unnamed item",
    category: (input.category as SpendCategory) || "other",
    billing: (input.billing as BillingType) || "monthly",
    amountUsd: num(input.amountUsd),
    at: String(input.at || nowIso().slice(0, 10)),
    status: input.status === "cancelled" ? "cancelled" : "active",
    purpose: input.purpose ? String(input.purpose) : undefined,
    link: input.link,
    verified: input.verified !== false,
    lifetime: input.lifetime ? true : undefined,
    notes: input.notes ? String(input.notes) : undefined,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.items.push(item);
  persist();
  return item;
}

export async function updateSpendItem(id: string, patch: Partial<SpendItem>): Promise<SpendItem | null> {
  await ensureSpendRegisterReady();
  const item = store.items.find((i) => i.id === id);
  if (!item) return null;
  if (patch.vendor != null) item.vendor = String(patch.vendor);
  if (patch.label != null) item.label = String(patch.label);
  if (patch.category != null) item.category = patch.category as SpendCategory;
  if (patch.billing != null) item.billing = patch.billing as BillingType;
  if (patch.amountUsd != null) {
    item.amountUsd = num(patch.amountUsd);
    // An owner-entered figure is an invoice figure: it stops being a prompt.
    item.needsAmount = false;
    item.verified = true;
  }
  /* Marking a row paid-once retires the price prompt: there is no recurring figure to
     find. Unmarking it (credits bought again) puts the prompt back unless a price is
     already on file, so the row starts asking for its receipt from that day. */
  if (patch.lifetime != null) {
    item.lifetime = !!patch.lifetime;
    if (item.lifetime) item.needsAmount = false;
    else if (!item.amountUsd) item.needsAmount = true;
  }
  if (patch.at != null) item.at = String(patch.at);
  if (patch.status != null) item.status = patch.status === "cancelled" ? "cancelled" : "active";
  if (patch.purpose != null) item.purpose = String(patch.purpose);
  if (patch.notes != null) item.notes = String(patch.notes);
  if (patch.verified != null) item.verified = !!patch.verified;
  if (patch.domain != null) item.domain = String(patch.domain).trim().toLowerCase();
  if (patch.renewalUsd != null) item.renewalUsd = num(patch.renewalUsd);
  if (patch.autoRenew != null) item.autoRenew = !!patch.autoRenew;
  if (patch.expiresAt != null) item.expiresAt = String(patch.expiresAt);
  item.updatedAt = nowIso();
  persist();
  return item;
}

/**
 * Teach a row the recurring price its own receipts have proven.
 *
 * A seeded row with no price shows "no price on file" forever, even while the vault holds
 * that vendor's invoices: Smartlead sat at $0/mo in the burn with two $174 receipts filed
 * against it, because a matched receipt was never allowed to answer the question the row
 * was asking. Nothing in this book should have to be typed in twice.
 *
 * What makes it safe to write:
 *
 *   - only onto a row still ASKING (`needsAmount`). A figure the owner typed, or one a
 *     plan check read off the vendor's own account page, is never touched.
 *   - only for a recurring term. A credit top-up or a one-time buy has a receipt for a
 *     purchase, not for a price; a metered row's real number comes from the usage ledger.
 *   - the caller must have seen the SAME figure in two different periods (see the caller):
 *     one charge proves money moved, two identical ones a month apart prove a rate. A
 *     first-month proration or a setup fee would otherwise become the standing price.
 *
 * It deliberately does NOT mark the row `verified`. A receipt proves what was charged, not
 * what the plan costs per term, so a later plan check can still correct it without --force.
 */
export async function setLearnedPrice(
  id: string,
  amountUsd: number,
  why: string,
): Promise<SpendItem | null> {
  await ensureSpendRegisterReady();
  const item = store.items.find((i) => i.id === id);
  if (!item) return null;
  if (!item.needsAmount || item.lifetime) return null;
  if (item.billing !== "monthly" && item.billing !== "annual") return null;
  const amt = num(amountUsd);
  if (!(amt > 0)) return null;

  item.amountUsd = amt;
  item.needsAmount = false;
  item.notes = item.notes ? `${item.notes} ${why}` : why;
  item.updatedAt = nowIso();
  persist();
  return item;
}

/* ---------------- verified plans, read off the vendor's own account ---------------- */

/**
 * One service as the VENDOR states it: the product, the term it renews on, and what it
 * costs per term. This is not a receipt (no money has necessarily moved yet); it is the
 * subscription itself, which is the thing a receipt can never tell you. A yearly invoice
 * and a monthly one look identical on a bank line: only the account page says which it is.
 */
export interface VerifiedPlan {
  vendor: string;
  /** Product name exactly as the vendor's account page prints it. */
  label: string;
  billing: BillingType;
  amountUsd: number;
  /** Vendor's own figure and currency, when it does not bill in USD. */
  nativeAmount?: number;
  currency?: string;
  /** Next renewal date, ISO, when the account page states one. */
  nextDueAt?: string;
  /** Vendor-side status: an account can carry cancelled services that still show. */
  status?: SpendStatus;
  /** Vendor's own id for the service, so a rename does not orphan the row. */
  reference?: string;
  /** The page this was read from, recorded on the row so the claim is checkable. */
  sourceUrl?: string;
  /** ISO timestamp of the read. */
  checkedAt?: string;
  /** Category for a row that has to be created; never overrides an existing one. */
  category?: SpendCategory;
}

export interface VerifiedPlanResult {
  updated: Array<{ id: string; label: string; was: BillingType; now: BillingType; wasAmount: number; nowAmount: number }>;
  unchanged: string[];
  created: Array<{ id: string; label: string }>;
  /** Register rows for this vendor the account page did not mention. Reported, never
   *  deleted: a service can be absent because it was cancelled, or because the reader
   *  missed a table, and those must not look the same. */
  missingFromVendor: string[];
  /** A vendor service that looks like it might be one of our rows but is not close
   *  enough to act on. NOTHING is written for these. The alternative is worse in both
   *  directions: guess yes and the wrong row gets rewritten, guess no and the register
   *  grows a duplicate that double-counts the same box. One human answer settles it
   *  permanently, because confirming stores the vendor's own product name on the row. */
  needsMapping: Array<{
    planLabel: string;
    billing: BillingType;
    amountUsd: number;
    candidateId: string;
    candidateLabel: string;
    confidence: number;
  }>;
}

/** Confidence that a register row and a vendor service are the same thing.
 *
 *  The vendor's own product name rarely resembles ours ("KVM VPS - 8GB" against
 *  "Mailcow mail server (8GB)"), so an exact `vendorLabel` recorded from a previous
 *  confirmation is checked first and is the only thing that ever scores certain. */
function planMatches(item: SpendItem, planLabel: string, reference?: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const b = norm(planLabel);
  if (!b) return 0;
  if (item.vendorLabel && norm(item.vendorLabel) === b) return 1;
  if (reference && item.vendorRef && item.vendorRef === reference) return 1;

  const a = norm(item.label);
  if (!a) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const at = new Set(a.split(" ").filter((t) => t.length > 2));
  const bt = new Set(b.split(" ").filter((t) => t.length > 2));
  if (!at.size || !bt.size) return 0;
  let hit = 0;
  for (const t of at) if (bt.has(t)) hit++;
  return hit / Math.min(at.size, bt.size);
}

/** Confident enough to rewrite a row. */
const MATCH_SURE = 0.6;
/** Close enough to be worth a human glance, too close to act on. */
const MATCH_MAYBE = 0.25;

/**
 * Write what the vendor's own account page says onto the register.
 *
 * This is the cure for the thing that keeps going wrong: a seeded row carries a GUESS at
 * the billing term, the guess survives because nothing ever contradicts it, and the burn
 * figure is wrong by 12x in whichever direction the guess fell. A plan read off the
 * vendor's account page is the vendor's own statement, so it is allowed to overwrite a
 * guess outright and is marked `verified`.
 *
 * It does NOT overwrite a figure the owner typed by hand unless `force` is set: the owner
 * may be holding an invoice the page does not show. It never deletes.
 */
export async function applyVerifiedPlans(
  vendor: string,
  plans: VerifiedPlan[],
  opts: {
    force?: boolean;
    sourceUrl?: string;
    checkedAt?: string;
    /** Confirmed mappings from the vendor's product name to a register row id. Applied
     *  before matching and stored on the row, so the question is asked once, ever. */
    map?: Record<string, string>;
  } = {},
): Promise<VerifiedPlanResult> {
  await ensureSpendRegisterReady();
  const out: VerifiedPlanResult = { updated: [], unchanged: [], created: [], missingFromVendor: [], needsMapping: [] };
  const mine = store.items.filter((i) => i.vendor.toLowerCase() === vendor.toLowerCase());
  const claimed = new Set<string>();

  for (const [planLabel, itemId] of Object.entries(opts.map || {})) {
    const item = mine.find((i) => i.id === itemId);
    if (item) { item.vendorLabel = planLabel; item.updatedAt = nowIso(); }
  }

  for (const plan of plans) {
    const scored = mine
      .filter((i) => !claimed.has(i.id))
      .map((i) => ({ i, score: planMatches(i, plan.label, plan.reference) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0] && scored[0].score >= MATCH_SURE ? scored[0].i : null;

    /* Similar but not the same: say so and write nothing. */
    if (!best && scored[0] && scored[0].score >= MATCH_MAYBE) {
      out.needsMapping.push({
        planLabel: plan.label,
        billing: plan.billing,
        amountUsd: num(plan.amountUsd),
        candidateId: scored[0].i.id,
        candidateLabel: scored[0].i.label,
        confidence: Math.round(scored[0].score * 100) / 100,
      });
      continue;
    }

    const checkedAt = plan.checkedAt || opts.checkedAt || nowIso();
    const stamp = `Read off ${vendor}'s own account page ${checkedAt.slice(0, 10)}: ${plan.label}, `
      + `${plan.billing}${plan.amountUsd ? ` at $${plan.amountUsd.toFixed(2)}/term` : ""}`
      + `${plan.nextDueAt ? `, next due ${plan.nextDueAt.slice(0, 10)}` : ""}.`
      + `${plan.sourceUrl || opts.sourceUrl ? ` Source: ${plan.sourceUrl || opts.sourceUrl}` : ""}`;

    if (!best) {
      // A service on the account with no row is the "extra IP" case: real money the
      // register was silent about. Creating it is not a guess, it is the vendor's word.
      const item: SpendItem = {
        id: rid("spend"), vendor, label: plan.label,
        category: plan.category || "other",
        billing: plan.billing,
        amountUsd: num(plan.amountUsd),
        needsAmount: !plan.amountUsd,
        verified: plan.amountUsd > 0,
        at: (plan.nextDueAt || checkedAt).slice(0, 10),
        status: plan.status || "active",
        purpose: `Found on the ${vendor} account by the plan check; it was not in the register.`,
        notes: stamp,
        vendorLabel: plan.label,
        vendorRef: plan.reference,
        createdAt: nowIso(), updatedAt: nowIso(),
      };
      store.items.push(item);
      out.created.push({ id: item.id, label: item.label });
      continue;
    }

    claimed.add(best.id);
    /* Remember the vendor's own wording, so next month's read is an exact hit and this
       row never has to be guessed at again. */
    best.vendorLabel = plan.label;
    if (plan.reference) best.vendorRef = plan.reference;
    const wasBilling = best.billing;
    const wasAmount = best.amountUsd;
    const ownerTyped = best.verified && !best.seeded;
    const takeAmount = plan.amountUsd > 0 && (opts.force || !ownerTyped || !best.amountUsd);

    best.billing = plan.billing;
    if (takeAmount) {
      best.amountUsd = num(plan.amountUsd);
      best.needsAmount = false;
      best.verified = true;
    }
    if (plan.nextDueAt) best.expiresAt = plan.nextDueAt;
    if (plan.status) best.status = plan.status;
    best.notes = best.notes && !best.notes.includes("Read off ") ? `${best.notes} ${stamp}` : stamp;
    best.updatedAt = nowIso();

    if (wasBilling !== best.billing || wasAmount !== best.amountUsd) {
      out.updated.push({
        id: best.id, label: best.label,
        was: wasBilling, now: best.billing,
        wasAmount, nowAmount: best.amountUsd,
      });
    } else {
      out.unchanged.push(best.label);
    }
  }

  /* A row awaiting a mapping decision is not missing: it is unanswered. Reporting it as
     both would tell the owner to check whether it was cancelled AND to confirm what it
     pairs with, which are contradictory instructions about the same row. */
  const pending = new Set(out.needsMapping.map((m) => m.candidateId));
  for (const i of mine) {
    if (!claimed.has(i.id) && !pending.has(i.id) && i.status === "active") out.missingFromVendor.push(i.label);
  }
  persist();
  return out;
}

/* ---------------- domains ---------------- */

/** One inbox as the sender store holds it. Only the three fields this module reads. */
interface SenderInbox {
  email?: string;
  provider?: string;
  smtpHost?: string;
}

/**
 * What a sending domain carries: which mailbox provider serves it and how many inboxes
 * sit on it. This is the fact that makes a domain row meaningful. A domain with 50
 * Microsoft 365 inboxes on it is a load-bearing part of the outbound fleet; one with a
 * single mailbox is a spare, and they cost the same to renew.
 */
export interface DomainUse {
  provider: string;
  smtpHost: string;
  inboxes: number;
}

/** Mailbox provider tags, as the sender store writes them, in plain words. */
const PROVIDER_LABELS: Record<string, string> = {
  "sending-ac": "Sending.ac",
  "own-smtp": "in-house Mailcow",
  google: "Google Workspace",
  gmail: "Google Workspace",
  other: "Google Workspace",
};

/** Read every sending domain out of the sender store, with what it carries. */
async function sendingDomainUse(): Promise<Map<string, DomainUse>> {
  const snap = await loadSnapshot<{ inboxes?: SenderInbox[] }>("senders_v1").catch(() => null);
  const out = new Map<string, DomainUse>();
  for (const inbox of snap?.inboxes || []) {
    const domain = String(inbox?.email || "").trim().toLowerCase().split("@")[1];
    if (!domain) continue;
    const cur = out.get(domain);
    if (cur) { cur.inboxes += 1; continue; }
    out.set(domain, {
      provider: String(inbox?.provider || "other"),
      smtpHost: String(inbox?.smtpHost || ""),
      inboxes: 1,
    });
  }
  return out;
}

/** "sending-ac on smtp.office365.com" in words a person would use. */
function providerLabel(use: DomainUse): string {
  const named = PROVIDER_LABELS[use.provider];
  if (named) return named;
  if (/office365|outlook/i.test(use.smtpHost)) return "Microsoft 365";
  if (/gmail|google/i.test(use.smtpHost)) return "Google Workspace";
  return use.provider || "unknown provider";
}

/**
 * Adopt every domain the sending fleet is actually using into the register, so the
 * domain list maintains itself instead of being retyped. Existing rows are left alone
 * apart from refreshing what each domain CARRIES, which changes as mailboxes are added,
 * so this is safe to run repeatedly. Returns the number of new rows.
 */
export async function importSendingDomains(): Promise<{ added: number; total: number }> {
  await ensureSpendRegisterReady();
  const use = await sendingDomainUse();

  const byDomain = new Map(store.items.filter((i) => i.domain).map((i) => [i.domain as string, i]));
  let added = 0;
  for (const domain of [...use.keys()].sort()) {
    const u = use.get(domain) as DomainUse;
    const carries = `${u.inboxes} ${providerLabel(u)} inbox${u.inboxes === 1 ? "" : "es"}.`;
    const existing = byDomain.get(domain);
    if (existing) {
      // Inbox counts move; the money on the row does not. Only the usage line is refreshed.
      existing.mailProvider = providerLabel(u);
      existing.mailboxCount = u.inboxes;
      if (existing.seeded) existing.purpose = `Sending domain in the cold-email fleet. ${carries}`;
      existing.updatedAt = nowIso();
      continue;
    }
    store.items.push({
      id: rid("spend"),
      vendor: "Domain registrar",
      label: domain,
      category: "domain",
      billing: "annual",
      amountUsd: 0,
      needsAmount: true,
      at: nowIso().slice(0, 10),
      status: "active",
      domain,
      mailProvider: providerLabel(u),
      mailboxCount: u.inboxes,
      purpose: `Sending domain in the cold-email fleet. ${carries}`,
      seeded: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    added += 1;
  }
  persist();
  return { added, total: use.size };
}

/**
 * The registry names the REGISTRAR. The register has to name whoever the money went to,
 * and those are not always the same company.
 *
 * "Dynadot Inc" and "Porkbun LLC" are both, so they only need trimming to the name on the
 * invoice. PDR Ltd is different: it is a wholesale registrar that resellers buy through,
 * and nobody here has ever had an account with it. Every PDR domain on this fleet was
 * registered on 2026-07-30, the same day Zapmail provisioned the Google Workspace inboxes
 * that sit on them, and none of them appears on a Dynadot or Porkbun order. So the bill
 * for them is Zapmail's, and attributing them to "PDR Ltd" would leave 31 domains looking
 * unaccounted for while Zapmail's own line looked cheaper than it is.
 *
 * That inference is stated on the row rather than hidden, and it is only drawn when the
 * mailboxes on the domain are Google Workspace ones. A PDR domain serving anything else
 * keeps the registry's own answer, because then the reasoning does not apply.
 */
const REGISTRAR_VENDORS: Array<{ match: RegExp; vendor: string; whenMailProvider?: RegExp }> = [
  { match: /dynadot/i, vendor: "Dynadot" },
  { match: /porkbun/i, vendor: "Porkbun" },
  { match: /namecheap/i, vendor: "Namecheap" },
  { match: /godaddy/i, vendor: "GoDaddy" },
  { match: /cloudflare/i, vendor: "Cloudflare" },
  { match: /publicdomainregistry|pdr ltd/i, vendor: "Zapmail", whenMailProvider: /google workspace/i },
];

/** The vendor a domain's money goes to, given its registrar and what serves its mail. */
function vendorForRegistrar(registrar: string, mailProvider?: string): string {
  for (const rule of REGISTRAR_VENDORS) {
    if (!rule.match.test(registrar)) continue;
    if (rule.whenMailProvider && !rule.whenMailProvider.test(mailProvider || "")) continue;
    return rule.vendor;
  }
  return registrar;
}

/**
 * Refresh registration dates, expiry and registrar for every domain row from the public
 * registry. A lookup failure is recorded on the row and never clears a known date.
 */
export async function refreshDomainFacts(
  opts: { onlyMissing?: boolean } = {},
): Promise<{ checked: number; updated: number; failed: number }> {
  await ensureSpendRegisterReady();
  /* onlyMissing is for the unattended resume: ask the registry about the rows that still
     have no answer, and leave the ones that already do alone. The button in the console
     always refreshes everything, because a person pressing Refresh means the dates, not
     just the gaps. */
  const rows = store.items.filter((i) => i.domain && (!opts.onlyMissing || !i.registrar));

  /* A resume pass deliberately does not re-ask about rows that already answered, which
     leaves their LAST failure sitting on them: 37 domains carried "registry timed out"
     under a registrar the retry had since found. An error that a later run disproved is
     not a warning, it is a lie in red text, so it is cleared here rather than left to
     wait for someone to press Refresh. */
  if (opts.onlyMissing) {
    for (const done of store.items) {
      if (done.domain && done.registrar && done.registryError) done.registryError = undefined;
    }
  }

  if (!rows.length) { persist(); return { checked: 0, updated: 0, failed: 0 }; }
  const facts = await lookupDomains(rows.map((r) => r.domain as string));
  const byDomain = new Map(facts.map((f) => [f.domain, f]));
  let updated = 0, failed = 0;
  for (const row of rows) {
    const f = byDomain.get(row.domain as string);
    if (!f) continue;
    if (f.error) {
      row.registryError = f.error;
      failed += 1;
      continue;
    }
    row.registryError = undefined;
    row.registryCheckedAt = nowIso();
    if (f.registeredAt) {
      row.registeredAt = f.registeredAt;
      // The purchase date is the registration date unless the owner has said otherwise.
      if (row.seeded) row.at = f.registeredAt.slice(0, 10);
    }
    if (f.expiresAt) row.expiresAt = f.expiresAt;
    if (f.registrar) {
      row.registrar = f.registrar;
      // Only ever names a row the import left unnamed, or corrects one this same rule
      // named before. An owner-entered vendor is never overwritten.
      const known = REGISTRAR_VENDORS.some((r) => r.vendor === row.vendor);
      if (row.vendor === "Domain registrar" || (row.seeded && known)) {
        row.vendor = vendorForRegistrar(f.registrar, row.mailProvider);
      }
    }
    row.updatedAt = nowIso();
    updated += 1;
  }
  persist();
  return { checked: rows.length, updated, failed };
}

/**
 * Set the price on every domain bought from one vendor, in one go.
 *
 * Domains are bought in batches at one price: 29 at Dynadot on a Tuesday, 15 at Porkbun a
 * month later. Entering that price 44 times by hand is how a domain register stops being
 * maintained, so the panel offers the batch. `renewalUsd` matters more than the purchase
 * price on this kind of row, because promotional first-year pricing is exactly what makes
 * a renewal bill a surprise.
 *
 * Rows the owner has already priced are left alone unless `overwrite` says otherwise, so
 * running it again after adding a few domains prices only the new ones.
 */
export async function priceDomains(input: {
  vendor: string;
  amountUsd?: number;
  renewalUsd?: number;
  autoRenew?: boolean;
  overwrite?: boolean;
}): Promise<{ priced: number; matched: number }> {
  await ensureSpendRegisterReady();
  const want = String(input.vendor || "").trim().toLowerCase();
  if (!want) return { priced: 0, matched: 0 };

  const rows = store.items.filter(
    (i) => i.domain && (i.vendor.toLowerCase() === want || (i.registrar || "").toLowerCase().includes(want)),
  );
  let priced = 0;
  for (const row of rows) {
    if (!input.overwrite && row.verified && row.amountUsd > 0 && input.amountUsd != null) continue;
    if (input.amountUsd != null) {
      row.amountUsd = num(input.amountUsd);
      row.needsAmount = false;
      // A batch price is a real invoice figure, not an estimate, so it counts as verified
      // exactly as a hand-typed one would.
      row.verified = true;
    }
    if (input.renewalUsd != null) row.renewalUsd = num(input.renewalUsd);
    if (input.autoRenew != null) row.autoRenew = !!input.autoRenew;
    row.updatedAt = nowIso();
    priced += 1;
  }
  if (priced) persist();
  return { priced, matched: rows.length };
}

export async function deleteSpendItem(id: string): Promise<boolean> {
  await ensureSpendRegisterReady();
  const n = store.items.length;
  store.items = store.items.filter((i) => i.id !== id);
  if (store.items.length === n) return false;
  persist();
  return true;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

/* ============================ live signals ============================ */

export type LiveState = "live" | "idle" | "unwired" | "unknown";

export interface LiveSignal {
  state: LiveState;
  /** Why the state was assigned, shown verbatim in the console. */
  reason: string;
  /** Present when the vendor is a RapidAPI listing with a quota meter. */
  quota?: { limit: number; used: number; remaining: number; pct: number; resetAt?: string; updatedAt: string };
  /** Daily requests for the sparkline, oldest first. */
  history?: Array<{ date: string; used: number }>;
  /** Metered cost attributed to this vendor in the window. */
  meteredUsd?: number;
  /** Which env keys are actually present in the running process. */
  envPresent?: string[];
  envMissing?: string[];
  /** Accounts that have this integration connected, and their last test result. */
  workspaces?: Array<{ workspaceId: string; status: string; lastTestedAt?: string; error?: string }>;
  /** ISO of the last observed activity, when we have one. */
  lastActivityAt?: string;
}

const CREDS_KEY = "integration_credentials_v1";
/** Read-only shape of the Connected hub's credential store. Owner-side reads never
 *  surface key VALUES: only which keys are present, plus the non-secret host values
 *  that say which RapidAPI listing a workspace points at. */
interface CredEntry {
  id: string;
  keys: Record<string, string>;
  status: string;
  lastTestedAt?: string;
  error?: string;
}
interface CredWorkspace {
  workspaceId: string;
  integrations: Record<string, CredEntry>;
}
type CredBlob = Record<string, CredWorkspace>;

/** How close to expiry a domain must be before the console warns about it. */
const DOMAIN_WARN_DAYS = 60;

/** How stale a quota reading may be before a subscription counts as idle. */
const IDLE_AFTER_MS = 30 * 24 * 3600 * 1000;
/** Below this share of the plan, a subscription is treated as not earning its money.
 *  A 50,000-request plan that served 1 request is not "live" in any useful sense. */
const MIN_UTILIZATION_PCT = 1;

/**
 * Join every register row against the live system: the RapidAPI credit meter, the usage
 * ledger, and the credential store. This is the part that makes the dashboard truthful
 * rather than a spreadsheet: a row can say $150/mo while the signal says "no key set".
 */
export async function attachLive(
  items: SpendItem[],
  window: SpendWindow = "30d",
): Promise<Array<SpendItem & { live: LiveSignal }>> {
  const [quotas, creds] = await Promise.all([
    getRapidQuota().catch(() => [] as RapidQuotaSnapshot[]),
    loadSnapshot<CredBlob>(CREDS_KEY).catch(() => null),
  ]);
  const byHost = new Map(quotas.map((q) => [q.host, q]));
  const ledger = spendRollup(window);
  const now = Date.now();

  const out: Array<SpendItem & { live: LiveSignal }> = [];
  for (const item of items) {
    const link = item.link || {};
    const envKeys = link.envKeys || [];
    const envPresent = envKeys.filter((k) => !!(process.env[k] || "").trim());
    const envMissing = envKeys.filter((k) => !(process.env[k] || "").trim());

    // Per-workspace credential presence: a key can live in the portal store rather than
    // the env file, which is exactly how the JD Sourcing listings are configured.
    const workspaces: LiveSignal["workspaces"] = [];
    let credConfigured = false;
    if (creds) {
      const credEntries: Array<[string, CredWorkspace]> = Object.entries(creds);
      for (const [wsId, ws] of credEntries) {
        const integrations: Array<[string, CredEntry]> = Object.entries(ws?.integrations || {});
        for (const [iid, c] of integrations) {
          if (!c) continue;
          const matchesIntegration = link.integrationId && iid === link.integrationId;
          // A host-bound row is configured by whichever workspace points at that host.
          const matchesHost = !!link.rapidHost && Object.values(c.keys || {}).some((v) => v === link.rapidHost);
          const matchesEnvKey = envKeys.length > 0 && envKeys.some((k) => !!(c.keys || {})[k]);
          if (!matchesIntegration && !matchesHost && !matchesEnvKey) continue;
          if (link.rapidHost && !matchesHost && matchesIntegration) continue; // wrong listing in the same integration
          credConfigured = true;
          workspaces.push({ workspaceId: wsId, status: c.status, lastTestedAt: c.lastTestedAt, error: c.error });
        }
      }
    }

    const q = link.rapidHost ? byHost.get(link.rapidHost) : undefined;
    const meteredUsd = link.ledgerSource ? ledger.bySource[link.ledgerSource] : undefined;
    const configured = envPresent.length > 0 || credConfigured;

    let state: LiveState = "unknown";
    let reason = "No live signal available for this vendor. Track it here and confirm on the vendor's own dashboard.";
    let lastActivityAt: string | undefined;

    if (q) {
      lastActivityAt = q.updatedAt;
      const fresh = now - Date.parse(q.updatedAt) < IDLE_AFTER_MS;
      const pct = q.limit > 0 ? (q.used / q.limit) * 100 : 0;
      if (q.used > 0 && fresh && pct >= MIN_UTILIZATION_PCT) {
        state = "live";
        reason = `${q.used.toLocaleString("en-US")} of ${q.limit.toLocaleString("en-US")} requests used this billing window.`;
      } else if (q.used > 0 && fresh) {
        // A plan billing in full for a rounding error of its quota is dead spend in
        // everything but name, so it is reported as such rather than as "live".
        state = "idle";
        reason = `Only ${q.used.toLocaleString("en-US")} of ${q.limit.toLocaleString("en-US")} requests used this billing window, under ${MIN_UTILIZATION_PCT}% of what the plan buys.`;
      } else if (fresh) {
        state = "idle";
        reason = "Reachable, but no requests recorded against the plan in the current window.";
      } else {
        state = "idle";
        reason = "No call recorded in the last 30 days.";
      }
    } else if (link.rapidHost && !configured) {
      state = "unwired";
      reason = "Paid subscription with no key configured anywhere: the engine cannot call it.";
    } else if (!configured && envKeys.length) {
      state = "unwired";
      reason = `Not configured. Missing: ${envMissing.join(", ")}.`;
    } else if (meteredUsd != null && meteredUsd > 0) {
      state = "live";
      reason = `${usd(meteredUsd)} of metered cost recorded in this window.`;
    } else if (configured) {
      state = item.billing === "metered" ? "idle" : "idle";
      reason = "Configured and reachable, but no usage recorded in this window.";
    }

    // A row bound to a RapidAPI host that has never reported AND has no key anywhere is
    // dead spend, whatever the meter says.
    if (link.rapidHost && !configured && !q) {
      state = "unwired";
      reason = "Paid subscription with no key configured anywhere: the engine cannot call it.";
    }

    const live: LiveSignal = {
      state,
      reason,
      meteredUsd: meteredUsd != null ? round2(meteredUsd) : undefined,
      envPresent: envKeys.length ? envPresent : undefined,
      envMissing: envKeys.length ? envMissing : undefined,
      workspaces: workspaces.length ? workspaces : undefined,
      lastActivityAt,
    };
    if (q) {
      live.quota = {
        limit: q.limit,
        used: q.used,
        remaining: q.remaining,
        pct: q.limit > 0 ? Math.round((q.used / q.limit) * 1000) / 10 : 0,
        resetAt: q.resetAt,
        updatedAt: q.updatedAt,
      };
      live.history = await getRapidQuotaHistory(q.host, 30).catch(() => []);
    }
    out.push({ ...item, live });
  }
  return out;
}

/* ============================ rollup ============================ */

export interface BurnRollup {
  window: SpendWindow;
  /** Committed recurring cost: monthly rows plus annual rows divided by twelve. */
  committedMonthlyUsd: number;
  /** Metered cost from the usage ledger for the window. */
  meteredUsd: number;
  /** committed + metered: the number the owner actually wants. */
  totalMonthlyUsd: number;
  /** Annual rows expressed at full price, for the renewal view. */
  annualCommittedUsd: number;
  /** Every one-time purchase and credit top-up on record. */
  oneTimeTotalUsd: number;
  oneTime90dUsd: number;
  /** Recurring spend on rows the live signal says are unwired or idle. */
  deadMonthlyUsd: number;
  /** Rows still waiting for the owner to enter an amount. */
  needsAmountCount: number;
  /** What every domain on record costs to renew for one more year. */
  domainRenewalAnnualUsd: number;
  /** Domains lapsing within the warning window, soonest first. */
  domainsExpiringSoon: Array<{ id: string; domain: string; expiresAt: string; days: number; renewalUsd: number; autoRenew?: boolean }>;
  domainCount: number;
  byCategory: Record<string, number>;
  byVendor: Record<string, number>;
  byBilling: Record<string, number>;
}

/** Monthly-equivalent cost of one row. one_time and credit purchases are NOT amortized:
 *  they are reported separately so a $500 credit top-up never masquerades as run rate. */
export function monthlyEquivalent(i: SpendItem): number {
  if (i.status !== "active") return 0;
  if (i.billing === "monthly") return i.amountUsd;
  if (i.billing === "annual") return round2(i.amountUsd / 12);
  return 0;
}

export function rollupBurn(items: Array<SpendItem & { live?: LiveSignal }>, window: SpendWindow = "30d"): BurnRollup {
  const ledger = spendRollup(window);
  const byCategory: Record<string, number> = {};
  const byVendor: Record<string, number> = {};
  const byBilling: Record<string, number> = {};
  let committed = 0, annual = 0, oneTime = 0, oneTime90d = 0, dead = 0, needsAmount = 0;
  let domainRenewal = 0, domainCount = 0;
  const expiring: BurnRollup["domainsExpiringSoon"] = [];
  const since90 = Date.now() - 90 * 24 * 3600 * 1000;

  for (const i of items) {
    if (i.needsAmount) needsAmount += 1;
    if (i.domain) {
      domainCount += 1;
      // Renewal price falls back to what was paid: most registrars renew at or above it.
      const renew = i.renewalUsd != null && i.renewalUsd > 0 ? i.renewalUsd : i.amountUsd;
      if (i.status === "active") domainRenewal += renew;
      const days = daysUntil(i.expiresAt);
      if (i.status === "active" && i.expiresAt && days != null && days <= DOMAIN_WARN_DAYS) {
        expiring.push({ id: i.id, domain: i.domain, expiresAt: i.expiresAt, days, renewalUsd: renew, autoRenew: i.autoRenew });
      }
    }
    const m = monthlyEquivalent(i);
    committed += m;
    if (i.status === "active" && i.billing === "annual") annual += i.amountUsd;
    if (i.billing === "one_time" || i.billing === "credit") {
      oneTime += i.amountUsd;
      if (Date.parse(i.at) >= since90) oneTime90d += i.amountUsd;
    }
    if (m > 0) {
      byCategory[i.category] = round2((byCategory[i.category] || 0) + m);
      byVendor[i.vendor] = round2((byVendor[i.vendor] || 0) + m);
      byBilling[i.billing] = round2((byBilling[i.billing] || 0) + m);
      const st = i.live?.state;
      if (st === "unwired" || st === "idle") dead += m;
    }
  }
  committed = round2(committed);
  const metered = round2(ledger.totalCostUsd);
  return {
    window,
    committedMonthlyUsd: committed,
    meteredUsd: metered,
    totalMonthlyUsd: round2(committed + metered),
    annualCommittedUsd: round2(annual),
    oneTimeTotalUsd: round2(oneTime),
    oneTime90dUsd: round2(oneTime90d),
    deadMonthlyUsd: round2(dead),
    needsAmountCount: needsAmount,
    domainRenewalAnnualUsd: round2(domainRenewal),
    domainsExpiringSoon: expiring.sort((a, b) => a.days - b.days),
    domainCount,
    byCategory,
    byVendor,
    byBilling,
  };
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function usd(n: number): string {
  return "$" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US");
}

/* ============================ effectiveness ============================ */

/**
 * What each data source actually DID, not just what it cost. The OS Text engine already
 * scores every phone number it was handed: whether Telnyx confirmed it as a cell, whether
 * the text delivered, whether a human replied, and whether the reply said "wrong person".
 * Joining that against the spend register is the whole point of this dashboard: it turns
 * "$60/month" into "$1.13 per reply", which is the only number that settles an argument
 * about whether a data vendor is worth keeping.
 */
export interface OutcomeRow {
  source: string;
  checked: number;
  cellConfirmed: number;
  texted: number;
  delivered: number;
  replied: number;
  wrongNumber: number;
  optedOut: number;
}

export interface EffectivenessRow extends OutcomeRow {
  /** Friendly name, and the spend row it belongs to when one exists. */
  label: string;
  itemId?: string;
  vendor?: string;
  /** Share of numbers Telnyx confirmed as a mobile line. */
  cellRatePct: number;
  /** Share of sent texts the carrier accepted. */
  deliveryRatePct: number;
  /** Share of delivered texts that got a human reply. */
  replyRatePct: number;
  /** Share of delivered texts whose reply said it reached the wrong person. */
  wrongNumberPct: number;
  optOutPct: number;
  /** Monthly cost of the vendor behind this source, when it has one. */
  monthlyUsd: number;
  /** monthlyUsd / replies: the comparable unit across every source. */
  costPerReplyUsd: number | null;
}

/** Display names for the engine's source tags. */
const OUTCOME_LABELS: Record<string, string> = {
  skiptrace: "Skip Tracing (Boost phones)",
  laxis: "Laxis",
  koldinfo: "KoldInfo",
  landlinedb: "LandlineDB (in-house)",
  unknown: "Free rungs / unattributed",
};

/**
 * Pull the phone-accuracy scoreboard from the house OS Text engine. Owner-side, so it
 * reads the house engine directly rather than going through the per-workspace proxy.
 * Returns [] on any failure: the dashboard degrades to spend-only rather than erroring.
 */
export async function fetchPhoneOutcomes(): Promise<OutcomeRow[]> {
  const base = (process.env.RECRUITEROS_OSTEXT_URL || "").replace(/\/+$/, "");
  const token = process.env.RECRUITEROS_OSTEXT_TOKEN || "";
  if (!base || !token) return [];
  try {
    const res = await fetch(base + "/api/phone-accuracy", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { sources?: OutcomeRow[] } | null;
    return Array.isArray(data?.sources) ? (data as { sources: OutcomeRow[] }).sources : [];
  } catch {
    return [];
  }
}

function rate(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

/** Join outcomes to the spend rows that paid for them. */
export function rollupEffectiveness(outcomes: OutcomeRow[], items: SpendItem[]): EffectivenessRow[] {
  const byOutcomeSource = new Map<string, SpendItem>();
  for (const i of items) {
    const tag = i.link?.outcomeSource;
    if (tag) byOutcomeSource.set(tag, i);
  }
  return outcomes
    .map((o) => {
      const item = byOutcomeSource.get(o.source);
      const monthly = item ? monthlyEquivalent(item) : 0;
      return {
        ...o,
        label: OUTCOME_LABELS[o.source] || o.source,
        itemId: item?.id,
        vendor: item?.vendor,
        cellRatePct: rate(o.cellConfirmed, o.checked),
        deliveryRatePct: rate(o.delivered, o.texted),
        replyRatePct: rate(o.replied, o.delivered),
        wrongNumberPct: rate(o.wrongNumber, o.delivered),
        optOutPct: rate(o.optedOut, o.delivered),
        monthlyUsd: monthly,
        costPerReplyUsd: monthly > 0 && o.replied > 0 ? Math.round((monthly / o.replied) * 100) / 100 : null,
      };
    })
    .sort((a, b) => b.replied - a.replied);
}
