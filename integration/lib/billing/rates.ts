/**
 * RecruiterOS · Billing · Cost-rate catalog (OWNER ONLY)
 *
 * The single source of truth for what every action ACTUALLY costs us. Every
 * number here is a real unit cost (USD), not a price we charge. The owner
 * console reads this to compute per-account cost, recommended pricing, and
 * gross margin, and can override any rate at runtime (persisted snapshot).
 *
 * Philosophy carried from the rest of the engine: signals are FREE (public
 * ATS + government + RSS), contact enrichment is CHEAPEST-FIRST (a waterfall
 * blended cost, not a premium-provider price), and sending goes through the
 * customer's own warmed inboxes (so the marginal send cost is the inbox, not a
 * per-email API fee). These defaults are intentionally conservative (rounded
 * UP) so the margin we quote is the floor, not the ceiling.
 */

export type RateCategory =
  | "enrichment"
  | "sending"
  | "ai"
  | "signals"
  | "linkedin"
  | "messaging"
  | "infra";

/** One cost driver. `unitCostUsd` is what WE pay per `unit`. */
export interface CostRate {
  id: string;
  label: string;
  category: RateCategory;
  /** USD we pay per unit. 0 = free (e.g. public signal sources). */
  unitCostUsd: number;
  /** Human unit, for the UI ("per email resolved", "per inbox / month"). */
  unit: string;
  /** Where the number comes from / how to defend it in a board meeting. */
  note: string;
  /** Whether this cost scales per-prospect, per-send, or is fixed monthly. */
  scales: "per_prospect" | "per_send" | "per_reply" | "monthly_capacity" | "monthly_fixed";
}

/**
 * Capacity / behavioural constants used by the pricing math (not direct costs).
 * Tunable in the console alongside the rates.
 */
export interface PricingConstants {
  /** Sends per prospect across a sequence (drives unique-prospect count). */
  sequenceStepsPerProspect: number;
  /** Safe cold sends per warmed inbox per month (deliverability ceiling). */
  sendsPerInboxMonth: number;
  /** Inboxes hosted per sending domain (reference Accounts tab uses 3). */
  inboxesPerDomain: number;
  /** Share of prospects that reply (drives AI reply-classification volume). */
  replyRate: number;
  /** Target gross margin used to recommend a price (0..1). */
  targetGrossMargin: number;
  /** Email-find hit rate of the cheap-first waterfall (for coverage notes). */
  emailWaterfallHitRate: number;
}

export const DEFAULT_CONSTANTS: PricingConstants = {
  sequenceStepsPerProspect: 3,
  sendsPerInboxMonth: 750,
  inboxesPerDomain: 3,
  replyRate: 0.04,
  targetGrossMargin: 0.85,
  emailWaterfallHitRate: 0.88,
};

/**
 * Default unit costs. Edit here to change the shipped baseline; override at
 * runtime via the console (PATCH /api/owner/costs) to tune without a deploy.
 */
