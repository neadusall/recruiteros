/**
 * RecruitersOS · JD Sourcing · Premium phone boost (the paid skip-trace rung)
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
import { sourceFromProviderId } from "./phoneSources";
import { stateFromLocation } from "./landlinePhones";
import {
  enrich, rapidMobileFinder,
  makeSkipTracePhoneProvider, skipTraceConfigured, skipTraceUnitCost, skipTraceBilling,
  skipTraceCallsPerLookup,
  type EnrichmentPlan, type EnrichmentProvider,
} from "../signals";
import { withWorkspaceCreds } from "../connected";
import { recordUsage, userMonthSpend, ensureLedgerReady } from "../billing/ledger";
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
  // 4-decimal precision: at plan pricing a whole batch costs fractions of a cent
  // per request, and 2-decimal rounding would drift the running total badly.
  s.spentUsd = Math.round((s.spentUsd + spentUsd) * 10000) / 10000;
  s.updatedAt = nowIso();
  store.byWorkspace[ws] = s;
  persist();
}

/* ------------------------------------------------------------------ */
/* Per-recruiter monthly budget                                        */
/* ------------------------------------------------------------------ */

/**
 * Every recruiter gets a fixed Boost phones allowance per calendar month; the
 * ledger (spend attributed by meta.userEmail) is the source of truth for what
 * they have used. Enforcement lives HERE, on the server, not in the UI: the run
 * loop refuses to start (and hard-stops mid-batch) once the allowance is spent,
 * so no client can push a recruiter past the cap. Override the default with
 * BOOST_PHONES_MONTHLY_CAP_USD if the business changes the number.
 */
const DEFAULT_MONTHLY_CAP_USD = 150;

export function boostMonthlyCapUsd(): number {
  const env = Number(process.env.BOOST_PHONES_MONTHLY_CAP_USD);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MONTHLY_CAP_USD;
}

export interface BoostBudget {
  capUsd: number;
  /** This recruiter's Boost spend so far this calendar month. */
  spentUsd: number;
  remainingUsd: number;
}

export async function boostBudget(ws: string, userEmail: string): Promise<BoostBudget> {
  await ensureLedgerReady();
  const capUsd = boostMonthlyCapUsd();
  const spentUsd = userMonthSpend(ws, userEmail, "premium_phone_boost");
  return { capUsd, spentUsd, remainingUsd: Math.max(0, Math.round((capUsd - spentUsd) * 100) / 100) };
}

/** One Boost run per recruiter at a time: two parallel runs would each read the
 *  pre-run budget and could together overshoot the cap by a whole batch. */
const activeBoosts = new Set<string>();

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
  /** The caller's monthly allowance (present when the quote knows who is asking). */
  budget?: BoostBudget;
  /** Rows the remaining allowance can still pay for (missing, clamped by budget). */
  affordable?: number;
}

