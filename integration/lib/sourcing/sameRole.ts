/**
 * RecruitersOS · JD Sourcing
 * Same-role detection: recognize saved searches that target the SAME open role so
 * they can be folded into ONE list before they fan out into duplicate Candidates
 * lists and duplicate OS Text campaigns (user mandate 2026-07-21: near-identical
 * searches like "VP of Operations - Howell, New Jersey, United States",
 * "... +50mi" and "... (combined)" must converge, never ship as three lists).
 *
 * Everything here is pure and regression-tested in
 * scripts/test-sourcing-samerole.mts.
 */

import type { SourcingRun } from "./types";

/** The run fields the key needs (kept narrow so tests can pass plain objects). */
export type RoleKeyable = Pick<SourcingRun, "name" | "motion" | "workspaceId">;

/**
 * Stable same-role key for a saved run, or null when the run has no usable name.
 *
 * Two runs share a key only when, after stripping the decorations the app itself
 * adds to names, the SAME words remain: role + place. Deliberately conservative —
 * a wrong "different" costs one extra list (the recruiter can still Combine by
 * hand), a wrong "same" would silently merge two real searches. Stripped noise:
 *   - "(combined)" / "(merged)" / "(copy)" / "(2)" style suffixes (repeatedly)
 *   - "+50mi" radius tokens anywhere (the radius is a search WIDTH, not a
 *     different role: the +50mi variant exists to top up the same pipeline)
 *   - a trailing "United States" / "USA" country qualifier
 *   - punctuation / case / whitespace differences
 * The workspace and motion ride inside the key so lists can never merge across
 * tenants or across the recruiting/BD boundary.
 */
export function sameRoleKey(run: RoleKeyable): string | null {
  let n = (run.name || "").trim();
  if (!n) return null;
  // App-added suffixes, outermost first, repeatedly: "X (combined) (2)" -> "X".
  for (let prev = ""; prev !== n; ) {
    prev = n;
    n = n.replace(/\s*\((?:combined|merged|copy|\d+)\)\s*$/i, "").trim();
  }
  // Radius tokens anywhere in the name ("+50mi", "+ 25 mi").
  n = n.replace(/\+\s*\d+\s*mi\b/gi, " ");
  // Case/punctuation-insensitive word form.
  n = n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  // Trailing country qualifier (word-form, so ", United States" and "USA" both go).
  n = n.replace(/\s(?:united states(?: of america)?|usa)$/, "").trim();
  if (!n) return null;
  return `${run.workspaceId}|${run.motion === "bd" ? "bd" : "rec"}|${n}`;
}

/**
 * Which run keeps its identity when a same-role group merges. The winner's id,
 * name, Candidates list and OS Text campaign live on (the OS Text engine keys
 * campaigns by EXACT name, so the master's name decides which campaign future
 * pushes top up). Preference order:
 *   1. a run that already reached Candidates/OS Text (its campaign exists and
 *      may hold replies — that history must keep growing, never strand);
 *   2. among sent runs, an explicit combine master (combinedFrom set: the
 *      recruiter or a prior fold already chose it as the refined set);
 *   3. more candidates (a superset run absorbs its subsets);
 *   4. the earliest send, then the oldest run (stable tie-break).
 */
export function pickSameRoleMaster(runs: SourcingRun[]): SourcingRun {
  if (!runs.length) throw new Error("pickSameRoleMaster: no runs given");
  const sentAt = (r: SourcingRun) => {
    const t = r.autoflow?.sentAt ? Date.parse(r.autoflow.sentAt) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  return [...runs].sort((a, b) =>
    Number(!(a.autoflow?.sentAt || a.promotedCampaignId)) - Number(!(b.autoflow?.sentAt || b.promotedCampaignId)) ||
    Number(!a.combinedFrom?.length) - Number(!b.combinedFrom?.length) ||
    b.candidates.length - a.candidates.length ||
    sentAt(a) - sentAt(b) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}

export interface SameRoleGroup {
  key: string;
  master: SourcingRun;
  donors: SourcingRun[];
}

/** A run the auto-combine must not touch right now: an enrichment/vet job is in
 *  flight, the overnight queue is working it, or it was updated moments ago (a
 *  live tab saves on every chain step — merging under it would strand the tab). */
export const COMBINE_SETTLE_MS = 5 * 60_000;

export function combineBusy(run: SourcingRun, now: number, queueBusyIds: ReadonlySet<string>): boolean {
  if (run.vetBatch || run.koldJob || run.koldDbJob || run.laxisJob) return true;
  if (queueBusyIds.has(run.id)) return true;
  const touched = Date.parse(run.updatedAt);
  // An unreadable timestamp counts as busy: never merge what we can't reason about.
  if (!Number.isFinite(touched)) return true;
  return now - touched < COMBINE_SETTLE_MS;
}

/**
 * Group every same-role duplicate set that is safe to fold RIGHT NOW.
 * Recruiting-motion runs only (BD lists ride the email belt and are out of the
 * auto-send lane's scope); empty runs are ignored rather than blocking a group.
 */
export function combinableGroups(
  runs: SourcingRun[], now: number, queueBusyIds: ReadonlySet<string>,
): SameRoleGroup[] {
  const byKey = new Map<string, SourcingRun[]>();
  for (const r of runs) {
    if (r.motion === "bd") continue;
    if (!r.candidates.length) continue;
    const key = sameRoleKey(r);
    if (!key) continue;
    const group = byKey.get(key);
    if (group) group.push(r); else byKey.set(key, [r]);
  }
  const out: SameRoleGroup[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    if (group.some((r) => combineBusy(r, now, queueBusyIds))) continue;
    const master = pickSameRoleMaster(group);
    out.push({ key, master, donors: group.filter((r) => r.id !== master.id) });
  }
  return out;
}
