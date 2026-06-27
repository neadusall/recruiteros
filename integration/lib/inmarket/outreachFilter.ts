/**
 * RecruitersOS · In-Market · Already-emailed suppression for targeted searches
 *
 * When a targeted JSearch run returns companies, drop the ones we've already emailed enough times —
 * but be SMART about it: suppress only the SAME job title. If a company comes back hiring for a
 * DIFFERENT (even slightly different) role, KEEP it — that's a fresh hiring signal worth a new touch.
 *
 * "Emailed enough" = a prospect at that company has been sent >= SUPPRESS_AFTER emails (default 2),
 * counted from the ActivityEvent log (every `*_sent` event). Matching is by company DOMAIN when we
 * have it (most reliable), falling back to a normalized company name. Per-role granularity comes from
 * the prospect's `title` vs. the lead's role title(s).
 *
 * Tunable: INMARKET_SUPPRESS_AFTER_SENDS (default 2). Best-effort — if outreach history can't be
 * read, nothing is suppressed (we never hide a lead just because the history lookup failed).
 */

import { getCore } from "../core/repository";
import { companyKey, type InMarketLead } from "./index";

const SUPPRESS_AFTER = Math.max(1, Number(process.env.INMARKET_SUPPRESS_AFTER_SENDS) || 2);

/** Normalize a job title for same-role comparison. Conservative: only (near-)identical titles match,
 *  so "a little bit different" titles (e.g. "Senior Controller" vs "Controller") are KEPT, not dropped. */
function normTitle(t: string): string {
  return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function domKey(d?: string): string {
  return (d || "").trim().toLowerCase().replace(/^www\./, "");
}

export interface SuppressResult {
  leads: InMarketLead[];        // the kept leads (with already-emailed roles pruned)
  suppressedCompanies: number;  // companies dropped entirely (every role already emailed)
  suppressedRoles: number;      // individual same-title roles pruned across kept companies
  threshold: number;            // the >= N sends that counts as "emailed enough"
}

/**
 * Remove already-emailed roles/companies from a list of preview leads.
 * - Drops a ROLE when the company has a prospect with the SAME (normalized) title sent >= threshold.
 * - Drops a COMPANY only when ALL of its roles are such already-emailed titles.
 * - KEEPS a company that returns with any new/different role title (fresh signal).
 */
export async function filterAlreadyEmailed(
  workspaceId: string,
  leads: InMarketLead[],
): Promise<SuppressResult> {
  const base: SuppressResult = { leads, suppressedCompanies: 0, suppressedRoles: 0, threshold: SUPPRESS_AFTER };
  if (!leads.length) return base;

  const core = getCore();
  let prospects: Array<{ id: string; company?: string; companyDomain?: string; title?: string }> = [];
  let activity: Array<{ prospectId?: string; type?: string }> = [];
  try {
    [prospects, activity] = await Promise.all([
      core.listProspects(workspaceId) as Promise<any[]>,
      core.listAllActivity(workspaceId) as Promise<any[]>,
    ]);
  } catch {
    return base; // no readable history → suppress nothing (never hide a lead on a lookup failure)
  }

  // sends per prospect id (every "*_sent" activity event = one email/touch sent)
  const sends = new Map<string, number>();
  for (const e of activity) {
    if (e && typeof e.type === "string" && e.type.endsWith("_sent") && e.prospectId) {
      sends.set(e.prospectId, (sends.get(e.prospectId) || 0) + 1);
    }
  }

  // For companies we've emailed enough, collect the exhausted role TITLES — keyed by domain AND by
  // normalized company name, so a lead matches whichever identifier it carries.
  const exhaustedByDom = new Map<string, Set<string>>();
  const exhaustedByName = new Map<string, Set<string>>();
  for (const p of prospects) {
    if ((sends.get(p.id) || 0) < SUPPRESS_AFTER) continue;
    const title = normTitle(p.title || "");
    if (!title) continue; // no title to compare → can't be sure it's the same role, so don't suppress
    const dk = domKey(p.companyDomain);
    const nk = companyKey(p.company || "");
    if (dk) { (exhaustedByDom.get(dk) ?? exhaustedByDom.set(dk, new Set()).get(dk)!).add(title); }
    if (nk) { (exhaustedByName.get(nk) ?? exhaustedByName.set(nk, new Set()).get(nk)!).add(title); }
  }
  if (!exhaustedByDom.size && !exhaustedByName.size) return base;

  let suppressedRoles = 0, suppressedCompanies = 0;
  const out: InMarketLead[] = [];
  for (const l of leads) {
    const exhausted = new Set<string>([
      ...(exhaustedByDom.get(domKey(l.domain)) || []),
      ...(exhaustedByName.get(companyKey(l.company || "")) || []),
    ]);
    if (!exhausted.size) { out.push(l); continue; }

    // Prune the roles we've already emailed (same title); keep new/different titles.
    const hadDetails = !!(l.roleDetails && l.roleDetails.length);
    const details = hadDetails ? l.roleDetails! : (l.roles || []).map((t) => ({ title: t }));
    const kept = details.filter((r) => {
      const drop = exhausted.has(normTitle(r.title || ""));
      if (drop) suppressedRoles++;
      return !drop;
    });
    if (!kept.length) { suppressedCompanies++; continue; } // every role already emailed → drop company

    if (kept.length === details.length) { out.push(l); continue; } // nothing pruned → keep as-is
    const next: InMarketLead = { ...l, roles: kept.map((r) => r.title) };
    if (hadDetails) next.roleDetails = kept as InMarketLead["roleDetails"];
    out.push(next);
  }

  return { leads: out, suppressedCompanies, suppressedRoles, threshold: SUPPRESS_AFTER };
}