export async function premiumPhoneQuote(ws: string, run: SourcingRun, actorEmail?: string): Promise<PremiumPhoneQuote> {
  return withWorkspaceCreds(ws, async () => {
    const stats = await getPremiumPhoneStats(ws);
    const own = stats.calls >= MIN_CALLS_FOR_OWN_RATE;
    const hitRate = own ? stats.hits / Math.max(1, stats.calls) : DEFAULT_HIT_RATE;
    // Two-step directory listings bill 2 requests per completed lookup; everything
    // the recruiter sees is priced per LOOKUP so the estimate matches the invoice.
    const perLookup = skipTraceUnitCost() * skipTraceCallsPerLookup();
    const billing = skipTraceBilling();
    const missing = boostableRows(run.candidates).length;
    const estFinds = Math.round(missing * hitRate);
    const billedUnits = billing === "call" ? missing : estFinds;
    const budget = await boostBudget(ws, (actorEmail || "").trim());
    // How many of the missing rows this recruiter can still afford this month.
    // Priced at the per-lookup rate even for billed-per-hit listings: conservative
    // on purpose, the fail-safe never quotes more rows than the budget covers.
    const affordable = perLookup > 0 ? Math.min(missing, Math.floor((budget.remainingUsd + 1e-9) / perLookup)) : missing;
    return {
      configured: skipTraceConfigured(),
      unitCostUsd: perLookup,
      billing,
      missing,
      estCostUsd: Math.round(billedUnits * perLookup * 100) / 100,
      estFinds,
      hitRate: Math.round(hitRate * 100) / 100,
      statsBasis: own ? stats.calls : 0,
      budget,
      affordable,
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
  /** The caller's monthly allowance AFTER this batch's spend. */
  budget: BoostBudget;
  /** True when the batch stopped (or refused to start) because the allowance is used up. */
  budgetExhausted?: boolean;
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
function budgetCapMessage(b: BoostBudget): string {
  return `your monthly Boost phones budget is used up: $${b.spentUsd.toFixed(2)} of $${b.capUsd.toFixed(2)} spent this month. The allowance resets on the 1st.`;
}

export async function runPremiumPhoneBoost(
  ws: string,
  run: SourcingRun,
  opts: { max?: number; actor?: { userId?: string; userEmail?: string } } = {},
): Promise<PremiumPhoneBatchResult> {
  return withWorkspaceCreds(ws, async () => {
    const unit = skipTraceUnitCost();
    // What one COMPLETED lookup can bill (2 requests on two-step listings): every
    // budget decision uses this so the cap can never be overshot by a second call.
    const perLookup = unit * skipTraceCallsPerLookup();

    // ---- Monthly allowance fail-safe (server-side, fail-closed) ----
    // The UI shows the budget and disables the button, but THIS is the guarantee:
    // no identity, no budget left, or a second concurrent run = no spend, whatever
    // the client sends. remainingUsd is re-read from the ledger on every batch.
    const actorEmail = (opts.actor?.userEmail || "").trim();
    const budgetBefore = await boostBudget(ws, actorEmail);
    const refuse = (why: string, exhausted: boolean): PremiumPhoneBatchResult => ({
      called: 0, found: 0, cacheHits: 0, costUsd: 0,
      remaining: boostableRows(run.candidates).length,
      stoppedEarly: why, budget: budgetBefore, budgetExhausted: exhausted,
    });
    if (!actorEmail) {
      return refuse("this spend could not be attributed to your account. Sign out, sign back in, and try again.", false);
    }
    if (budgetBefore.remainingUsd < perLookup) {
      return refuse(budgetCapMessage(budgetBefore), true);
    }
    const lockKey = `${ws}|${actorEmail.toLowerCase()}`;
    if (activeBoosts.has(lockKey)) {
      return refuse("a Boost run is already in progress on your account; let it finish first.", false);
    }
    activeBoosts.add(lockKey);
    try {
      return await runBoostBatch(ws, run, opts, unit, budgetBefore);
    } finally {
      activeBoosts.delete(lockKey);
    }
  });
}

async function runBoostBatch(
  ws: string,
  run: SourcingRun,
  opts: { max?: number; actor?: { userId?: string; userEmail?: string } },
  unit: number,
  budgetBefore: BoostBudget,
): Promise<PremiumPhoneBatchResult> {
  {
    const perLookup = unit * skipTraceCallsPerLookup();
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
        maxCost: perLookup + 0.02,
      }],
    };

    // The batch never exceeds what the remaining monthly allowance can pay for.
    const affordable = perLookup > 0 ? Math.floor((budgetBefore.remainingUsd + 1e-9) / perLookup) : 50;
    const max = Math.max(1, Math.min(opts.max ?? 20, 50, affordable));
    const targets = boostableRows(run.candidates);
    const batch = targets.slice(0, max);
    let called = 0, found = 0, cacheHits = 0, costUsd = 0;
    let consecutiveErrors = 0;
    let stoppedEarly: string | undefined;
    let budgetExhausted = false;

    for (const c of batch) {
      const personKey = c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`;
      // Free first, always: a phone bought (or found) for this person in ANY run is reused.
      const cached = await getCachedContact(ws, personKey).catch(() => null);
      if (cached?.phone) { c.phone = cached.phone; c.phoneSource = cached.phoneSource; cacheHits++; found++; continue; }

      // Hard stop at the cap: the next lookup would bill past this month's allowance.
      if (costUsd + perLookup > budgetBefore.remainingUsd + 1e-9) {
        stoppedEarly = budgetCapMessage({
          capUsd: budgetBefore.capUsd,
          spentUsd: Math.round((budgetBefore.spentUsd + costUsd) * 100) / 100,
          remainingUsd: 0,
        });
        budgetExhausted = true;
        break;
      }

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
          // Which provider actually produced it: the cheap finder or the skip-trace
          // listing. Rides to OS Text so send/response accuracy is tracked per source.
          c.phoneSource = sourceFromProviderId(report.resolved?.mobilePhone?.providerId) ?? "skiptrace";
          await putCachedContact(ws, personKey, {
            email: (c.email || "").trim() || undefined,
            phone: number,
            phoneSource: c.phoneSource,
          }).catch(() => {});
        }
      } catch {
        called++;
        consecutiveErrors++;
        if (consecutiveErrors >= 4) { stoppedEarly = "the phone listing kept erroring"; break; }
      }
    }

    costUsd = Math.round(costUsd * 10000) / 10000;
    if (called > 0 || costUsd > 0) {
      bumpStats(ws, called, found - cacheHits, costUsd);
      recordUsage({
        workspaceId: ws,
        motion: run.motion,
        category: "enrichment",
        type: "premium_phone_boost",
        source: "rapidapi_skiptrace",
        quantity: called,
        unitCostUsd: perLookup,
        costUsd,
        meta: {
          runId: run.id, runName: run.name,
          userId: opts.actor?.userId, userEmail: opts.actor?.userEmail,
          found, cacheHits,
        },
      });
    }

    const spentNow = Math.round((budgetBefore.spentUsd + costUsd) * 100) / 100;
    return {
      called, found, cacheHits, costUsd,
      remaining: boostableRows(run.candidates).length,
      stoppedEarly,
      budget: {
        capUsd: budgetBefore.capUsd,
        spentUsd: spentNow,
        remainingUsd: Math.max(0, Math.round((budgetBefore.capUsd - spentNow) * 100) / 100),
      },
      budgetExhausted: budgetExhausted || undefined,
    };
  }
}
