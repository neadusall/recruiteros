/**
 * RecruitersOS · In-Market · Daily prospect curation (the spine)
 *
 * This is the backbone that turns the raw hiring-signal pool into the MAIN deliverable: a daily,
 * de-duplicated database of REAL decision-makers attached to the specific jobs they own, with a
 * best-guess email and full provenance back to the signal — ready to push (behind a review gate)
 * into the BD Bulk MPC sender, and tracked at every stage.
 *
 *   pool signals (10–20K/day)
 *      → pick the top-scored, not-yet-curated companies
 *      → resolveDecisionMaker (free research: team page / news / GitHub)  [decisionMaker.ts]
 *      → CuratedProspect { signal provenance + decision-maker + email + status }
 *      → persist (deduped by person+company)
 *      → funnel counts (sourced → named → contactable → queued → enrolled), sliced by signal+function
 *      → review gate → enrollToBulk() → BD Bulk MPC campaign
 *
 * Cost discipline: 100% free. Decision-maker research is bounded + concurrency-capped; the email
 * is the free syntax guess (validated at send). Nothing leaves the building until a human approves
 * the batch (the chosen "daily review gate" posture).
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { resolveDecisionMaker, type DecisionMaker } from "./decisionMaker";
import type { KoldInfoExportRow, KoldInfoResult } from "./koldInfo";
import { classifyTitle, type JobFunction } from "../signals";

/* ------------------------------------------------------------------ */
/* The curated record                                                  */
/* ------------------------------------------------------------------ */

export type CurationStatus =
  | "sourced"       // signal + owning TITLE known; no name yet
  | "named"         // a real decision-maker resolved by free research
  | "contactable"   // named + a best-guess email built
  | "queued"        // approved in the review gate, pending enrollment
  | "enrolled"      // pushed into the BD Bulk MPC sender
  | "suppressed";   // skipped (dupe / opted-out / unusable)

export interface CuratedProspect {
  id: string;                       // stable: company+role anchor
  /* ---- signal provenance (WHERE this came from) ---- */
  company: string;
  domain?: string;
  industry?: string;
  signalType: string;               // hiring_velocity | job_posting | evergreen_role | …
  signalReason: string;             // human "why they're hiring"
  role: string;                     // the specific open role this prospect owns
  jobUrl?: string;                  // the actual job-posting / apply URL, so the screen capture targets the REAL job (not just the careers page)
  function: JobFunction;            // which desk
  score: number;                    // hiring-intent score of the source signal
  employeeCount?: number;           // company headcount (collected via Wikidata) — ICP fit + personalization
  /* ---- the decision-maker (WHO to reach) ---- */
  managerName?: string;
  managerTitle: string;             // resolved title, else the inferred owning title
  managerVia?: string;              // company_site | news | github
  managerTier: string;              // named | function_leader | company_only | …
  likelyEmail?: string;             // free syntax guess (unverified) OR a deep-pulled/found address
  emailPattern?: string;
  emailSource?: string;             // site_direct | site_pattern | guess | smtp_found | validated_external
  /** ALL candidate addresses, ranked by real-world prevalence (best first, includes likelyEmail).
   *  The SMTP validator walks these in order and promotes the first deliverable one to likelyEmail. */
  emailCandidates?: string[];
  /* ---- lifecycle / tracking ---- */
  status: CurationStatus;
  curatedAt: string;
  enrolledAt?: string;
  campaignId?: string;
  /* ---- email validation (fed continuously by the external validator) ---- */
  emailValidated?: boolean;     // true once the validator CONFIRMS a specific mailbox is deliverable
  emailInvalid?: boolean;       // true when the validator says it's undeliverable (do not send)
  emailCatchAll?: boolean;      // domain accepts all mail: best-pattern guess will deliver but the
                                // specific person is UNCONFIRMED — a tier of its own, NOT "valid"
  validatedAt?: string;
  /* ---- post-send tracking (filled from the sending engine by email) ---- */
  sentAt?: string;
  openedAt?: string;
  repliedAt?: string;
  bouncedAt?: string;
}

const KEY = "inmarket_curation_v1";
const MAX_STORE = 50_000;

async function load(): Promise<CuratedProspect[]> {
  const s = await loadSnapshot<CuratedProspect[]>(KEY);
  return Array.isArray(s) ? s : [];
}
async function save(rows: CuratedProspect[]): Promise<void> {
  await saveSnapshot(KEY, rows.slice(0, MAX_STORE));
}

/**
 * WRITE SERIALIZATION. The curation blob has many independent writers — the every-8-min
 * curation tick, the continuous email validator, the sending engine's event webhooks, and the
 * review-gate actions — and each does a full load → mutate → save overwrite. Without a lock, two
 * that interleave silently clobber each other (whoever saves last wins), so validations and
 * send-tracking would be lost over time. Every mutator runs its read-modify-write inside this
 * single in-process queue so the writes are serialized and none is ever dropped. (Single
 * container, single process — an in-memory chain is sufficient and avoids any DB-lock dependency.)
 */
let writeChain: Promise<unknown> = Promise.resolve();
function withCurationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive regardless of this op's outcome; never let a rejection break the queue.
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Stable id for a (company, role) decision-maker slot — dedupes across daily runs. */
function curationId(company: string, role: string): string {
  return ("cp_" + company + "_" + role).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 120);
}

/** Stable, ROLE-INDEPENDENT id for a company-level BUYER (Head of People / C-suite). Keyed by
 *  company + person so the same CEO surfaces ONCE no matter which open role's research found them —
 *  the merge then dedupes them company-wide instead of creating a copy per role. */
export function buyerCurationId(company: string, person: string): string {
  return ("cp_" + company + "_buyer_" + person).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 120);
}

function statusFor(dm: DecisionMaker): CurationStatus {
  // Contactable = a real name + a built email AND a domain that can actually receive mail. An
  // email guessed on a domain with no MX (emailDeliverable === false) is NOT contactable — it
  // would bounce, so it stays "named" and is held out of the send queue.
  if (dm.email?.email && dm.emailDeliverable !== false) return "contactable";
  if (dm.fullName) return "named";
  return "sourced";
}

/* ------------------------------------------------------------------ */
/* Daily curation run                                                  */
/* ------------------------------------------------------------------ */

export interface CurateOptions {
  /** How many companies to research this run (bounded — research is the cost). */
  limit?: number;
  /** Resolve at most this many decision-makers concurrently (politeness to free sources). */
  concurrency?: number;
  /** Only curate companies scoring at/above this hiring-intent threshold. */
  minScore?: number;
  /** Don't re-research a company already curated within this window — so each run ADVANCES to
   *  not-yet-done companies and only refreshes the stale ones. This is what walks the whole pool
   *  and keeps the list living instead of re-doing the same top companies every tick. */
  recuratAfterMs?: number;
  nowIso: string;
}

export interface CurateReport {
  considered: number;
  researched: number;
  named: number;
  contactable: number;
  newlyAdded: number;
  updated: number;
}

/** One lead from the pool, as the curator needs it (kept loose to avoid a hard import cycle). */
interface PoolLeadLite {
  company: string;
  domain?: string;
  industry?: string;
  signalType?: string;
  reason?: string;
  score?: number;
  employeeCount?: number;
  roleDetails?: Array<{ title: string; url?: string }>;
  roles?: string[];
  /** The lead's source/apply URL — used to recover the company's own domain when its host is
   *  the company site (not an ATS). One more free signal for the domain resolver. */
  sourceUrl?: string;
}

