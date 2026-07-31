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
    amountUsd: 75, at: "2026-06-01", status: "active", verified: false,
    purpose: "Paid Google SERP for decision-maker naming (the site:linkedin.com/in X-ray), bought to replace the throttled free scrapers.",
    impact: "The naming bottleneck. A company lead is worth nothing until it has a named decision maker attached, and that step currently runs on free scrapers measured at a 0% success rate. This is the piece that turns company signals into people you can actually contact.",
    notes: "RAPID_WEBSEARCH_KEY is not set anywhere, so lib/inmarket/webSearch.ts no-ops. Confirm whether this subscription is still active: it appeared on the RapidAPI billing list at $150 but not on the later one.",
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
  {
    vendor: "Hume", label: "Empathic voice", category: "ai", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "Voice interface option wired into the vetting desks.",
    link: { envKeys: ["HUME_API_KEY"], integrationId: "hume" },
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
    vendor: "KoldInfo", label: "People and business email database", category: "people", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "Free-rung enrichment: 129M people and 57M business emails by name plus city/state.",
    impact: "Free enrichment rung carrying 14.7% of candidates with 100% email coverage. Its phones are weak (31% cell rate) but its emails are the cheapest in the stack.",
    link: { envKeys: ["KOLDINFO_EMAIL"], outcomeSource: "koldinfo" },
  },
  {
    vendor: "Laxis", label: "Contact enrichment", category: "people", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "Enrichment rung between KoldInfo and the paid phone sources.",
    impact: "The highest-accuracy phone source measured: 96.4% cell rate and 97.6% delivery. It runs before any paid phone rung, so every number it finds is a skip-trace charge avoided.",
    link: { envKeys: ["LAXIS_EMAIL"], outcomeSource: "laxis" },
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
  {
    vendor: "Loxo", label: "ATS seats", category: "software", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "System of record for the recruiting desk, two-way synced with every outbound channel.",
    impact: "System of record. Two-way sync plus the no-double-contact guard means the desk can run several outbound channels at once without a candidate hearing from two recruiters.",
    link: { envKeys: ["LOXO_API_KEY"], integrationId: "loxo" },
  },

  /* ---- Infrastructure ---- */
  {
    vendor: "Hetzner", label: "App server (ubuntu-8gb-ash-1, CCX13)", category: "infra", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-02", status: "active",
    purpose: "Runs the portal, the API, Postgres, Caddy, OS Text and every worker container.",
    impact: "The product. Everything the business sells runs on this one box.",
  },
  {
    vendor: "Hetzner", label: "Sourcing worker (recruiteros-worker-2, CPX11)", category: "infra", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-02", status: "active",
    purpose: "Self-sourcing worker box.",
  },
  {
    vendor: "Hetzner", label: "Scraper fleet (5 boxes)", category: "infra", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-10", status: "active",
    purpose: "Rotated-IP scraper fleet. Free name-discovery is rate-limited per IP, so these are currently low-yield.",
  },
  {
    vendor: "RackNerd", label: "Mailcow mail server (8GB)", category: "email", billing: "annual",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "mail.lumesp.com: the self-hosted mailbox fleet behind white-label sending.",
    impact: "Owning the mailboxes is what makes cold email economical: sending cost is the inbox, not a per-email API fee, and white-label tenants send from their own domain.",
  },
  {
    vendor: "RackNerd", label: "Validation nodes (3 boxes)", category: "infra", billing: "annual",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    purpose: "Port-25-open nodes for email validation probes.",
  },
  {
    vendor: "Object storage", label: "S3 bucket (video fleet, 30d retention)", category: "infra", billing: "metered",
    amountUsd: 0, at: "2026-07-01", status: "active",
    purpose: "Holds rendered personalized videos for the 4K/day video fleet.",
    link: { envKeys: ["ROS_S3_BUCKET"] },
  },
];

/* ============================ store ============================ */

interface RegisterStore {
  items: SpendItem[];
  /** Seed version already applied, so a redeploy never re-adds rows the owner deleted. */
  seededVersion: number;
}

