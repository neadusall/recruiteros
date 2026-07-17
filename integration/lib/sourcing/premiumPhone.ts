/**
 * RecruitersOS · JD Sourcing · Premium phone boost (the "$0.10 tool")
 *
 * The recruiter-triggered paid phone rung. It NEVER runs automatically: after the
 * free enrichment chain (KoldInfo, Laxis, LandlineDB, contact cache) has finished,
 * the JD Sourcing list offers "Boost phones" with an estimated cost; the recruiter
 * decides. The estimate comes from the workspace's own rolling hit rate, the run's
 * actual spend is written to the billing ledger attributed to the recruiter who
 * pressed the button, and the readout reports what it really cost.
 *
 * Engine reuse, not a rebuild: rows go through the REAL mobilePhone waterfall rung
 * (rapidMobileFinder first if configured, then the skip-trace listing), the contact
 * cache is consulted first and fed back after, and the found numbers still face the
 * forced Telnyx cell-line check when the list pushes to OS Text.
 */

import type { CandidateRow, SourcingRun } from "./types";
import { getCachedContact, putCachedContact } from "./cache";
import { stateFromLocation } from "./landlinePhones";
import {
  enrich, rapidMobileFinder,
  makeSkipTracePhoneProvider, skipTraceConfigured, skipTraceUnitCost, skipTraceBilling,
  type EnrichmentPlan, type EnrichmentProvider,
} from "../signals";
import { withWorkspaceCreds } from "../connected";
import { recordUsage } from "../billing/ledger";
import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

/* ------------------------------------------------------------------ */
/* Rolling hit-rate stats (per workspace, persisted)                   */
/* ------------------------------------------------------------------ */

export interface PremiumPhoneStats {
  /** Billable lookups attempted (cache hits are free and not counted). */
  calls: number;
  /** Lookups that produced a phone. */
  hits: number;
  /** Real USD spent, all time. */
  spentUsd: number;
  updatedAt: string;
}

const store: { byWorkspace: Record<string, PremiumPhoneStats> } = { byWorkspace: {} };

const SNAP_KEY = "premium_phone_stats";
const persist = debouncedSaver(SNAP_KEY, () => ({ byWorkspace: store.byWorkspace }));
let hydrated: Promise<void> | null = null;
function ready(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then((s) => { if (s?.byWorkspace) store.byWorkspace = s.byWorkspace; }).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}

/** Until a workspace has enough of its own history, quote the skip-trace norm. */
const DEFAULT_HIT_RATE = 0.55;
const MIN_CALLS_FOR_OWN_RATE = 20;

export async function getPremiumPhoneStats(ws: string): Promise<PremiumPhoneStats> {
  await ready();
  return store.byWorkspace[ws] ?? { calls: 0, hits: 0, spentUsd: 0, updatedAt: "" };
}

function bumpStats(ws: string, calls: number, hits: number, spentUsd: number): void {
  const s = store.byWorkspace[ws] ?? { calls: 0, hits: 0, spentUsd: 0, updatedAt: "" };
  s.calls += calls; s.hits += hits;
  s.spentUsd = Math.round((s.spentUsd + spentUsd) * 100) / 100;
  s.updatedAt = nowIso();
  store.byWorkspace[ws] = s;
  persist();
}

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

/**
 * Rows the paid rung would actually attempt: no phone yet, a real full name, and
 * not already bought once (a missed lookup is billed money; it is never repeated,
 * so repeated Boost presses only pay for fresh rows and the batch loop terminates).
 */
export function boostableRows(rows: CandidateRow[]): CandidateRow[] {
  return rows.filter((c) =>
    !(c.phone || "").trim() &&
    !c.premiumPhoneTriedAt &&
    (c.fullName || "").trim().split(/\s+/).length >= 2);
}

export interface PremiumPhoneQuote {
  configured: boolean;
  unitCostUsd: number;
  billing: "call" | "hit";
  /** Candidates still missing a phone that the tool can key on. */
  missing: number;
  /** Estimated spend for the whole missing set. */
  estCostUsd: number;
  /** Expected numbers found, from the workspace's own rolling hit rate. */
  estFinds: number;
  hitRate: number;
  /** How many billable lookups the hit rate is based on (0 = shipped default). */
  statsBasis: number;
}