/**
 * Walk a batch of the highest-intent pool companies, resolve the decision-maker for each one's
 * top open role via free research, and upsert a CuratedProspect. Idempotent: re-running refreshes
 * existing rows (and never re-researches a company already enrolled). Returns a run report.
 */
export async function curateFromPool(leads: PoolLeadLite[], opts: CurateOptions): Promise<CurateReport> {
  const minScore = opts.minScore ?? 0;
  const limit = Math.min(opts.limit ?? 200, 4000);
  // Concurrency ceiling raised to 16: egress IP rotation spreads these across source IPs, so the
  // free sources aren't hammered from one address. Keep a ceiling so a bad opts value can't fan out unbounded.
  const concurrency = Math.min(Math.max(opts.concurrency ?? 4, 1), 16);

  const store = await load();
  const byId = new Map(store.map((r) => [r.id, r]));

  const now = Date.parse(opts.nowIso) || Date.now();
  const recuratAfterMs = opts.recuratAfterMs ?? 24 * 60 * 60 * 1000; // refresh a NAMED company at most daily
  // Unnamed (sourced) rows retry MUCH sooner: the free naming methods (search-engine scraping, team
  // pages) keep improving and a row with no name has nothing to lose by being re-researched. This is
  // what reprocesses the backlog of "sourced" companies so the NAMED count climbs instead of being
  // frozen for 24h behind the daily-refresh window.
  const RETRY_SOURCED_MS = 90 * 60 * 1000; // re-attempt naming on a still-unnamed company every ~90 min

  // PER-COMPANY MULTIPLIER: a company hiring across eng + sales + marketing has a DIFFERENT boss for
  // each function, and each is a real decision-maker. We research up to N distinct-function bosses
  // per company instead of just the top role — the lever that turns "companies/day" into
  // "thousands of named contacts/day" on free. Env-overridable.
  const dmPerCompany = Math.max(1, Number(process.env.INMARKET_DM_PER_COMPANY) || 3);

  // Highest-intent first; expand each company into its distinct-function roles, then research the
  // NOT-yet-done (company, role) slots before refreshing stale ones, never re-touching a locked one.
  // Each run advances through the pool; unnamed slots get repeated naming attempts until they resolve.
  const expanded: Array<{ lead: PoolLeadLite; role: string }> = [];
  for (const l of leads.filter((l) => l.company && (l.score ?? 0) >= minScore).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    for (const role of rolesByFunction(l, dmPerCompany)) expanded.push({ lead: l, role });
    if (expanded.length >= limit * 4) break; // bound the pre-filter expansion
  }
  const targets = expanded
    .filter(({ lead, role }) => {
      const existing = byId.get(curationId(lead.company, role));
      if (!existing) return true;                                      // never researched → do it
      if (existing.status === "enrolled" || existing.status === "queued") return false; // locked
      const age = now - (Date.parse(existing.curatedAt) || 0);
      // still no name → keep retrying on the fast window; named/contactable → daily refresh only.
      const due = existing.status === "sourced" ? Math.min(recuratAfterMs, RETRY_SOURCED_MS) : recuratAfterMs;
      return age >= due;
    })
    .slice(0, limit);

  let researched = 0, named = 0, contactable = 0;

  // Concurrency-capped worker pool over the targets. Research runs OUTSIDE the write lock (it's
  // slow, network-bound, seconds per batch); each worker produces a freshly-researched row but
  // does NOT touch the store. The store is merged in one short, locked critical section below —
  // so a long research window can't clobber validations / send-events that land meanwhile.
  const fresh = new Map<string, CuratedProspect>();
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const { lead, role } = targets[cursor++];
      let dm: DecisionMaker;
      try {
        dm = await resolveDecisionMaker(lead.company, role, { domain: lead.domain, companySize: lead.employeeCount, sourceUrl: lead.sourceUrl });
      } catch {
        continue;
      }
      researched++;
      if (dm.fullName) named++;
      if (dm.email?.email && dm.emailDeliverable !== false) contactable++;
      const row = buildCuratedRow(lead, role, dm, opts.nowIso);
      fresh.set(row.id, row);
      // PER-COMPANY BUYER MULTIPLIER: the same research pass also named the Head of People / CHRO and
      // the C-suite (the economic buyers for a recruiting engagement). Emit a contactable row for each,
      // keyed by company+person so they dedupe company-wide (one CEO row, not one per open role).
      for (const buyer of dm.others ?? []) {
        if (!buyer.fullName) continue;
        if (buyer.fullName.trim().toLowerCase() === (dm.fullName ?? "").trim().toLowerCase()) continue;
        if (buyer.fullName) named++;
        if (buyer.email?.email && buyer.emailDeliverable !== false) contactable++;
        const brow = buildCuratedRow(lead, role, buyer, opts.nowIso, buyerCurationId(lead.company, buyer.fullName));
        fresh.set(brow.id, brow);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const { newlyAdded, updated } = await mergeCuratedRows([...fresh.values()]);
  return { considered: targets.length, researched, named, contactable, newlyAdded, updated };
}

/**
 * Build a CuratedProspect from a researched decision-maker. Shared by the local curation tick AND
 * the distributed research workers (lib/inmarket worker script), so a row researched on a worker box
 * is byte-for-byte identical to one researched on the main server.
 */
export function buildCuratedRow(lead: PoolLeadLite, role: string, dm: DecisionMaker, nowIso: string, idOverride?: string): CuratedProspect {
  return {
    id: idOverride ?? curationId(lead.company, role),
    company: lead.company,
    // carry the VERIFIED domain the resolver found (the lead usually had none) so the read path /
    // re-runs build emails without re-resolving.
    domain: dm.domain ?? lead.domain,
    industry: lead.industry,
    signalType: lead.signalType ?? "job_posting",
    signalReason: lead.reason ?? "",
    role,
    // Use THIS role's own posting URL (not the company's first-role URL), so the screen capture
    // targets the exact job we're emailing about. roleShot then verifies the loaded page matches
    // this role's title before it screenshots, so the JD in the video always pairs with the email.
    jobUrl: urlForRole(lead, role),
    function: dm.function as JobFunction,
    score: Math.round(lead.score ?? 0),
    employeeCount: lead.employeeCount,
    managerName: dm.fullName,
    managerTitle: dm.title ?? dm.targetTitle,
    managerVia: dm.via,
    managerTier: dm.tier,
    likelyEmail: dm.email?.email,
    emailPattern: dm.email?.pattern,
    emailSource: dm.emailSource,
    // Keep the FULL ranked pattern set (best first), so when SMTP validation runs it tests every
    // candidate in order and promotes the first deliverable one — not just this single top guess.
    emailCandidates: dm.email?.email ? [dm.email.email, ...(dm.email.alternates ?? [])].filter(Boolean) : undefined,
    // a guess on a no-MX domain is dead on arrival — mark it invalid now so it never enrolls.
    emailInvalid: dm.emailDeliverable === false ? true : undefined,
    // the person's OWN published address (deep-pulled from the company site) is verified-grade —
    // mark it validated so it skips the verifier and counts as a confirmed contact.
    emailValidated: dm.emailConfirmed ? true : undefined,
    validatedAt: dm.emailConfirmed ? nowIso : undefined,
    status: statusFor(dm),
    curatedAt: nowIso,
  };
}

/**
 * Merge freshly-researched rows into the curation store under the write lock, against a FRESH load
 * (never a stale pre-research snapshot). Preserves any lifecycle the store accrued meanwhile
 * (enrollment, send-tracking) and any still-matching email-validation verdict; a row locked
 * (queued/enrolled) or suppressed concurrently is left untouched. Shared by the local tick and the
 * worker-submit path so distributed results merge exactly like local ones.
 */
export async function mergeCuratedRows(rows: CuratedProspect[]): Promise<{ newlyAdded: number; updated: number }> {
  let newlyAdded = 0, updated = 0;
  if (!rows.length) return { newlyAdded, updated };
  await withCurationLock(async () => {
    const current = await load();
    const map = new Map(current.map((r) => [r.id, r]));
    for (const incoming of rows) {
      const prev = map.get(incoming.id);
      if (prev && (prev.status === "enrolled" || prev.status === "queued" || prev.status === "suppressed")) {
        updated++; continue; // locked/suppressed since selection — don't overwrite its lifecycle
      }
      // NEVER DOWNGRADE a known decision-maker. When the free sources are degraded (search blocked,
      // domain resolution flaky), a re-research can come back with NO name — that must not ERASE a
      // name we already had (this is what eroded the Named count). If the new pull lost the name but
      // we had one, keep the prior person/email and only let the fresh data fill blanks.
      const row = (!incoming.managerName && prev?.managerName) ? {
        ...incoming,
        managerName: prev.managerName,
        managerTitle: prev.managerTitle,
        managerVia: prev.managerVia,
        managerTier: prev.managerTier,
        domain: incoming.domain ?? prev.domain,
        likelyEmail: incoming.likelyEmail ?? prev.likelyEmail,
        emailPattern: incoming.emailPattern ?? prev.emailPattern,
        emailSource: incoming.emailSource ?? prev.emailSource,
        emailCandidates: incoming.emailCandidates ?? prev.emailCandidates,
        status: prev.status === "contactable" ? "contactable" as const : "named" as const,
      } : incoming;
      const sameEmail = !!prev && (prev.likelyEmail ?? "") === (row.likelyEmail ?? "");
      map.set(row.id, {
        ...row,
        enrolledAt: prev?.enrolledAt, campaignId: prev?.campaignId,
        sentAt: prev?.sentAt, openedAt: prev?.openedAt, repliedAt: prev?.repliedAt, bouncedAt: prev?.bouncedAt,
        emailValidated: row.emailValidated ?? (row.emailInvalid ? false : (sameEmail ? prev?.emailValidated : undefined)),
        emailInvalid: row.emailInvalid ?? (sameEmail ? prev?.emailInvalid : undefined),
        validatedAt: row.validatedAt ?? (sameEmail ? prev?.validatedAt : undefined),
        status: sameEmail && prev?.emailInvalid ? "suppressed" : row.status,
      });
      if (prev) updated++; else newlyAdded++;
    }
    await save([...map.values()].sort((a, b) => b.score - a.score));
  });
  return { newlyAdded, updated };
}

/* ------------------------------------------------------------------ */
/* Distributed research: hand out work to worker servers               */
/* ------------------------------------------------------------------ */

// In-memory LEASE so two worker boxes (or rapid claims) don't research the same (company, role) at
// once. The merge is idempotent by id, so an expired-lease overlap only wastes a little work — this
// just keeps the fleet efficient. Single main process, so an in-memory map is sufficient.
const researchLeases = new Map<string, number>();
const LEASE_MS = 10 * 60 * 1000;

/**
 * Select a batch of (company, role) research jobs that are DUE (not freshly curated) for a worker to
 * pull. Mirrors curateFromPool's target selection, leases what it hands out, and skips already-leased
 * slots so concurrent workers get DIFFERENT work. Returns plain JSON jobs the worker can research.
 */
export async function claimResearchBatch(limit: number, minScore = 10): Promise<Array<{ lead: PoolLeadLite; role: string }>> {
  // FAIR DISPATCH (even load across the fleet): hand every box the SAME modest slice regardless of
  // what its batch is set to, so no single box grabs a huge chunk and races ahead. Each box claims a
  // little, researches, comes back — work spreads evenly and the boxes produce at a similar rate.
  // Enforced server-side, so it's uniform with no per-box config. Tune with INMARKET_CLAIM_FAIR_CAP.
  const FAIR_CAP = Math.max(5, Number(process.env.INMARKET_CLAIM_FAIR_CAP) || 40);
  const cap = Math.min(Math.max(limit, 1), FAIR_CAP);
  const { queryPool } = await import("./pool");
  const candidates = await queryPool({ limit: 6000 } as never, 6000).catch(() => [] as unknown[]);
  const store = await load();
  const byId = new Map(store.map((r) => [r.id, r]));
  const now = Date.now();
  const recuratAfterMs = 24 * 60 * 60 * 1000;
  const RETRY_SOURCED_MS = 90 * 60 * 1000;
  const dmPerCompany = Math.max(1, Number(process.env.INMARKET_DM_PER_COMPANY) || 3);

  // prune expired leases lazily so the map can't grow unbounded
  if (researchLeases.size > 50_000) for (const [k, exp] of researchLeases) if (exp <= now) researchLeases.delete(k);

  const leads = (candidates as Array<Record<string, unknown>>).map((l) => ({
    company: l.company as string, domain: l.domain as string | undefined, industry: l.industry as string | undefined,
    signalType: l.signalType as string | undefined, reason: l.reason as string | undefined, score: l.score as number | undefined,
    employeeCount: l.employeeCount as number | undefined, roleDetails: l.roleDetails as Array<{ title: string; url?: string }> | undefined,
    roles: l.roles as string[] | undefined, sourceUrl: l.sourceUrl as string | undefined,
  })) as PoolLeadLite[];

  const out: Array<{ lead: PoolLeadLite; role: string }> = [];
  for (const l of leads.filter((x) => x.company && (x.score ?? 0) >= minScore).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    for (const role of rolesByFunction(l, dmPerCompany)) {
      const id = curationId(l.company, role);
      const lease = researchLeases.get(id);
      if (lease && lease > now) continue;                              // another worker has it
      const existing = byId.get(id);
      let due = true;
      if (existing) {
        if (existing.status === "enrolled" || existing.status === "queued") due = false;
        else {
          const age = now - (Date.parse(existing.curatedAt) || 0);
          due = age >= (existing.status === "sourced" ? Math.min(recuratAfterMs, RETRY_SOURCED_MS) : recuratAfterMs);
        }
      }
      if (!due) continue;
      researchLeases.set(id, now + LEASE_MS);
      out.push({ lead: l, role });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** The exact apply/posting URL for ONE role at a company. Each role from the feed carries its own
 *  URL (roleDetails[i].url); we match by title so a multi-role company screenshots the RIGHT job per
 *  role instead of reusing role 1's URL for everything. Returns undefined when this role has no
 *  direct URL (aggregator-only) so roleShot falls back to careers-page discovery for THIS role,
 *  never another role's page. Only if the role isn't in roleDetails at all do we use the lead URL. */
function urlForRole(lead: PoolLeadLite, role: string): string | undefined {
  const t = (role || "").trim().toLowerCase();
  const hit = lead.roleDetails?.find((r) => (r.title || "").trim().toLowerCase() === t);
  return hit ? hit.url : lead.sourceUrl;
}

/** The role a company's decision-maker should be matched to: its first/most-recent open role. */
function topRole(l: PoolLeadLite): string | undefined {
  return l.roleDetails?.[0]?.title ?? l.roles?.[0];
}

/**
 * Up to `max` roles for a company covering DISTINCT job functions (the top role per function), so
 * we research a different boss per function instead of N variants of the same one. The company's
 * primary/top role is always included first; additional functions are added in posting order. This
 * is the per-company multiplier: one company hiring eng + sales + ops yields three decision-makers.
 */
function rolesByFunction(l: PoolLeadLite, max: number): string[] {
  const primary = topRole(l);
  if (!primary) return [];
  const roles = (l.roleDetails?.map((r) => r.title) ?? l.roles ?? []).map((t) => (t || "").trim()).filter(Boolean);
  const byFn = new Map<string, string>();
  byFn.set(classifyTitle(primary).function, primary); // the top role always leads
  for (const r of roles) {
    if (byFn.size >= max) break;
    const fn = classifyTitle(r).function;
    if (!byFn.has(fn)) byFn.set(fn, r);
  }
  return [...byFn.values()];
}

/* ------------------------------------------------------------------ */
/* Funnel — the real numbers, sliced by signal + function             */
/* ------------------------------------------------------------------ */

export interface CurationFunnel {
  total: number;
  byStatus: Record<CurationStatus, number>;
  bySignal: Array<{ signalType: string; total: number; contactable: number }>;
  byFunction: Array<{ function: string; total: number; contactable: number }>;
  /** Headline conversion: of companies researched, how many became a contactable named person. */
  contactableRate: number;
  /** Email-validation tallies fed by the continuous validator. */
  validated: number;
  invalid: number;
  /** Catch-all domains: deliverable best-guess, specific person UNCONFIRMED (its own tier, not "valid"). */
  catchAll: number;
  /* ---- DIAGNOSTICS: which gate is failing? ---- */
  /** Of all researched companies, how many got a NAME (the name-finding gate). */
  named: number;
  namedRate: number;
  /** Of NAMED rows, which free source produced the name (company_site | common_crawl | news | search |
   *  github | rapid_naming | …). The attribution that tells you WHICH source to invest in next, and lets
   *  you measure the impact of any naming-coverage change instead of flying blind. */
  namedByVia: Array<{ via: string; named: number }>;
  /** Distribution of curated rows across confidence tiers (named | function_leader | recruiter |
   *  company_only | …), with how many of each carry a name. Shows the quality mix behind `namedRate`. */
  byTier: Array<{ tier: string; total: number; named: number }>;
  /** Decision-makers freshly NAMED in the last 60 min — the live per-IP yield of THIS box's engine
   *  (the headline number for the one-box proving-ground test). */
  namedLastHour: number;
  /** Domain coverage on curated rows + the live resolver hit-rate (the domain gate). */
  domain: {
    curatedWithDomain: number;          // curated rows that carry a resolved domain
    curatedRate: number;                // …as a fraction of all curated rows
    resolverAttempts: number;           // companies the resolver has tried (cache size)
    resolverResolved: number;           // …that got a verified domain
    resolverWithMx: number;             // …that can also receive mail
    resolverRate: number;               // resolved / attempts — the true domain hit-rate
  };
  /** Where the curated emails came from — guess vs deep-pulled vs SMTP-found vs externally validated.
   *  This tells us how many "contacts" are real vs blind guesses at a glance. */
  emailBySource: Array<{ source: string; total: number; validated: number }>;
  /** Daily throughput toward the 5,000 valid-emails/day goal, so consistency is measurable. */
  daily: {
    target: number;                  // 5,000
    validToday: number;              // emails VALIDATED today (deliverable) — the headline number
    contactableToday: number;        // named + email built today (broader "results")
    projectedValid: number;          // today's pace projected to a full 24h
    onPace: boolean;                  // projectedValid >= target
    byDay: Array<{ date: string; valid: number; contactable: number }>; // last 7 days, recent first
  };
}

const DAILY_TARGET = 5000;
function dayOf(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(String(iso).replace(" ", "T"));
  return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export async function curationFunnel(): Promise<CurationFunnel> {
  const rows = await load();
  const byStatus = { sourced: 0, named: 0, contactable: 0, queued: 0, enrolled: 0, suppressed: 0 } as Record<CurationStatus, number>;
  const sig = new Map<string, { total: number; contactable: number }>();
  const fn = new Map<string, { total: number; contactable: number }>();
  const src = new Map<string, { total: number; validated: number }>();
  const via = new Map<string, number>();                                  // named-row attribution by source
  const tiers = new Map<string, { total: number; named: number }>();      // confidence-tier distribution
  let contactableOrBetter = 0, validated = 0, invalid = 0, catchAll = 0, named = 0, withDomain = 0, namedLastHour = 0;
  const hourAgoMs = Date.now() - 3_600_000;
  const byDay = new Map<string, { valid: number; contactable: number }>();
  const bump = (date: string | null, k: "valid" | "contactable") => {
    if (!date) return;
    const d = byDay.get(date) ?? { valid: 0, contactable: 0 };
    d[k]++; byDay.set(date, d);
  };
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.emailValidated) validated++;
    if (r.emailInvalid) invalid++;
    if (r.emailCatchAll) catchAll++;
    if (r.managerName) {
      named++;
      if ((Date.parse(r.curatedAt) || 0) > hourAgoMs) namedLastHour++;
      const vk = r.managerVia || "unknown";
      via.set(vk, (via.get(vk) ?? 0) + 1);
    }
    const tk = r.managerTier || "company_only";
    const tv = tiers.get(tk) ?? { total: 0, named: 0 };
    tv.total++; if (r.managerName) tv.named++; tiers.set(tk, tv);
    if (r.domain) withDomain++;
    // Daily rollup: a VALID email is counted on the day it was validated; a contactable result on
    // the day it was curated. Drives the live "N / 5,000 today" target tracker.
    if (r.emailValidated) bump(dayOf(r.validatedAt), "valid");
    if (r.status === "contactable" || r.status === "queued" || r.status === "enrolled") bump(dayOf(r.curatedAt), "contactable");
    if (r.likelyEmail) {
      const key = r.emailSource || "guess";
      const e = src.get(key) ?? { total: 0, validated: 0 };
      e.total++; if (r.emailValidated) e.validated++; src.set(key, e);
    }
    const isContactable = r.status === "contactable" || r.status === "queued" || r.status === "enrolled";
    if (isContactable) contactableOrBetter++;
    const s = sig.get(r.signalType) ?? { total: 0, contactable: 0 };
    s.total++; if (isContactable) s.contactable++; sig.set(r.signalType, s);
    const f = fn.get(r.function) ?? { total: 0, contactable: 0 };
    f.total++; if (isContactable) f.contactable++; fn.set(r.function, f);
  }
  const { domainResolverStats } = await import("./domain");
  const rs = await domainResolverStats().catch(() => ({ attempts: 0, resolved: 0, withMx: 0, rate: 0 }));
  // Daily target math: today's validated count, projected to 24h by how far into the day we are.
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const todayRow = byDay.get(today) ?? { valid: 0, contactable: 0 };
  const hoursElapsed = Math.max(0.25, (now.getTime() - Date.parse(today + "T00:00:00Z")) / 3_600_000);
  const projectedValid = Math.round((todayRow.valid / hoursElapsed) * 24);
  const last7 = [...byDay.entries()]
    .map(([date, v]) => ({ date, valid: v.valid, contactable: v.contactable }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 7);
  return {
    total: rows.length,
    byStatus,
    bySignal: [...sig.entries()].map(([signalType, v]) => ({ signalType, ...v })).sort((a, b) => b.total - a.total),
    byFunction: [...fn.entries()].map(([f, v]) => ({ function: f, ...v })).sort((a, b) => b.total - a.total),
    contactableRate: rows.length ? Math.round((contactableOrBetter / rows.length) * 100) / 100 : 0,
    validated,
    invalid,
    catchAll,
    named,
    namedRate: rows.length ? Math.round((named / rows.length) * 100) / 100 : 0,
    namedByVia: [...via.entries()].map(([v, n]) => ({ via: v, named: n })).sort((a, b) => b.named - a.named),
    byTier: [...tiers.entries()].map(([tier, v]) => ({ tier, ...v })).sort((a, b) => b.total - a.total),
    namedLastHour,
    domain: {
      curatedWithDomain: withDomain,
      curatedRate: rows.length ? Math.round((withDomain / rows.length) * 100) / 100 : 0,
      resolverAttempts: rs.attempts,
      resolverResolved: rs.resolved,
      resolverWithMx: rs.withMx,
      resolverRate: rs.rate,
    },
    emailBySource: [...src.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.total - a.total),
    daily: {
      target: DAILY_TARGET,
      validToday: todayRow.valid,
      contactableToday: todayRow.contactable,
      projectedValid,
      onPace: projectedValid >= DAILY_TARGET,
      byDay: last7,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Read + review-gate actions                                          */
/* ------------------------------------------------------------------ */

/** List curated prospects for review, newest-curated first, optionally filtered. */
export async function listCurated(opts?: {
  status?: CurationStatus;
  signalType?: string;
  function?: string;
  contactableOnly?: boolean;
  /** Show every researched company that got a real decision-maker NAME, even before an email is
   *  resolved — so the list populates fully now and the email becomes a later enrichment pass. */
  namedOnly?: boolean;
  /** Only rows whose email passed internal validation (a real, deliverable address — no guesses). */
  validatedOnly?: boolean;
  /** Filter to a single industry (exact match on the curated row's industry). */
  industry?: string;
  limit?: number;
}): Promise<CuratedProspect[]> {
  let rows = await load();
  if (opts?.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts?.signalType) rows = rows.filter((r) => r.signalType === opts.signalType);
  if (opts?.function) rows = rows.filter((r) => r.function === opts.function);
  if (opts?.industry) rows = rows.filter((r) => (r.industry ?? "") === opts.industry);
  if (opts?.contactableOnly) rows = rows.filter((r) => !!r.likelyEmail);
  if (opts?.namedOnly) rows = rows.filter((r) => !!r.managerName);
  if (opts?.validatedOnly) rows = rows.filter((r) => r.emailValidated === true && !r.emailInvalid);
  // ENRICHMENT-FIRST ordering so the list always LEADS with the most actionable leads (a real person
  // + email), then named-but-email-pending, then title-only — each tier by hiring-intent score. This
  // keeps the best prospects on top even while the full list (incl. freshly-sourced rows) populates
  // and climbs underneath. Ties broken by most-recently-curated so new work surfaces.
  const rank = (r: CuratedProspect): number =>
    (r.status === "contactable" || r.status === "queued" || r.status === "enrolled") ? 0 : r.managerName ? 1 : 2;
  rows.sort((a, b) => rank(a) - rank(b) || b.score - a.score || (b.curatedAt > a.curatedAt ? 1 : -1));
  return rows.slice(0, opts?.limit ?? 500);
}

/**
 * Industry facets for the Hire Signals curated view's "search by industry" dropdown: every distinct
 * industry present on the curated rows, with how many are contactable (a real person + email) and
 * how many are enriched-and-validated. Sorted by enriched volume so the richest desks lead the menu.
 */
export async function curatedIndustries(): Promise<Array<{ industry: string; total: number; contactable: number; validated: number }>> {
  const rows = await load();
  const m = new Map<string, { total: number; contactable: number; validated: number }>();
  for (const r of rows) {
    const ind = (r.industry ?? "").trim();
    if (!ind) continue;
    const e = m.get(ind) ?? { total: 0, contactable: 0, validated: 0 };
    e.total++;
    if (r.status === "contactable" || r.status === "queued" || r.status === "enrolled") e.contactable++;
    if (r.emailValidated === true && !r.emailInvalid) e.validated++;
    m.set(ind, e);
  }
  return [...m.entries()]
    .map(([industry, v]) => ({ industry, ...v }))
    .sort((a, b) => b.validated - a.validated || b.contactable - a.contactable || b.total - a.total);
}

/** Whether the BD-Bulk pipeline requires a VALIDATED email. OFF by default so we build large lists
 *  now from the syntax guesses (full name + title + company + company URL + email). Flip
 *  INMARKET_REQUIRE_VALIDATED=1 once SMTP (port 25) or a paid validator is live to switch the whole
 *  pipeline (approve + enroll + auto-enroll) to validated-only with no redeploy. */
export function requireValidatedEmail(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.INMARKET_REQUIRE_VALIDATED || "").toLowerCase());
}

/** Mark a set of curated prospects approved (queued) in the daily review gate. Requires a real
 *  person + a non-dead email; validation is required only when INMARKET_REQUIRE_VALIDATED is set. */
export async function approveForBulk(ids: string[]): Promise<number> {
  const set = new Set(ids);
  const needValid = requireValidatedEmail();
  return withCurationLock(async () => {
    const rows = await load();
    let n = 0;
    for (const r of rows) {
      if (set.has(r.id) && r.status === "contactable" && !!r.likelyEmail && !r.emailInvalid
        && (!needValid || r.emailValidated === true)) {
        r.status = "queued"; n++;
      }
    }
    if (n) await save(rows);
    return n;
  });
}

/** Stamp prospects as enrolled once the enroll seam has handed them to the BD Bulk sender. */
export async function markEnrolled(ids: string[], campaignId: string, nowIso: string): Promise<number> {
  const set = new Set(ids);
  return withCurationLock(async () => {
    const rows = await load();
    let n = 0;
    for (const r of rows) {
      if (set.has(r.id)) { r.status = "enrolled"; r.enrolledAt = nowIso; r.campaignId = campaignId; n++; }
    }
    if (n) await save(rows);
    return n;
  });
}

/**
 * The review-gate ACTION: take approved (queued) curated prospects and enroll them into the BD
 * Bulk MPC sender by creating a real Prospect on the campaign (the existing addProspect path,
 * tagged BD / in_market with the signal carried through so the MPC drafter speaks to it). Only
 * contactable rows (a real name + email guess) are enrolled; the rest are skipped. Returns how
 * many were enrolled. This is the bridge from curation → the warmed Postal sending pool.
 */
export async function enrollToBulk(
  workspaceId: string,
  campaignId: string,
  ids: string[],
  nowIso: string,
): Promise<{ enrolled: number; skipped: number }> {
  const set = new Set(ids);
  const rows = await load();
  const { addProspect } = await import("../prospects");
  let enrolled = 0, skipped = 0;
  const enrolledIds = new Set<string>();
  // Do the (slow, network) addProspect calls WITHOUT holding the write lock; collect which ids
  // succeeded, then stamp their status in one short locked section against a fresh load so a
  // concurrent tick/validator can't clobber the enrollment (or be clobbered by it).
  const needValid = requireValidatedEmail();
  for (const r of rows) {
    if (!set.has(r.id)) continue;
    // Always need a real person + an email + a domain (likelyEmail implies a domain), and never an
    // address free checks already proved dead (emailInvalid). VALIDATION is gated by a flag: while
    // it's OFF (default, pre-port-25) we build large lists from the syntax guesses; once
    // INMARKET_REQUIRE_VALIDATED=1 (SMTP/paid validator live) only validated addresses enroll.
    if (!r.managerName || !r.likelyEmail || r.emailInvalid) { skipped++; continue; }
    if (needValid && r.emailValidated !== true) { skipped++; continue; }
    try {
      await addProspect({
        workspaceId,
        campaignId,
        fullName: r.managerName,
        email: r.likelyEmail,           // validated address (not a guess)
        company: r.company,
        companyDomain: r.domain,
        title: r.managerTitle,
        category: "in_market",
        motion: "bd",
        signalType: r.signalType,
        signalReason: r.signalReason,
        warmth: Math.max(50, r.score),
      });
      enrolledIds.add(r.id);
      enrolled++;
    } catch {
      skipped++;
    }
  }
  if (enrolledIds.size) {
    await withCurationLock(async () => {
      const current = await load();
      for (const r of current) {
        if (enrolledIds.has(r.id)) { r.status = "enrolled"; r.enrolledAt = nowIso; r.campaignId = campaignId; }
      }
      await save(current);
    });
  }
  return { enrolled, skipped };
}

/**
 * CONTINUOUS EMAIL VALIDATION feed. The external validator calls this with verdicts; we stamp the
 * matching curated prospect(s). A `valid:false` marks the address undeliverable so it's never
 * enrolled; `valid:true` upgrades it to a confirmed contact. Accepts a batch so the validator can
 * stream results. Returns how many rows were updated.
 */
export async function applyEmailValidation(
  results: Array<{ email: string; valid: boolean }>,
  nowIso: string,
): Promise<number> {
  if (!results.length) return 0;
  const verdict = new Map<string, boolean>();
  for (const r of results) { const e = (r.email || "").toLowerCase().trim(); if (e) verdict.set(e, r.valid); }
  return withCurationLock(async () => {
    const rows = await load();
    let n = 0;
    for (const r of rows) {
      const e = (r.likelyEmail ?? "").toLowerCase();
      if (!e || !verdict.has(e)) continue;
      const valid = verdict.get(e)!;
      r.emailValidated = valid;
      r.emailInvalid = !valid;
      r.validatedAt = nowIso;
      if (valid) { if (!r.emailSource || r.emailSource === "guess") r.emailSource = "validated_external"; }
      // A validated address is a confirmed contactable; an invalid one drops out of the send queue.
      if (!valid && (r.status === "contactable" || r.status === "queued")) r.status = "suppressed";
      n++;
    }
    if (n) await save(rows);
    return n;
  });
}

/* ------------------------------------------------------------------ */
/* KoldInfo enrichment — CSV round-trip, the FIRST rung                 */
/* ------------------------------------------------------------------ */

/**
 * Prepare a KoldInfo enrichment batch — the FIRST rung, run at the top of the funnel. Targets every
 * slot with a resolved domain that has no confirmed/catch-all address yet and isn't locked, INCLUDING
 * un-named ones: KoldInfo finds the person by company + title, so it can name AND email cold before
 * the free research/permutation hop ever runs. Sorted by hiring intent, capped to `limit`.
 *
 * mode "seed" (default): ONE representative slot per domain. A single KoldInfo lookup learns that
 *   domain's email format; the pattern cache then constructs the remaining colleagues at that domain
 *   for ~1 Reoon credit each on the next validator tick — so we buy whole domains, not single rows.
 * mode "all": every un-confirmed slot (use when you'd rather KoldInfo resolve each person directly).
 */
export async function koldInfoExportRows(opts: { limit?: number; mode?: "seed" | "all" } = {}): Promise<KoldInfoExportRow[]> {
  const { splitFullName } = await import("./email");
  const limit = Math.max(0, opts.limit ?? 4000);
  const mode = opts.mode ?? "seed";
  const rows = await load();
  const pool = rows
    .filter((r) => r.domain && !r.emailValidated && !r.emailCatchAll
      && r.status !== "enrolled" && r.status !== "queued" && r.status !== "suppressed")
    .sort((a, b) => b.score - a.score);

  let picked: CuratedProspect[];
  if (mode === "seed") {
    const perDomain = new Map<string, CuratedProspect>();
    for (const r of pool) { const d = r.domain!.toLowerCase(); if (!perDomain.has(d)) perDomain.set(d, r); }
    picked = [...perDomain.values()].slice(0, limit);
  } else {
    picked = pool.slice(0, limit);
  }

  return picked.map((r) => {
    const nm = r.managerName ? splitFullName(r.managerName) : {};
    const lk = r as { managerLinkedin?: string; linkedinUrl?: string };
    return {
      rosId: r.id,
      firstName: nm.firstName || "",
      lastName: nm.lastName || "",
      fullName: r.managerName || "",
      company: r.company,
      domain: r.domain!,
      title: r.managerTitle || r.role || "",   // the target title so KoldInfo finds the right person
      linkedin: lk.managerLinkedin || lk.linkedinUrl || undefined,
    };
  });
}

/** company|domain bucket key for distributing a company's returned contacts across its open slots. */
function koldCompanyKey(company: string | undefined, domain: string | undefined): string {
  return ((company || "") + "|" + (domain || "")).toLowerCase().replace(/[^a-z0-9|.]/g, "");
}

/**
 * Merge a parsed KoldInfo result set back into the curated pool. For each returned contact it re-links
 * to a prospect — by our passthrough ros_id first, else to an un-claimed slot at the same company/
 * domain (so a company lookup that returns several people fills that company's other decision-maker
 * slots). It LEARNS THE NAME for an un-named slot, then RE-VERIFIES every address through the Reoon
 * credits we already own before trusting it (a vendor "verified" flag is never taken at face value),
 * and TEACHES the per-domain pattern cache from each confirmed hit so one address unlocks the whole
 * domain. Never clobbers an already-validated row; a Reoon-rejected address is counted and discarded.
 */
export async function applyKoldInfoResults(
  results: KoldInfoResult[],
  nowIso: string,
): Promise<{ matched: number; named: number; found: number; catchAll: number; invalid: number; pending: number; unmatched: number }> {
  const summary = { matched: 0, named: 0, found: 0, catchAll: 0, invalid: 0, pending: 0, unmatched: 0 };
  if (!results.length) return summary;
  const { verifyDetailedBatch } = await import("./emailVerify");
  const { learnFromConfirmedEmail, inferPattern, flushPatternCache } = await import("./emailPattern");

  return withCurationLock(async () => {
    const rows = await load();
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    // company/domain -> open (un-confirmed, unlocked) slots, best score first, un-named preferred.
    const bucket = new Map<string, CuratedProspect[]>();
    for (const r of rows) {
      if (!r.domain || r.emailValidated || r.emailCatchAll) continue;
      if (r.status === "enrolled" || r.status === "queued" || r.status === "suppressed") continue;
      const k = koldCompanyKey(r.company, r.domain);
      const list = bucket.get(k); if (list) list.push(r); else bucket.set(k, [r]);
    }
    for (const list of bucket.values()) list.sort((a, b) => (Number(!!a.managerName) - Number(!!b.managerName)) || (b.score - a.score));

    // 1) Re-link each returned contact to a prospect.
    const linked: Array<{ row: CuratedProspect; email: string; name?: string }> = [];
    const claimed = new Set<string>();
    const pickSlot = (dom: string): CuratedProspect | undefined => {
      for (const [k, list] of bucket) {
        if (!k.endsWith("|" + dom)) continue;
        const s = list.find((r) => !claimed.has(r.id));
        if (s) return s;
      }
      return undefined;
    };
    for (const res of results) {
      const email = (res.email || "").toLowerCase().trim();
      if (!email || !email.includes("@")) continue;
      const name = res.fullName || [res.firstName, res.lastName].filter(Boolean).join(" ").trim() || undefined;
      const dom = (res.domain || email.split("@")[1] || "").toLowerCase();
      let row = res.rosId ? byId.get(res.rosId) : undefined;
      if (row && (claimed.has(row.id) || row.emailValidated)) row = undefined;
      if (!row) row = (bucket.get(koldCompanyKey(res.company, dom))?.find((r) => !claimed.has(r.id))) || pickSlot(dom);
      if (!row) { summary.unmatched++; continue; }
      if (claimed.has(row.id) || row.emailValidated) continue;
      claimed.add(row.id);
      linked.push({ row, email, name });
      summary.matched++;
    }
    if (!linked.length) return summary;

    // 2) RE-VERIFY every KoldInfo address through our own Reoon credits before trusting it.
    const verdicts = await verifyDetailedBatch(linked.map((l) => ({ id: l.row.id, email: l.email })));

    // 3) Merge. Fill the name for an un-named slot, then apply the verdict; a Reoon-rejected address is
    //    counted and discarded rather than written over the row.
    for (const { row, email, name } of linked) {
      const v = verdicts.get(row.id);
      const status = v?.status;
      if (status === "invalid" || v?.reason === "role_account") { summary.invalid++; continue; }

      if (name && !row.managerName) {
        row.managerName = name;
        row.managerVia = "koldinfo";
        if (!row.managerTier || row.managerTier === "company_only") row.managerTier = "named";
        summary.named++;
      }
      row.likelyEmail = email;
      const pat = inferPattern(row.managerName, email);
      if (pat) row.emailPattern = pat;
      if (!row.emailCandidates) row.emailCandidates = [];
      if (!row.emailCandidates.includes(email)) row.emailCandidates.unshift(email);
      row.emailSource = "koldinfo";

      if (status === "valid") {
        row.emailValidated = true; row.emailInvalid = false; row.emailCatchAll = false; row.validatedAt = nowIso;
        if (row.status === "sourced" || row.status === "named") row.status = "contactable";
        summary.found++;
        await learnFromConfirmedEmail(row.managerName, email, "koldinfo").catch(() => {});
      } else if (status === "risky" && v?.reason === "catch_all") {
        row.emailCatchAll = true; row.emailValidated = false; row.emailInvalid = false;
        summary.catchAll++;
      } else {
        // deliverable / unknown / no verdict (e.g. Reoon not keyed yet) — we now HAVE a real address
        // (and often a name) where there was none; leave it pending for the validator to confirm.
        summary.pending++;
      }
    }
    await save(rows);
    try { await flushPatternCache(true); } catch { /* best-effort */ }
    return summary;
  });
}

/**
 * EMAIL FINDER PASS (opt-in, SMTP) — turn more prospects VALID without guessing-and-bouncing.
 * For pending rows (a real person + a domain, no verdict yet), walk the name's permutations and
 * SMTP-verify until one is accepted; on a hit, REPLACE the guess with the verified address and
 * mark it validated. This also promotes "named" rows that never had a deliverable email into
 * contactable. No-op unless SMTP is enabled (needs outbound port 25). Bounded + concurrency-capped
 * so it never hammers a single MTA. Returns how many were checked / newly verified.
 */
export async function findEmailsBySmtp(limit: number, nowIso: string, concurrency = 4): Promise<{ checked: number; found: number }> {
  const { smtpEnabled, findVerifiedEmail } = await import("./emailVerify");
  if (!smtpEnabled()) return { checked: 0, found: 0 };

  const rows = await load();
  const targets = rows
    .filter((r) => r.managerName && r.domain && !r.emailValidated && !r.emailInvalid
      && r.status !== "enrolled" && r.status !== "queued" && r.status !== "suppressed")
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
  if (!targets.length) return { checked: 0, found: 0 };

  const hits = new Map<string, { email: string; pattern: string }>();
  let cursor = 0, checked = 0;
  async function worker() {
    while (cursor < targets.length) {
      const r = targets[cursor++];
      checked++;
      try {
        const found = await findVerifiedEmail({ fullName: r.managerName }, r.domain!);
        if (found?.email) hits.set(r.id, { email: found.email, pattern: found.pattern });
      } catch { /* skip */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), 6) }, worker));

  if (hits.size) {
    await withCurationLock(async () => {
      const current = await load();
      for (const r of current) {
        const h = hits.get(r.id);
        if (!h) continue;
        if (r.status === "enrolled" || r.status === "queued" || r.status === "suppressed") continue; // locked
        r.likelyEmail = h.email;
        r.emailPattern = h.pattern;
        r.emailSource = "smtp_found";
        r.emailValidated = true;
        r.emailInvalid = false;
        r.validatedAt = nowIso;
        if (r.status === "sourced" || r.status === "named") r.status = "contactable";
      }
      await save(current);
    });
  }
  return { checked, found: hits.size };
}

/**
 * EMAIL FINDER via REOON — turn pending people into VALIDATED prospects without leaving any guess
 * unchecked. For each pending row (a real person + a domain, no verdict yet) walk the name's email
 * syntaxes through Reoon and keep the first deliverable one; catch-all domains keep the best-pattern
 * guess (it will deliver), and people whose every syntax is dead are suppressed. Works with no
 * outbound port 25 (Reoon verifies cloud-side). Per-domain no-MX is memoized so a company full of
 * people doesn't re-pay. Bounded by `limit`; concurrency-capped. No-op unless REOON_API_KEY is set.
 */
export async function findEmailsByReoon(limit: number, nowIso: string, concurrency = 4): Promise<{ checked: number; found: number; catchAll: number; invalid: number }> {
  const { reoonEnabled, findVerifiedEmailReoon } = await import("./emailVerify");
  if (!reoonEnabled()) return { checked: 0, found: 0, catchAll: 0, invalid: 0 };

  const rows = await load();
  // Seed the per-domain format cache from colleagues we've already confirmed (once per process), so
  // a company solved for one person constructs the rest. No-op unless INMARKET_PATTERN_CACHE=1.
  try { const { backfillFromRows } = await import("./emailPattern"); await backfillFromRows(rows); } catch { /* best-effort seed */ }
  const targets = rows
    .filter((r) => r.managerName && r.domain && !r.emailValidated && !r.emailInvalid && !r.emailCatchAll
      && r.status !== "enrolled" && r.status !== "queued" && r.status !== "suppressed")
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
  if (!targets.length) return { checked: 0, found: 0, catchAll: 0, invalid: 0 };

  type Find = { outcome: "found" | "catch_all" | "invalid" | "unknown"; email?: string; pattern?: string; domainDead?: boolean };
  const results = new Map<string, Find>();
  const deadDomains = new Set<string>(); // memoized no-MX domains
  let cursor = 0, checked = 0;
  async function worker() {
    while (cursor < targets.length) {
      const r = targets[cursor++];
      checked++;
      const d = (r.domain || "").toLowerCase();
      if (deadDomains.has(d)) { results.set(r.id, { outcome: "invalid", domainDead: true }); continue; }
      try {
        const res = await findVerifiedEmailReoon({ fullName: r.managerName }, r.domain!) as Find;
        results.set(r.id, res);
        if (res.domainDead) deadDomains.add(d);
      } catch { /* skip → leave pending, retried next tick */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), 6) }, worker));

  let found = 0, catchAll = 0, invalid = 0;
  await withCurationLock(async () => {
    const current = await load();
    for (const r of current) {
      // Normalize legacy rows: an earlier build marked catch-all as validated. Reclassify those
      // to the catch-all tier so they stop counting as "valid" (idempotent, runs until cleared).
      if (r.emailSource === "catch_all" && r.emailValidated) { r.emailValidated = false; r.emailCatchAll = true; }
      const res = results.get(r.id);
      if (!res) continue;
      if (r.status === "enrolled" || r.status === "queued" || r.status === "suppressed") continue; // locked
      if (res.outcome === "found" && res.email) {
        r.likelyEmail = res.email; r.emailPattern = res.pattern || r.emailPattern;
        r.emailSource = "reoon_found"; r.emailValidated = true; r.emailInvalid = false; r.validatedAt = nowIso;
        if (r.status === "sourced" || r.status === "named") r.status = "contactable";
        found++;
      } else if (res.outcome === "catch_all") {
        // Domain accepts all mail → the best-pattern guess will deliver (no bounce), but we CANNOT
        // confirm the specific person. Its OWN tier — checked, kept, but NOT counted as "valid" and
        // NOT auto-promoted to contactable. emailCatchAll keeps it out of re-processing.
        if (res.email) r.likelyEmail = res.email;
        r.emailSource = "catch_all"; r.emailCatchAll = true; r.emailValidated = false; r.emailInvalid = false; r.validatedAt = nowIso;
        catchAll++;
      } else if (res.outcome === "invalid") {
        r.emailValidated = false; r.emailInvalid = true; r.validatedAt = nowIso;
        if (r.status === "contactable") r.status = "suppressed"; // (queued/enrolled already skipped above)
        invalid++;
      }
      // "unknown" → leave pending (transient; retried next tick)
    }
    await save(current);
  });
  try { const { flushPatternCache } = await import("./emailPattern"); await flushPatternCache(true); } catch { /* flush best-effort */ }
  return { checked, found, catchAll, invalid };
}

/**
 * RESIDUAL finder (paid, only-on-the-misses). For people the free path (permutation + Reoon) could
 * NOT resolve, resolve a real address via Icypeas, then RE-VERIFY it through the Reoon credits we
 * already own before trusting it. Targets misses only (emailInvalid, or named-but-no-email); never
 * re-touches found / catch-all / locked rows. Bounded by `limit` for cost control; Icypeas bills only
 * on a hit. No-op unless ICYPEAS_API_KEY + ICYPEAS_API_SECRET are set. Reopens rows the free finder
 * had marked invalid when the paid+Reoon path now confirms a real mailbox.
 */
export async function findEmailsByPaid(limit: number, nowIso: string, concurrency = 3): Promise<{ checked: number; found: number; missed: number }> {
  const { finderServiceEnabled, findManyViaService } = await import("./finderService");
  const { paidEmailEnabled, findEmailIcypeas } = await import("./paidEmail");
  const useService = finderServiceEnabled();          // preferred: the one finder-of-record (email-validate service)
  if (!useService && !paidEmailEnabled()) return { checked: 0, found: 0, missed: 0 };
  const { verifyEmailsReoon } = await import("./emailVerify");
  const { splitFullName } = await import("./email");
  const { learnFromConfirmedEmail, inferPattern } = await import("./emailPattern");

  const rows = await load();
  const targets = rows
    .filter((r) => r.managerName && r.domain && !r.emailValidated && !r.emailCatchAll
      && (r.emailInvalid || !r.likelyEmail)
      && r.status !== "enrolled" && r.status !== "queued" && r.status !== "suppressed")
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
  if (!targets.length) return { checked: 0, found: 0, missed: 0 };

  type Hit = { email: string; accept: boolean; pattern?: string; source: string };
  const results = new Map<string, Hit>();
  let checked = 0;

  if (useService) {
    // ONE batched call to the finder service (Findymail provider -> Reoon fallback -> pool verify).
    // The service returns pre-verified addresses, so a "found" is trusted without re-paying Reoon.
    const people = targets.map((r) => {
      const { firstName, lastName } = splitFullName(r.managerName);
      const lk = r as { managerLinkedin?: string; linkedinUrl?: string };
      return { first: firstName, last: lastName, name: r.managerName, domain: r.domain, linkedin: lk.managerLinkedin || lk.linkedinUrl || undefined };
    });
    const got = await findManyViaService(people);
    checked = targets.length;
    for (let i = 0; i < targets.length; i++) {
      const f = got[i];
      if (f && f.email && f.status === "found") {
        results.set(targets[i].id, { email: f.email, accept: true, pattern: inferPattern(targets[i].managerName, f.email) || undefined, source: f.source || "findymail" });
      }
    }
  } else {
    // Fallback: Icypeas per-row + Reoon re-verify (only when no finder service is configured).
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const r = targets[cursor++];
        checked++;
        try {
          const { firstName, lastName } = splitFullName(r.managerName);
          const found = await findEmailIcypeas(firstName, lastName, r.domain || r.company);
          if (!found) continue;
          const rv = await verifyEmailsReoon([found.email]);
          const verdict = rv.find((x) => x.email === found.email.toLowerCase());
          const accept = verdict ? verdict.valid : found.verified;
          results.set(r.id, { email: found.email, accept, pattern: inferPattern(r.managerName, found.email) || undefined, source: "icypeas" });
        } catch { /* skip → leave as-is, retried a later pass */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), 4) }, worker));
  }

  let found = 0, missed = 0;
  await withCurationLock(async () => {
    const current = await load();
    for (const r of current) {
      const hit = results.get(r.id);
      if (!hit) continue;
      if (r.status === "enrolled" || r.status === "queued" || r.status === "suppressed") continue;
      if (hit.accept) {
        r.likelyEmail = hit.email; if (hit.pattern) r.emailPattern = hit.pattern;
        r.emailSource = hit.source; r.emailValidated = true; r.emailInvalid = false; r.emailCatchAll = false; r.validatedAt = nowIso;
        if (r.status === "sourced" || r.status === "named") r.status = "contactable";
        found++;
        await learnFromConfirmedEmail(r.managerName, hit.email, hit.source).catch(() => {});
      } else { missed++; }
    }
    await save(current);
  });
  try { const { flushPatternCache } = await import("./emailPattern"); await flushPatternCache(true); } catch { /* flush best-effort */ }
  return { checked, found, missed };
}