const SEED_VERSION = 2;
const SNAP_KEY = "owner_spend_register_v1";

/**
 * Facts learned about a row AFTER it was already seeded into the live store.
 *
 * `applySeed` only ever ADDS missing rows, deliberately: a redeploy must never overwrite
 * a figure the owner typed. But a seeded row can also be seeded WRONG. Reoon went in as
 * an active credit line with a price still to find, when it is in fact a lifetime licence
 * bought outright years ago with no recurring fee at all. That is a correction to a guess,
 * not a change to anything the owner entered, so it is applied once, on the version bump,
 * and ONLY while the row is still untouched (`seeded`, no owner-entered amount).
 */
const SEED_CORRECTIONS: Array<{ vendor: string; label: string; patch: Partial<SpendItem> }> = [
  {
    vendor: "Reoon", label: "Email verifier",
    patch: {
      billing: "one_time", lifetime: true, needsAmount: false, amountUsd: 0,
      notes: SEED.find((s) => s.vendor === "Reoon")?.notes,
    },
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
      })
      .catch(() => { if (store.seededVersion < SEED_VERSION) applySeed(); });
  }
  return hydrated;
}
void ensureSpendRegisterReady();

/** Add any seed row not already present (matched on vendor + label), apply the corrections
 *  to rows the owner has never touched, then mark the version applied. Never overwrites an
 *  amount the owner has edited. */
function applySeed(): void {
  const have = new Set(store.items.map((i) => key(i.vendor, i.label)));
  for (const s of SEED) {
    if (have.has(key(s.vendor, s.label))) continue;
    store.items.push({ ...s, id: rid("spend"), seeded: true, createdAt: nowIso(), updatedAt: nowIso() });
  }
  for (const c of SEED_CORRECTIONS) {
    const item = store.items.find((i) => key(i.vendor, i.label) === key(c.vendor, c.label));
    // Untouched means: it came from the seed and no owner-entered figure sits on it.
    if (!item || !item.seeded || item.verified) continue;
    Object.assign(item, c.patch, { updatedAt: nowIso() });
  }
  store.seededVersion = SEED_VERSION;
  persist();
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

/* ---------------- domains ---------------- */

/**
 * Adopt every domain the sending fleet is actually using into the register, so the
 * domain list maintains itself instead of being retyped. Existing rows are left alone,
 * which makes this safe to run repeatedly. Returns the number of new rows.
 */
export async function importSendingDomains(): Promise<{ added: number; total: number }> {
  await ensureSpendRegisterReady();
  const found = new Set<string>();

  // The sender store is the authority on what the business actually sends from.
  const senders = await loadSnapshot<unknown>("senders_v1").catch(() => null);
  const scan = (o: unknown): void => {
    if (Array.isArray(o)) { for (const v of o) scan(v); return; }
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string" && /^(domain|sendingDomain|from|email|fromEmail)$/i.test(k)) {
        const m = /([a-z0-9-]+\.[a-z]{2,})$/i.exec(v.trim().toLowerCase());
        if (m) found.add(m[1]);
      } else scan(v);
    }
  };
  scan(senders);

  const have = new Set(store.items.filter((i) => i.domain).map((i) => i.domain));
  let added = 0;
  for (const domain of [...found].sort()) {
    if (have.has(domain)) continue;
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
      purpose: "Sending domain in the cold-email fleet.",
      seeded: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    added += 1;
  }
  if (added) persist();
  return { added, total: found.size };
}

/**
 * Refresh registration dates, expiry and registrar for every domain row from the public
 * registry. A lookup failure is recorded on the row and never clears a known date.
 */
export async function refreshDomainFacts(): Promise<{ checked: number; updated: number; failed: number }> {
  await ensureSpendRegisterReady();
  const rows = store.items.filter((i) => i.domain);
  if (!rows.length) return { checked: 0, updated: 0, failed: 0 };
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
      if (row.vendor === "Domain registrar") row.vendor = f.registrar;
    }
    row.updatedAt = nowIso();
    updated += 1;
  }
  persist();
  return { checked: rows.length, updated, failed };
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
