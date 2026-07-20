/**
 * RecruitersOS · Outbound Performance · uncontacted-candidate radar
 *
 * Answers one question per workspace: which candidates are sitting in campaigns
 * WAITING for their first outreach, and whose desk are they on? "Uncontacted"
 * means the same thing the Candidates tab's "Never contacted" bucket means:
 * still queued (no sequence started), not DNC, and the cross-channel touch
 * ledger (the data warehouse record the Loxo sync + every send path feed) has
 * no lastContactedAt for the person.
 *
 * Attribution mirrors lib/outbound/events.ts: prospect.ownerId first, else the
 * campaign's recruiterId, else the "unassigned" bucket (an admin problem, not a
 * recruiter problem). Consumed by the trigger engine (daily per-recruiter
 * alert) and anything else that wants the numbers (checklist, dashboards).
 *
 * Cost: one pass over prospects + one pass over warehouse records per call
 * (indexes built in-memory here; findRecordForPerson would be O(n²)).
 */

import { getCore } from "../core/repository";
import { listRecords } from "../data/store";
import type { Prospect } from "../core/types";

export interface UncontactedList {
  campaignId: string;
  /** Campaign name (the JD Sourcing list name for auto-sent lists). */
  name: string;
  count: number;
}

export interface UncontactedSummary {
  /** userId -> their waiting candidates, grouped by campaign/list. */
  byUser: Record<string, { total: number; lists: UncontactedList[] }>;
  /** Waiting candidates on campaigns with no recruiter assigned. */
  unassigned: { total: number; lists: UncontactedList[] };
  total: number;
}

const liKey = (v?: string) => (v || "").toLowerCase().replace(/\/+$/, "").trim();
const emKey = (v?: string) => (v || "").toLowerCase().trim();
const phKey = (v?: string) => (v || "").replace(/[^\d+]/g, "");
const nameKey = (name?: string, company?: string) =>
  `${(name || "").toLowerCase().trim()}|${(company || "").toLowerCase().trim()}`;

interface TouchInfo { touched: boolean; dnc: boolean }

/** Has this prospect been touched (or protected) per the warehouse ledger? */
function lookupTouch(
  p: Prospect,
  idx: { li: Map<string, TouchInfo>; em: Map<string, TouchInfo>; ph: Map<string, TouchInfo>; nm: Map<string, TouchInfo> },
): TouchInfo | undefined {
  const li = liKey(p.linkedinUrl);
  if (li && idx.li.has(li)) return idx.li.get(li);
  const em = emKey(p.email);
  if (em && idx.em.has(em)) return idx.em.get(em);
  const ph = phKey(p.phone);
  if (ph && idx.ph.has(ph)) return idx.ph.get(ph);
  const nm = nameKey(p.fullName, p.company);
  if (p.fullName && idx.nm.has(nm)) return idx.nm.get(nm);
  return undefined;
}

/** Compute the workspace's waiting-for-first-touch picture. */
export async function uncontactedForWorkspace(workspaceId: string): Promise<UncontactedSummary> {
  const core = getCore();
  const [campaigns, prospects, { records }] = await Promise.all([
    core.listCampaigns(workspaceId),
    core.listProspects(workspaceId),
    listRecords(workspaceId, { limit: 100_000 }),
  ]);

  // One pass over the warehouse: index every identity a record carries.
  const idx = {
    li: new Map<string, TouchInfo>(), em: new Map<string, TouchInfo>(),
    ph: new Map<string, TouchInfo>(), nm: new Map<string, TouchInfo>(),
  };
  for (const r of records) {
    const info: TouchInfo = { touched: Boolean(r.lastContactedAt), dnc: Boolean(r.doNotContact) };
    const set = (m: Map<string, TouchInfo>, k: string) => {
      if (!k) return;
      const prev = m.get(k);
      // A record proving a touch (or a DNC) always wins over a silent duplicate.
      if (!prev || info.touched || info.dnc) m.set(k, { touched: (prev?.touched || info.touched), dnc: (prev?.dnc || info.dnc) });
    };
    set(idx.li, liKey(r.linkedinUrl));
    set(idx.em, emKey(r.email));
    set(idx.ph, phKey(r.phone));
    set(idx.nm, nameKey(r.fullName, r.company));
  }

  const byCampaign = new Map(campaigns.map((c) => [c.id, c]));
  const perOwnerList = new Map<string, Map<string, number>>(); // ownerKey -> campaignId -> count
  const bump = (ownerKey: string, campaignId: string) => {
    const m = perOwnerList.get(ownerKey) ?? new Map<string, number>();
    m.set(campaignId, (m.get(campaignId) ?? 0) + 1);
    perOwnerList.set(ownerKey, m);
  };

  for (const p of prospects) {
    // Queued = no sequence started; every other status means outreach began or a
    // human made a call on this person.
    if (p.status !== "queued") continue;
    const touch = lookupTouch(p, idx);
    if (touch?.touched || touch?.dnc) continue;
    const campaign = p.campaignId ? byCampaign.get(p.campaignId) : undefined;
    const ownerKey = p.ownerId || campaign?.recruiterId || "";
    bump(ownerKey, campaign?.id ?? "");
  }

  const summary: UncontactedSummary = { byUser: {}, unassigned: { total: 0, lists: [] }, total: 0 };
  for (const [ownerKey, listCounts] of perOwnerList) {
    const lists: UncontactedList[] = [...listCounts.entries()]
      .map(([campaignId, count]) => ({
        campaignId,
        name: campaignId ? (byCampaign.get(campaignId)?.name || "campaign") : "no campaign",
        count,
      }))
      .sort((a, b) => b.count - a.count);
    const total = lists.reduce((s, l) => s + l.count, 0);
    summary.total += total;
    if (ownerKey) summary.byUser[ownerKey] = { total, lists };
    else summary.unassigned = { total, lists };
  }
  return summary;
}

/** "Wichita list (84), Lakewood list (12)" style readout, capped for a message body. */
export function listsLine(lists: UncontactedList[], max = 4): string {
  const shown = lists.slice(0, max).map((l) => `${l.name} (${l.count})`);
  const rest = lists.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}
