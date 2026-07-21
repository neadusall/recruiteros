/**
 * RecruitersOS · JD Sourcing -> OS Text KPI rollup (supply side).
 *
 * The admin "OS Text Performance" tab pairs the scraping/enriching supply
 * numbers (what JD Sourcing found and filled) with the OS Text engine's
 * send-and-response outcomes. The engine half comes from the engine's
 * /api/kpi-stats; this module rolls up the portal half from the saved
 * sourcing runs and the Boost billing ledger, windowed the same way, so the
 * two sides of the funnel read against the same period.
 */

import type { SourcingRun } from "./types";
import { listSourcingRuns } from "./store";
import { PHONE_SOURCES } from "./phoneSources";
import { ensureLedgerReady, workspaceEvents } from "../billing/ledger";
import { getPremiumPhoneStats } from "./premiumPhone";

export interface SupplyRollup {
  windowDays: number;
  /** Recruiting lists touched (created or re-enriched) inside the window. */
  lists: number;
  listsTotal: number;
  /** Candidate rows across the windowed lists. */
  candidates: number;
  withEmail: number;
  withPhone: number;
  /** Phone counts per enrichment rung across the windowed lists. */
  byPhoneSource: Record<string, number>;
  /** Quota'd discovery requests spent building the windowed lists. */
  apiUsage: { rapidapi: number; serper: number; google: number };
  /** Sums of each windowed list's LAST push report from the engine. */
  pushed: { lists: number; added: number; knownNonMobile: number; confirmedCell: number };
  /** Recruiting lists holding phones the sweeper has not sent yet. */
  pendingPush: number;
  /** Lists parked on a push error (autoflow.error set). */
  pushErrors: number;
  boost: {
    windowUsd: number;
    windowLookups: number;
    windowFound: number;
    allTime: { calls: number; hits: number; spentUsd: number };
  };
  /** Most recent enrichment/push activity stamps for freshness readouts. */
  lastListUpdateAt: string | null;
  lastPushAt: string | null;
}

const phoneCount = (run: SourcingRun): number => run.candidates.reduce((s, c) => s + (c.phone ? 1 : 0), 0);

export async function supplyRollup(workspaceId: string, days: number): Promise<SupplyRollup> {
  const cutoffMs = Date.now() - days * 24 * 3600_000;
  const runs = (await listSourcingRuns(workspaceId)).filter((r) => r.motion === "recruiting");
  const windowed = runs.filter((r) => Date.parse(r.updatedAt) >= cutoffMs);

  const byPhoneSource: Record<string, number> = {};
  for (const s of [...PHONE_SOURCES, "unknown"]) byPhoneSource[s] = 0;
  const out: SupplyRollup = {
    windowDays: days,
    lists: windowed.length,
    listsTotal: runs.length,
    candidates: 0,
    withEmail: 0,
    withPhone: 0,
    byPhoneSource,
    apiUsage: { rapidapi: 0, serper: 0, google: 0 },
    pushed: { lists: 0, added: 0, knownNonMobile: 0, confirmedCell: 0 },
    pendingPush: 0,
    pushErrors: 0,
    boost: { windowUsd: 0, windowLookups: 0, windowFound: 0, allTime: { calls: 0, hits: 0, spentUsd: 0 } },
    lastListUpdateAt: null,
    lastPushAt: null,
  };

  for (const run of windowed) {
    out.candidates += run.candidates.length;
    for (const c of run.candidates) {
      if (c.email) out.withEmail += 1;
      if (c.phone) {
        out.withPhone += 1;
        const src = c.phoneSource && byPhoneSource[c.phoneSource] !== undefined ? c.phoneSource : "unknown";
        byPhoneSource[src] += 1;
      }
    }
    out.apiUsage.rapidapi += run.apiUsage?.rapidapi ?? 0;
    out.apiUsage.serper += run.apiUsage?.serper ?? 0;
    out.apiUsage.google += run.apiUsage?.google ?? 0;
    const imp = run.autoflow?.lastImport;
    if (imp) {
      out.pushed.lists += 1;
      out.pushed.added += imp.added;
      out.pushed.knownNonMobile += imp.knownNonMobile;
      out.pushed.confirmedCell += imp.confirmedCell;
      if (!out.lastPushAt || imp.at > out.lastPushAt) out.lastPushAt = imp.at;
    }
    if (run.autoflow?.error) out.pushErrors += 1;
    if (!run.autoflow?.sentAt && phoneCount(run) > 0) out.pendingPush += 1;
    if (!out.lastListUpdateAt || run.updatedAt > out.lastListUpdateAt) out.lastListUpdateAt = run.updatedAt;
  }

  // Boost spend, windowed exactly like the rest (the ledger's fixed rolling
  // windows don't line up with the tab's period picker, so filter raw events).
  await ensureLedgerReady();
  for (const e of workspaceEvents(workspaceId, 10_000)) {
    if (e.type !== "premium_phone_boost" || Date.parse(e.at) < cutoffMs) continue;
    out.boost.windowUsd += e.costUsd;
    out.boost.windowLookups += e.quantity;
    out.boost.windowFound += Number((e.meta as Record<string, unknown> | undefined)?.found) || 0;
  }
  out.boost.windowUsd = Math.round(out.boost.windowUsd * 100) / 100;
  const allTime = await getPremiumPhoneStats(workspaceId);
  out.boost.allTime = { calls: allTime.calls, hits: allTime.hits, spentUsd: allTime.spentUsd };

  return out;
}
