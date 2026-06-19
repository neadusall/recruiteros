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
import type { JobFunction } from "../signals";

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
  function: JobFunction;            // which desk
  score: number;                    // hiring-intent score of the source signal
  /* ---- the decision-maker (WHO to reach) ---- */
  managerName?: string;
  managerTitle: string;             // resolved title, else the inferred owning title
  managerVia?: string;              // company_site | news | github
  managerTier: string;              // named | function_leader | company_only | …
  likelyEmail?: string;             // free syntax guess (unverified)
  emailPattern?: string;
  /* ---- lifecycle / tracking ---- */
  status: CurationStatus;
  curatedAt: string;
  enrolledAt?: string;
  campaignId?: string;
  /* ---- email validation (fed continuously by the external validator) ---- */
  emailValidated?: boolean;     // true once the validator confirms the address is deliverable
  emailInvalid?: boolean;       // true when the validator says it's undeliverable (do not send)
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
  roleDetails?: Array<{ title: string }>;
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
  const limit = Math.min(opts.limit ?? 200, 2000);
  const concurrency = Math.min(Math.max(opts.concurrency ?? 4, 1), 8);

  const store = await load();
  const byId = new Map(store.map((r) => [r.id, r]));

  const now = Date.parse(opts.nowIso) || Date.now();
  const recuratAfterMs = opts.recuratAfterMs ?? 24 * 60 * 60 * 1000; // refresh a company at most daily

  // Highest-intent first; research the NOT-yet-done companies before refreshing stale ones, and
  // never re-touch one that's already approved/enrolled. This is the rotation: each run advances
  // through the pool, so over the day the whole pool gets a decision-maker.
  const targets = leads
    .filter((l) => l.company && (l.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter((l) => {
      const role = topRole(l);
      if (!role) return false;
      const existing = byId.get(curationId(l.company, role));
      if (!existing) return true;                                      // never researched → do it
      if (existing.status === "enrolled" || existing.status === "queued") return false; // locked
      return now - (Date.parse(existing.curatedAt) || 0) >= recuratAfterMs;             // refresh only if stale
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
      const lead = targets[cursor++];
      const role = topRole(lead)!;
      let dm: DecisionMaker;
      try {
        dm = await resolveDecisionMaker(lead.company, role, { domain: lead.domain, companySize: lead.employeeCount, sourceUrl: lead.sourceUrl });
      } catch {
        continue;
      }
      researched++;
      if (dm.fullName) named++;
      if (dm.email?.email && dm.emailDeliverable !== false) contactable++;

      const id = curationId(lead.company, role);
      fresh.set(id, {
        id,
        company: lead.company,
        // carry the VERIFIED domain the resolver found (the lead usually had none) so the read
        // path / re-runs build emails without re-resolving.
        domain: dm.domain ?? lead.domain,
        industry: lead.industry,
        signalType: lead.signalType ?? "job_posting",
        signalReason: lead.reason ?? "",
        role,
        function: dm.function as JobFunction,
        score: Math.round(lead.score ?? 0),
        managerName: dm.fullName,
        managerTitle: dm.title ?? dm.targetTitle,
        managerVia: dm.via,
        managerTier: dm.tier,
        likelyEmail: dm.email?.email,
        emailPattern: dm.email?.pattern,
        // a guess on a no-MX domain is dead on arrival — mark it invalid now so it never enrolls.
        emailInvalid: dm.emailDeliverable === false ? true : undefined,
        status: statusFor(dm),
        curatedAt: opts.nowIso,
      });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // MERGE under the write lock against a FRESH load — never the stale snapshot taken before
  // research. For each researched row, preserve any lifecycle the store has accrued meanwhile
  // (enrollment, send-tracking) and any email validation verdict still matching the same address;
  // a row that got locked (queued/enrolled) or suppressed concurrently is left untouched.
  let newlyAdded = 0, updated = 0;
  if (fresh.size) {
    await withCurationLock(async () => {
      const current = await load();
      const map = new Map(current.map((r) => [r.id, r]));
      for (const [id, row] of fresh) {
        const prev = map.get(id);
        if (prev && (prev.status === "enrolled" || prev.status === "queued" || prev.status === "suppressed")) {
          updated++; continue; // locked/suppressed since selection — don't overwrite its lifecycle
        }
        const sameEmail = !!prev && (prev.likelyEmail ?? "") === (row.likelyEmail ?? "");
        map.set(id, {
          ...row,
          // carry forward downstream lifecycle recorded for this slot
          enrolledAt: prev?.enrolledAt, campaignId: prev?.campaignId,
          sentAt: prev?.sentAt, openedAt: prev?.openedAt, repliedAt: prev?.repliedAt, bouncedAt: prev?.bouncedAt,
          // keep the validation verdict only while it still describes the same address; a fresh
          // no-MX determination (row.emailInvalid) always stands.
          emailValidated: row.emailInvalid ? false : (sameEmail ? prev?.emailValidated : undefined),
          emailInvalid: row.emailInvalid ?? (sameEmail ? prev?.emailInvalid : undefined),
          validatedAt: sameEmail ? prev?.validatedAt : undefined,
          // a still-valid "invalid" verdict keeps the row out of the send queue
          status: sameEmail && prev?.emailInvalid ? "suppressed" : row.status,
        });
        if (prev) updated++; else newlyAdded++;
      }
      await save([...map.values()].sort((a, b) => b.score - a.score));
    });
  }
  return { considered: targets.length, researched, named, contactable, newlyAdded, updated };
}

/** The role a company's decision-maker should be matched to: its first/most-recent open role. */
function topRole(l: PoolLeadLite): string | undefined {
  return l.roleDetails?.[0]?.title ?? l.roles?.[0];
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
}

export async function curationFunnel(): Promise<CurationFunnel> {
  const rows = await load();
  const byStatus = { sourced: 0, named: 0, contactable: 0, queued: 0, enrolled: 0, suppressed: 0 } as Record<CurationStatus, number>;
  const sig = new Map<string, { total: number; contactable: number }>();
  const fn = new Map<string, { total: number; contactable: number }>();
  let contactableOrBetter = 0, validated = 0, invalid = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.emailValidated) validated++;
    if (r.emailInvalid) invalid++;
    const isContactable = r.status === "contactable" || r.status === "queued" || r.status === "enrolled";
    if (isContactable) contactableOrBetter++;
    const s = sig.get(r.signalType) ?? { total: 0, contactable: 0 };
    s.total++; if (isContactable) s.contactable++; sig.set(r.signalType, s);
    const f = fn.get(r.function) ?? { total: 0, contactable: 0 };
    f.total++; if (isContactable) f.contactable++; fn.set(r.function, f);
  }
  return {
    total: rows.length,
    byStatus,
    bySignal: [...sig.entries()].map(([signalType, v]) => ({ signalType, ...v })).sort((a, b) => b.total - a.total),
    byFunction: [...fn.entries()].map(([f, v]) => ({ function: f, ...v })).sort((a, b) => b.total - a.total),
    contactableRate: rows.length ? Math.round((contactableOrBetter / rows.length) * 100) / 100 : 0,
    validated,
    invalid,
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
  limit?: number;
}): Promise<CuratedProspect[]> {
  let rows = await load();
  if (opts?.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts?.signalType) rows = rows.filter((r) => r.signalType === opts.signalType);
  if (opts?.function) rows = rows.filter((r) => r.function === opts.function);
  if (opts?.contactableOnly) rows = rows.filter((r) => !!r.likelyEmail);
  rows.sort((a, b) => (b.curatedAt > a.curatedAt ? 1 : -1) || b.score - a.score);
  return rows.slice(0, opts?.limit ?? 500);
}

/** Mark a set of curated prospects approved (queued) in the daily review gate. */
export async function approveForBulk(ids: string[]): Promise<number> {
  const set = new Set(ids);
  return withCurationLock(async () => {
    const rows = await load();
    let n = 0;
    for (const r of rows) {
      if (set.has(r.id) && r.status === "contactable") { r.status = "queued"; n++; }
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
  for (const r of rows) {
    if (!set.has(r.id)) continue;
    if (!r.managerName || !r.likelyEmail || r.emailInvalid) { skipped++; continue; } // need a real person + a non-rejected email
    try {
      await addProspect({
        workspaceId,
        campaignId,
        fullName: r.managerName,
        email: r.likelyEmail,           // best-guess; validated by the sender before send
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
      // A validated address is a confirmed contactable; an invalid one drops out of the send queue.
      if (!valid && (r.status === "contactable" || r.status === "queued")) r.status = "suppressed";
      n++;
    }
    if (n) await save(rows);
    return n;
  });
}

/** The curated emails still needing validation — feed this list to the external validator. */
export async function pendingValidationEmails(limit = 1000): Promise<string[]> {
  const rows = await load();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const e = (r.likelyEmail ?? "").toLowerCase();
    if (!e || seen.has(e)) continue;
    if (r.emailValidated || r.emailInvalid) continue;   // already has a verdict
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