/** The curated emails still needing validation — feed this list to the external validator. */
export async function pendingValidationEmails(limit = 1000): Promise<string[]> {
  const rows = await load();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const e = (r.likelyEmail ?? "").toLowerCase();
    if (!e || seen.has(e)) continue;
    if (r.emailValidated || r.emailInvalid || r.emailCatchAll) continue;   // already has a verdict
    seen.add(e); out.push(r.likelyEmail!);
    if (out.length >= limit) break;
  }
  return out;
}

/** Tie a sending-engine delivery/engagement event back to its curated prospect by email. */
export async function recordSendEvent(email: string, event: "sent" | "open" | "reply" | "bounce", nowIso: string): Promise<boolean> {
  const e = email.toLowerCase().trim();
  if (!e) return false;
  return withCurationLock(async () => {
    const rows = await load();
    let hit = false;
    for (const r of rows) {
      if ((r.likelyEmail ?? "").toLowerCase() === e) {
        if (event === "sent") r.sentAt = r.sentAt ?? nowIso;
        else if (event === "open") r.openedAt = r.openedAt ?? nowIso;
        else if (event === "reply") r.repliedAt = r.repliedAt ?? nowIso;
        else if (event === "bounce") r.bouncedAt = r.bouncedAt ?? nowIso;
        hit = true;
      }
    }
    if (hit) await save(rows);
    return hit;
  });
}
