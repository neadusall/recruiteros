/**
 * RecruitersOS · BD · Signal -> Nurture bridge
 *
 * The 24-month drip's superpower is being there when a prospect's world changes.
 * The signal engine (lib/signals) detects those changes; this bridge routes a
 * TRIGGERED signal to the matching ENROLLED prospect so the nurture cron fires an
 * immediate, event-anchored touch that overrides the scheduled cadence:
 *
 *   - job change / profile update -> re-acquire + re-segment + warm no-ask congrats
 *     (the single highest-value moment in the system),
 *   - company news (funding, M&A, launch, leadership change ...) -> tailored insight,
 *   - a notable post / activity spike -> a substantive comment.
 *
 * GUARDED: a signal about someone who is NOT enrolled is a no-op here (it keeps the
 * default new-prospect behavior elsewhere). Matching is best-effort by LinkedIn URL,
 * then email, then normalized full name, scoped to the workspace.
 */

import type { Signal, SignalType } from "../signals/types";
import {
  ensureNurtureReady,
  listEnrollments,
  onJobChange,
  queueTrigger,
  type NurtureEnrollment,
} from "./nurture";

const JOB_CHANGE_TYPES: SignalType[] = ["job_change", "profile_update"];
const COMPANY_NEWS_TYPES: SignalType[] = [
  "funding_round",
  "ipo_or_s1",
  "acquisition",
  "merger",
  "revenue_milestone",
  "grant_or_contract",
  "product_launch",
  "partnership",
  "market_entry",
  "office_expansion",
  "exec_hire",
  "department_head_change",
  "layoff",
  "hiring_velocity",
  "job_repost",
  "job_posting",
];
const POST_TYPES: SignalType[] = ["activity_spike"];

function norm(s?: string): string {
  return (s ?? "").trim().toLowerCase();
}

function normUrl(u?: string): string {
  return norm(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
}

/** Find the enrolled prospect a signal is about (LinkedIn URL > email > full name). */
function matchEnrollment(workspaceId: string, signal: Signal): NurtureEnrollment | undefined {
  const list = listEnrollments(workspaceId);
  const p = signal.person;
  if (!p) return undefined;
  const url = normUrl(p.linkedinUrl);
  if (url) {
    const byUrl = list.find((e) => normUrl(e.lead.linkedinUrl) === url);
    if (byUrl) return byUrl;
  }
  const email = norm(p.email);
  if (email) {
    const byEmail = list.find((e) => norm(e.lead.email) === email);
    if (byEmail) return byEmail;
  }
  const name = norm(p.fullName);
  if (name) {
    const byName = list.find((e) => norm(e.lead.fullName) === name);
    if (byName) return byName;
  }
  return undefined;
}

export interface NurtureSignalResult {
  matched: boolean;
  prospectId?: string;
  action?: "job_change" | "company_news" | "post";
}

/**
 * Route one triggered signal into the nurture drip if it concerns an enrolled
 * prospect. Safe to call for every trigger; returns `{ matched:false }` otherwise.
 */
export async function routeSignalToNurture(workspaceId: string, signal: Signal): Promise<NurtureSignalResult> {
  await ensureNurtureReady();
  const e = matchEnrollment(workspaceId, signal);
  if (!e) return { matched: false };
  const detail = signal.title || signal.detail || "";

  if (JOB_CHANGE_TYPES.includes(signal.type)) {
    // The new company/title live on the resolved person; re-segment to the new scope.
    onJobChange(e.prospectId, {
      company: signal.person?.companyName ?? signal.company?.name,
      title: signal.person?.title,
      email: signal.person?.email,
      companyDomain: signal.company?.domain,
      detail,
    });
    return { matched: true, prospectId: e.prospectId, action: "job_change" };
  }

  if (COMPANY_NEWS_TYPES.includes(signal.type)) {
    queueTrigger(e.prospectId, { kind: "company_news", detail });
    return { matched: true, prospectId: e.prospectId, action: "company_news" };
  }

  if (POST_TYPES.includes(signal.type)) {
    queueTrigger(e.prospectId, { kind: "post", detail });
    return { matched: true, prospectId: e.prospectId, action: "post" };
  }

  return { matched: false, prospectId: e.prospectId };
}