export const DEFAULT_RATES: CostRate[] = [
  // ---- Enrichment (the dominant variable cost; scales per unique prospect) ----
  {
    id: "email_find",
    label: "Email find (waterfall)",
    category: "enrichment",
    unitCostUsd: 0.006,
    unit: "per email resolved",
    note: "Cheapest-first waterfall (RapidAPI listings + Icypeas-class ~$0.003) blended across a 3-5 provider fallthrough. No single source beats ~50% coverage; the waterfall reaches 80-95%.",
    scales: "per_prospect",
  },
  {
    id: "email_verify",
    label: "Email verification",
    category: "enrichment",
    unitCostUsd: 0.001,
    unit: "per email verified",
    note: "Bulk SMTP/MX verification (e.g. Tomba/bouncer-class). Protects deliverability before a send touches a warmed inbox.",
    scales: "per_prospect",
  },
  {
    id: "mobile_find",
    label: "Mobile phone find (cheap-first, optional)",
    category: "enrichment",
    unitCostUsd: 0.02,
    unit: "per mobile resolved",
    note: "PLACEHOLDER rate, separate from landline by design. Deep research (May 2026) found NO trustworthy cheap RapidAPI mobile-find listing (every hit-rate/accuracy benchmark was refuted), so treat any cheap rung wired into RAPIDAPI_MOBILE_HOST/PATH as unverified and GATE it behind the Telnyx classify step (phone_classify). The realistic reliable source is the premium finder (see mobile_premium_backup, ~$0.39). OFF by default.",
    scales: "per_prospect",
  },
  {
    id: "landline_find",
    label: "Landline / direct-dial find (cheap-first, optional)",
    category: "enrichment",
    unitCostUsd: 0.015,
    unit: "per landline resolved",
    note: "PLACEHOLDER rate, separate from mobile by design. Wire a cheap RapidAPI phone-lookup listing into RAPIDAPI_LANDLINE_HOST/PATH. Landline / direct-dial coverage on cheap sources is higher than mobile but often an HQ switchboard, so pair with a validate pass. OFF by default.",
    scales: "per_prospect",
  },
  {
    id: "mobile_premium_backup",
    label: "Mobile, premium reveal (backup / realistic primary)",
    category: "enrichment",
    unitCostUsd: 0.39,
    unit: "per mobile resolved",
    note: "VERIFIED (deep research, May 2026): no reliable CHEAP mobile-find listing exists, so the realistic floor is a premium finder. Prospeo Mobile Finder ~$0.39/mobile ($39/mo / 1,000 credits, 10 credits each); Datagma ~$0.33-0.49; Apollo ~$1.60. Reached on a cheap-rung miss, or used as the primary mobile source.",
    scales: "per_prospect",
  },
  {
    id: "apify_direct_dial",
    label: "Direct-dial find (Apify ryanclinton / PDL)",
    category: "enrichment",
    unitCostUsd: 0.1,
    unit: "per direct dial found",
    note: "VERIFIED against the live actor (actor id ryanclinton~phone-number-finder): pay-per-result $0.10 per number FOUND (no-find records are free). The PERSON'S own direct line, looked up lazily at the email-sent trigger (Voice-Drop rule). Phone data comes from People Data Labs, so it ALSO needs your own PDL_API_KEY (free trial = 500 lookups / 30 days); without PDL it only website-scrapes a company line. Higher-trust than the cheap RapidAPI landline rung; still paired with the Telnyx classify step (phone_classify) before the voice channel dials it. Configure APIFY_TOKEN + PDL_API_KEY (+ APIFY_DIRECT_DIAL_ACTOR / APIFY_DIRECT_DIAL_MODE to override).",
    scales: "per_prospect",
  },
  {
    id: "landline_premium_backup",
    label: "Landline, premium reveal (backup, on miss only)",
    category: "enrichment",
    unitCostUsd: 0.1,
    unit: "per landline resolved",
    note: "Premium direct-dial reveal, typically cheaper than mobile (same providers: Prospeo/Datagma/Apollo). ONLY reached when the cheap landline lookup misses. NOT in the base estimate.",
    scales: "per_prospect",
  },
  {
    id: "phone_classify",
    label: "Phone classify (mobile vs landline, Telnyx)",
    category: "enrichment",
    unitCostUsd: 0.0025,
    unit: "per number classified",
    note: "VERIFIED: Telnyx Number Lookup splits MOBILE vs LANDLINE programmatically and reuses the Telnyx integration we already have. LRN $0.0015 / line-type (MCC-MNC) $0.0025 / CNAM $0.003 per query. THIS is the cheap, reliable way to route a found number into the mobile vs landline field, rather than trusting a scraper's own label. Twilio Lookup Line Type ($0.008) is the alternative.",
    scales: "per_prospect",
  },
  {
    id: "phone_reverse",
    label: "Reverse lookup (number to owner, Trestle, optional)",
    category: "enrichment",
    unitCostUsd: 0.07,
    unit: "per reverse lookup",
    note: "VERIFIED: Trestle Reverse Phone API $0.07/query (on RapidAPI + direct), returns owner name + line_type + alternate mobile/landline numbers. For inbound caller-ID and list cleaning. Vendor-claimed 90%+ accuracy (not independently tested). NOT in the base estimate.",
    scales: "per_prospect",
  },

  // ---- Sending (own warmed inboxes; marginal cost is the mailbox, not the API) ----
  {
    id: "inbox_month",
    label: "Mailbox (sending inbox)",
    category: "sending",
    unitCostUsd: 2.5,
    unit: "per inbox / month",
    note: "Reseller Google Workspace / Microsoft 365 mailbox ($1.50-3). We provision enough warmed inboxes to carry the monthly send volume at a safe per-inbox rate.",
    scales: "monthly_capacity",
  },
  {
    id: "domain_month",
    label: "Sending domain",
    category: "sending",
    unitCostUsd: 1.0,
    unit: "per domain / month",
    note: "Throwaway sending domain ($8-12/yr amortized) hosting ~3 inboxes each, kept separate from the primary domain to protect reputation.",
    scales: "monthly_capacity",
  },

  // ---- AI (Claude; only first-touch personalization + reply handling scale) ----
  {
    id: "ai_personalize",
    label: "AI personalization (first line)",
    category: "ai",
    unitCostUsd: 0.004,
    unit: "per prospect",
    note: "Claude Sonnet rapport-ladder first line, system prompt cached. ~800 in / 150 out tokens. Runs once per prospect, not per send.",
    scales: "per_prospect",
  },
  {
    id: "ai_classify_reply",
    label: "AI reply classification",
    category: "ai",
    unitCostUsd: 0.001,
    unit: "per reply processed",
    note: "6-class response routing (interested / OOO / referral / not-now / no / unsub). Small prompt, only fires on actual replies.",
    scales: "per_reply",
  },
  {
    id: "voice_clone_synthesis",
    label: "Voice clone synthesis (cache-miss only)",
    category: "ai",
    unitCostUsd: 0.02,
    unit: "per segment rendered",
    note: "ElevenLabs-class TTS for a Voice Drops segment (static prose, a first name, or a role). Charged ONLY on a cache MISS — identical names/roles/prose are synthesized once and reused forever at $0, so per-lead cost trends to zero as the cloned-snippet repository fills. Voice Drops also spends voice_minute per dialed call.",
    scales: "per_send",
  },

  // ---- Person enrichment (put a NAME on a company-level free signal) ----
  {
    id: "person_enrich",
    label: "Person enrich (Fresh LinkedIn data, optional)",
    category: "enrichment",
    unitCostUsd: 0.005,
    unit: "per profile resolved",
    note: "Fresh LinkedIn Profile Data on RapidAPI (~$49/mo for 10k credits = ~$0.005/lookup). Only needed when a free signal is company-level and we must resolve the hiring manager's name before the email step. NOT in the base estimate; add when a campaign sources company-level signals.",
    scales: "per_prospect",
  },

  // ---- Signals (FREE public sources by default; one cheap paid augment) ----
  {
    id: "signals_free",
    label: "Hiring/intent signals (public sources)",
    category: "signals",
    unitCostUsd: 0.0,
    unit: "per signal",
    note: "Greenhouse/Lever/Ashby/Workable/SmartRecruiters/Recruitee public boards, SEC EDGAR, WARN, USAspending, HN who-is-hiring, GitHub, Google News RSS. $0 marginal cost by design.",
    scales: "per_prospect",
  },
  {
    id: "signal_paid_api",
    label: "Paid signal augment (RapidAPI JSearch, optional)",
    category: "signals",
    unitCostUsd: 0.002,
    unit: "per search",
    note: "RapidAPI JSearch job scraper (~$25-50/mo flat, or a few tenths of a cent per search). A cheap augment to the free boards for cross-board role coverage. NOT in the base estimate; free sources lead.",
    scales: "per_prospect",
  },

  // ---- LinkedIn (per-seat SaaS, not per-message; Alfred internal is free) ----
  {
    id: "linkedin_seat_month",
    label: "LinkedIn automation seat (optional)",
    category: "linkedin",
    unitCostUsd: 0.0,
    unit: "per account / month",
    note: "Alfred (internal engine) carries this at $0 = the default. Paid alternatives if a customer routes LinkedIn elsewhere: Unipile (~$10-30 per connected account/mo) or SalesRobot (~$99/mo per seat). Flat SaaS, does NOT scale per prospect.",
    scales: "monthly_fixed",
  },
  {
    id: "email_platform_month",
    label: "Email sending platform (Instantly, optional)",
    category: "sending",
    unitCostUsd: 0.0,
    unit: "per workspace / month",
    note: "Default sending is the customer's own warmed inboxes ($0 platform fee). Instantly is an OPTIONAL alternative at ~$37-97/mo flat (Growth/Hypergrowth) if a customer prefers a managed sender. Flat SaaS, not per email.",
    scales: "monthly_fixed",
  },

  // ---- Messaging (Telnyx; only if the AI SMS 'Money Maker' / voice is used) ----
  {
    id: "sms_segment",
    label: "SMS segment (Telnyx)",
    category: "messaging",
    unitCostUsd: 0.004,
    unit: "per segment",
    note: "Telnyx A2P 10DLC outbound segment + carrier fees. Optional; only the AI SMS feature spends here.",
    scales: "per_send",
  },
  {
    id: "voice_minute",
    label: "Voice minute (Telnyx)",
    category: "messaging",
    unitCostUsd: 0.007,
    unit: "per minute",
    note: "Telnyx outbound per-minute incl. Premium AMD. Optional; only the voice dialer spends here.",
    scales: "per_send",
  },
  {
    id: "ai_vetting_minute",
    label: "AI Vetting minute (Telnyx Voice AI)",
    category: "messaging",
    unitCostUsd: 0.10,
    unit: "per minute",
    note: "Inbound conversational vetting call: Telnyx Voice-AI realtime loop (STT + LLM + cloned-voice TTS) per minute, plus the carrier minute. Optional; only the AI Vetting feature spends here. The post-call scoring pass is a separate, small LLM cost.",
    scales: "per_send",
  },

  // ---- Infra (hosting/db/monitoring, allocated per active account) ----
  {
    id: "platform_account_month",
    label: "Platform infra (allocated)",
    category: "infra",
    unitCostUsd: 4.0,
    unit: "per active account / month",
    note: "Hetzner VPS + Postgres + monitoring + email seam, divided across active accounts. Drops per-account as you scale.",
    scales: "monthly_fixed",
  },
];

/** Map id -> rate, applying any runtime overrides on top of the defaults. */
export function resolveRates(overrides?: Record<string, number>): Record<string, CostRate> {
  const map: Record<string, CostRate> = {};
  for (const r of DEFAULT_RATES) {
    map[r.id] = overrides && r.id in overrides ? { ...r, unitCostUsd: overrides[r.id] } : r;
  }
  return map;
}

/** Convenience: a single rate's unit cost with overrides applied. */
export function rateCost(id: string, overrides?: Record<string, number>): number {
  if (overrides && id in overrides) return overrides[id];
  return DEFAULT_RATES.find((r) => r.id === id)?.unitCostUsd ?? 0;
}
