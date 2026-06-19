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

/** Stable id for a (company, role) decision-maker slot — dedupes across daily runs. */
function curationId(company: string, role: string): string {
  return ("cp_" + company + "_" + role).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 120);
}

function statusFor(dm: DecisionMaker): CurationStatus {
  if (dm.email?.email) return "contactable";
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

  // Highest-intent first; skip companies with no role, below threshold, or already enrolled.
  const targets = leads
    .filter((l) => l.company && (l.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter((l) => {
      const role = topRole(l);
      if (!role) return false;
      const existing = byId.get(curationId(l.company, role));
      return !existing || (existing.status !== "enrolled" && existing.status !== "queued");
    })
    .slice(0, limit);

  let researched = 0, named = 0, contactable = 0, newlyAdded = 0, updated = 0;

  // Concurrency-capped worker pool over the targets.
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const lead = targets[cursor++];
      const role = topRole(lead)!;
      let dm: DecisionMaker;
      try {
        dm = await resolveDecisionMaker(lead.company, role, { domain: lead.domain, companySize: lead.employeeCount });
      } catch {
        continue;
      }
      researched++;
      if (dm.fullName) named++;
      if (dm.email?.email) contactable++;

      const id = curationId(lead.company, role);
      const prev = byId.get(id);
      const row: CuratedProspect = {
        id,
        company: lead.company,
        domain: lead.domain,
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
        status: statusFor(dm),
        curatedAt: opts.nowIso,
        // preserve any downstream lifecycle already recorded for this slot
        enrolledAt: prev?.enrolledAt, campaignId: prev?.campaignId,
        sentAt: prev?.sentAt, openedAt: prev?.openedAt, repliedAt: prev?.repliedAt, bouncedAt: prev?.bouncedAt,
      };
      byId.set(id, row);
      if (prev) updated++; else newlyAdded++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  await save([...byId.values()].sort((a, b) => b.score - a.score));
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
}

export async function curationFunnel(): Promise<CurationFunnel> {
  const rows = await load();
  const byStatus = { sourced: 0, named: 0, contactable: 0, queued: 0, enrolled: 0, suppressed: 0 } as Record<CurationStatus, number>;
  const sig = new Map<string, { total: number; contactable: number }>();
  const fn = new Map<string, { total: number; contactable: number }>();
  let contactableOrBetter = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
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
  const rows = await load();
  let n = 0;
  for (const r of rows) {
    if (set.has(r.id) && r.status === "contactable") { r.status = "queued"; n++; }
  }
  if (n) await save(rows);
  return n;
}

/** Stamp prospects as enrolled once the enroll seam has handed them to the BD Bulk sender. */
export async function markEnrolled(ids: string[], campaignId: string, nowIso: string): Promise<number> {
  const set = new Set(ids);
  const rows = await load();
  let n = 0;
  for (const r of rows) {
    if (set.has(r.id)) { r.status = "enrolled"; r.enrolledAt = nowIso; r.campaignId = campaignId; n++; }
  }
  if (n) await save(rows);
  return n;
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
  for (const r of rows) {
    if (!set.has(r.id)) continue;
    if (!r.managerName || !r.likelyEmail) { skipped++; continue; } // need a real person + email
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
      r.status = "enrolled"; r.enrolledAt = nowIso; r.campaignId = campaignId;
      enrolled++;
    } catch {
      skipped++;
    }
  }
  if (enrolled) await save(rows);
  return { enrolled, skipped };
}

/** Tie a sending-engine delivery/engagement event back to its curated prospect by email. */
export async function recordSendEvent(email: string, event: "sent" | "open" | "reply" | "bounce", nowIso: string): Promise<boolean> {
  const e = email.toLowerCase().trim();
  if (!e) return false;
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
}