export async function premiumPhoneQuote(ws: string, run: SourcingRun): Promise<PremiumPhoneQuote> {
  return withWorkspaceCreds(ws, async () => {
    const stats = await getPremiumPhoneStats(ws);
    const own = stats.calls >= MIN_CALLS_FOR_OWN_RATE;
    const hitRate = own ? stats.hits / Math.max(1, stats.calls) : DEFAULT_HIT_RATE;
    const unit = skipTraceUnitCost();
    const billing = skipTraceBilling();
    const missing = boostableRows(run.candidates).length;
    const estFinds = Math.round(missing * hitRate);
    const billedUnits = billing === "call" ? missing : estFinds;
    return {
      configured: skipTraceConfigured(),
      unitCostUsd: unit,
      billing,
      missing,
      estCostUsd: Math.round(billedUnits * unit * 100) / 100,
      estFinds,
      hitRate: Math.round(hitRate * 100) / 100,
      statsBasis: own ? stats.calls : 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export interface PremiumPhoneBatchResult {
  /** Rows attempted this batch (billable lookups; free cache fills excluded). */
  called: number;
  /** Phones found this batch (cache fills included in `found`, not in `called`). */
  found: number;
  /** Free fills answered from the contact cache. */
  cacheHits: number;
  /** Real USD spent this batch. */
  costUsd: number;
  /** Rows still missing a phone after this batch (drives the client's next batch). */
  remaining: number;
  /** Set when the listing errored repeatedly and the batch stopped early. */
  stoppedEarly?: string;
}

/** City = the text before the first comma of "Dallas, TX"-style locations. */
function cityFromLocation(location?: string): string {
  const first = String(location ?? "").split(",")[0]?.trim() ?? "";
  return /\d/.test(first) ? "" : first;
}

/**
 * Run the paid rung over the next `max` phone-less rows. Mutates rows in place;
 * the CALLER persists the run. `actor` attributes the ledger spend to the
 * recruiter who pressed the button.
 */
export async function runPremiumPhoneBoost(
  ws: string,
  run: SourcingRun,
  opts: { max?: number; actor?: { userId?: string; userEmail?: string } } = {},
): Promise<PremiumPhoneBatchResult> {
  return withWorkspaceCreds(ws, async () => {
    const unit = skipTraceUnitCost();
    const skipTrace = makeSkipTracePhoneProvider(unit);
    // The REAL mobile rung: the cheap generic finder first (skipped while
    // unconfigured), the skip-trace listing as the paid resolver. maxCost leaves
    // headroom for the cheap rung so a configured one never crowds out the paid one.
    const plan: EnrichmentPlan = {
      steps: [{
        field: "mobilePhone",
        providers: [rapidMobileFinder as EnrichmentProvider, skipTrace as EnrichmentProvider],
        mode: "first",
        acceptConfidence: 0.5,
        maxCost: unit + 0.02,
      }],
    };

    const max = Math.max(1, Math.min(opts.max ?? 20, 50));
    const targets = boostableRows(run.candidates);
    const batch = targets.slice(0, max);
    let called = 0, found = 0, cacheHits = 0, costUsd = 0;
    let consecutiveErrors = 0;
    let stoppedEarly: string | undefined;

    for (const c of batch) {
      const personKey = c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`;
      // Free first, always: a phone bought (or found) for this person in ANY run is reused.
      const cached = await getCachedContact(ws, personKey).catch(() => null);
      if (cached?.phone) { c.phone = cached.phone; cacheHits++; found++; continue; }

      const location = (c.location || "").trim() || (run.location || "").trim();
      const [first, ...rest] = (c.fullName || "").trim().split(/\s+/);
      try {
        const report = await enrich(plan, {
          fullName: c.fullName, firstName: first, lastName: rest.join(" "),
          companyName: c.company, name: c.company, title: c.title,
          linkedinUrl: c.linkedinUrl, email: (c.email || "").trim() || undefined,
          location,
          city: cityFromLocation(location),
          state: stateFromLocation(location),
        }, { now: nowIso() });
        called++;
        costUsd += report.totalCost;
        const attempts = report.results[0]?.attempts ?? [];
        const errored = attempts.length > 0 && attempts.every((a) => a.status === "error" || (a.status === "miss" && a.error === "not configured"));
        // A real (billed) attempt is stamped hit or miss, so it is never re-bought.
        // An errored attempt is NOT: nothing was billed, and fixing the listing
        // config should let these rows be tried again.
        if (!errored) c.premiumPhoneTriedAt = nowIso();
        consecutiveErrors = errored ? consecutiveErrors + 1 : 0;
        if (consecutiveErrors >= 4) {
          stoppedEarly = attempts.find((a) => a.error && a.error !== "not configured")?.error
            || "the Boost phones listing is not configured (Setup > JD Sourcing > Boost phones)";
          break;
        }
        const number = report.subject.mobilePhone;
        if (typeof number === "string" && number) {
          c.phone = number; found++;
          await putCachedContact(ws, personKey, {
            email: (c.email || "").trim() || undefined,
            phone: number,
          }).catch(() => {});
        }
      } catch {
        called++;
        consecutiveErrors++;
        if (consecutiveErrors >= 4) { stoppedEarly = "the phone listing kept erroring"; break; }
      }
    }

    costUsd = Math.round(costUsd * 100) / 100;
    if (called > 0 || costUsd > 0) {
      bumpStats(ws, called, found - cacheHits, costUsd);
      recordUsage({
        workspaceId: ws,
        motion: run.motion,
        category: "enrichment",
        type: "premium_phone_boost",
        source: "rapidapi_skiptrace",
        quantity: called,
        unitCostUsd: unit,
        costUsd,
        meta: {
          runId: run.id, runName: run.name,
          userId: opts.actor?.userId, userEmail: opts.actor?.userEmail,
          found, cacheHits,
        },
      });
    }

    return {
      called, found, cacheHits, costUsd,
      remaining: boostableRows(run.candidates).length,
      stoppedEarly,
    };
  });
}
