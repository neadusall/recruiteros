/**
 * RecruitersOS · JD Sourcing · landing a LinkedIn-URL search result on a list.
 *
 * Shared by the live `salesNav` API action and by the overnight queue's crash
 * recovery of one. Both MUST land the result the same way or a recovery could
 * spawn a second list for a search the recruiter already named: same target
 * resolution (explicit pick > case-insensitive name match > new list), same
 * Combine-lists dedupe, same seen-set bookkeeping.
 */

import { nowIso } from "../core/ids";
import type { CandidateRow, SourcingRun } from "./types";
import { searchKindOf, type SalesNavRunResult } from "./salesNav";
import { listSourcingRuns, saveSourcingRun } from "./store";
import { mergeSourcingRuns } from "./mergeRuns";
import { addSeenKeys } from "./seen";

/** Same stable person key the rest of JD Sourcing uses for the seen-set. */
function candKey(c: CandidateRow): string {
  return (c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`).toLowerCase().replace(/\/+$/, "");
}

export interface SalesNavApplyOptions {
  url: string;
  /** The recruiter's typed list name. Blank derives one from the search. */
  name?: string;
  /** An explicitly picked destination list. */
  targetRunId?: string;
  createdBy?: { userId: string; name: string; email: string };
}

export interface SalesNavApplied {
  run: SourcingRun;
  mode: "merged" | "created";
  name: string;
  added: number;
  overlap: number;
  total: number;
}

/** The picked destination list no longer exists. Not an error the caller can fix
 *  by retrying, so it is a value rather than a throw. */
export interface SalesNavTargetMissing {
  missingTarget: string;
}

/**
 * Merge a finished LinkedIn-URL search into its destination list, or create that
 * list. The seen-set is updated either way, so a later Fresh-only search skips
 * everyone this one surfaced.
 */
export async function applySalesNavResult(
  workspaceId: string,
  result: SalesNavRunResult,
  opts: SalesNavApplyOptions,
): Promise<SalesNavApplied | SalesNavTargetMissing> {
  const ws = workspaceId;
  const url = opts.url;
  // Resolve the destination list: explicit pick > case-insensitive name match
  // (so re-using a name can never spawn a duplicate list) > brand-new list.
  const existing = await listSourcingRuns(ws);
  const typedName = (opts.name || "").trim();
  let target: SourcingRun | undefined;
  if (opts.targetRunId) {
    target = existing.find((r) => r.id === opts.targetRunId);
    if (!target) return { missingTarget: opts.targetRunId };
  } else if (typedName) {
    target = existing.find((r) => r.name.trim().toLowerCase() === typedName.toLowerCase());
  }

  if (target) {
    // Merge into the existing list via the same regression-tested dedupe the
    // Combine button uses: stronger row wins, blanks filled from the other
    // side, so an under-enriched older list gains contact/identity data
    // without ever gaining a duplicate person.
    const incoming: SourcingRun = {
      id: "salesnav_incoming", workspaceId: ws, name: target.name, motion: target.motion,
      jd: "", jdUrl: url, icp: result.icp, queries: result.queries,
      candidates: result.candidates, warnings: [], createdAt: nowIso(), updatedAt: nowIso(),
    };
    const before = target.candidates.length;
    const { candidates, overlap } = mergeSourcingRuns([target, incoming]);
    target.candidates = candidates;
    const added = candidates.length - before;
    // New people joined a list whose chunk ledger may already read "fully
    // enriched"; left alone, the Laxis + gap-fill rungs would skip every new
    // row forever. Re-open the chain honestly: the KoldInfo rungs only ever
    // target blank-email rows, and the Laxis serializer never re-buys a row
    // holding both an email and a phone, so re-running the chain only spends
    // on rows that genuinely still need data.
    if (added > 0) {
      delete target.laxisProgress;
      delete target.laxisSkipped;
      // Re-arm the autoflow sweeper's one-resume rule for the reopened chain.
      if (target.autoflow) delete target.autoflow.resumedAt;
    }
    // A list saved before its ICP could be built adopts the derived one, so
    // scoring/vetting on the merged list has a real profile to work from.
    if (!target.icp?.titles?.length && result.icp.titles.length) target.icp = result.icp;
    if (!target.jdUrl) target.jdUrl = url;
    target.queries = target.queries.concat(result.queries).slice(0, 200);
    const saved = await saveSourcingRun(ws, { ...target });
    await addSeenKeys(ws, result.candidates.map(candKey));
    return { run: saved, mode: "merged", name: saved.name, added, overlap, total: candidates.length };
  }

  const name = typedName || result.icp.label || `${searchKindOf(url)} search`;
  const saved = await saveSourcingRun(ws, {
    name,
    jd: `Sourced from a pasted ${searchKindOf(url)} search URL.\nURL: ${url}\n` +
      `Titles: ${result.icp.titles.join(", ") || "(from results)"}\n` +
      `Locations: ${result.icp.geos.join(", ") || "(any)"}` +
      (result.icp.mustHave.length ? `\nKeywords: ${result.icp.mustHave.join(", ")}` : ""),
    jdUrl: url,
    location: result.icp.geos[0],
    icp: result.icp, queries: result.queries, candidates: result.candidates,
    warnings: result.warnings, motion: "recruiting",
    createdBy: opts.createdBy,
    apiUsage: result.apiUsage ? {
      rapidapi: Number(result.apiUsage.rapidapi) || 0,
      serper: Number(result.apiUsage.serper) || 0,
      google: Number(result.apiUsage.google) || 0,
    } : undefined,
  });
  await addSeenKeys(ws, result.candidates.map(candKey));
  return {
    run: saved, mode: "created", name: saved.name,
    added: result.candidates.length, overlap: 0, total: result.candidates.length,
  };
}
