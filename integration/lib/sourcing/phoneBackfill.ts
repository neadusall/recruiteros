/**
 * RecruitersOS · JD Sourcing · one-shot FREE phone backfill.
 *
 * Re-runs ONLY the LandlineDB rung (lib/sourcing/landlinePhones) over every saved
 * list's phone-less rows, across all workspaces. Exists because the rung fails
 * SILENTLY when the database is unreachable (2026-07-20: the app lost Postgres auth
 * to landlinedb, so weeks of runs "finished" with the free phone source finding
 * nothing) — after fixing the connection, this sweeps the damage without any
 * recruiter pressing Enrich list by list.
 *
 * Deliberately NOT gapFillContacts: that chain includes paid waterfall rungs, and
 * an admin-triggered repair must not spend workspace credits. Rows the free DB
 * can't corroborate stay blank for the (recruiter-decided) Boost phones rung.
 *
 * A list only saves (and so only bumps updatedAt) when it actually gained phones —
 * that save is what makes the autoflow top-up rule re-send it to Candidates +
 * OS Text, and untouched lists stay outside autoflow's freshness window.
 */

import { nowIso } from "../core/ids";
import { listAllSourcingRuns, saveSourcingRun } from "./store";
import { fillPhonesFromLandlineDb } from "./landlinePhones";

export interface PhoneBackfillResult {
  lists: number;          // lists that gained at least one phone
  phones: number;         // phones filled in total
  rowsMissing: number;    // phone-less rows seen across all lists
}

export async function backfillListPhones(): Promise<PhoneBackfillResult> {
  const runs = await listAllSourcingRuns();
  let lists = 0;
  let phones = 0;
  let rowsMissing = 0;
  for (const run of runs) {
    // A chain mid-flight gap-fills its own rows when it lands; don't race it.
    if (run.koldJob || run.koldDbJob || run.laxisJob) continue;
    const missing = run.candidates.filter((c) => !(c.phone || "").trim());
    if (!missing.length) continue;
    rowsMissing += missing.length;
    const filled = await fillPhonesFromLandlineDb(missing);
    if (!filled) continue;
    await saveSourcingRun(run.workspaceId, { ...run });
    lists++;
    phones += filled;
    console.log(`[phone-backfill] ${run.name}: +${filled} phones (${missing.length} were missing)`);
  }
  console.log(`[phone-backfill] done: ${phones} phones across ${lists} lists (${rowsMissing} rows were phone-less)`);
  return { lists, phones, rowsMissing };
}

/**
 * Operator repair: declare a run's enrichment chain OVER when its worker jobs are
 * dead weight (worker out of credits / job lost) and the parked refs are blocking
 * everything downstream: the chip spins "Enriching" forever, Boost phones 409s
 * (enrichment_in_flight), and autoflow keeps waiting. Clears the job refs and
 * closes the chunk ledger so the run reads finished-with-what-it-has; the normal
 * machinery (Boost, top-up re-send) takes over from there.
 */
export async function unstickSourcingRun(runId: string): Promise<{ ok: boolean; cleared: string[] }> {
  const runs = await listAllSourcingRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return { ok: false, cleared: [] };
  const cleared: string[] = [];
  if (run.koldJob) { run.koldJob = undefined; cleared.push("koldJob"); }
  if (run.koldDbJob) { run.koldDbJob = undefined; cleared.push("koldDbJob"); }
  if (run.laxisJob) { run.laxisJob = undefined; cleared.push("laxisJob"); }
  if (run.laxisProgress && run.laxisProgress.nextStart !== null) {
    run.laxisProgress = { ...run.laxisProgress, nextStart: null, updatedAt: nowIso() };
    cleared.push("laxisProgress");
  }
  if (cleared.length) await saveSourcingRun(run.workspaceId, { ...run });
  console.log(`[phone-backfill] unstick ${run.name}: cleared ${cleared.join(", ") || "nothing"}`);
  return { ok: true, cleared };
}
