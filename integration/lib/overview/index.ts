/**
 * RecruitersOS · Overview
 * The real-time dashboard rollup: capacity, pipeline health, and the day's
 * appointments / warm conversations / active drips. Pure read model computed
 * from the core store + accounts + inbox.
 */

import { getCore } from "../core/repository";
import { listDomains, listLinkedInAccounts } from "../accounts";
import { recentResponses } from "../response";
import { today } from "../core/ids";
import type { Prospect } from "../core/types";

export interface CapacityStat {
  label: string;
  value: number;
  status: "green" | "yellow" | "red";
}

export interface OverviewSnapshot {
  capacity: CapacityStat[];
  activeProspects: number;
  appointmentsToday: number;
  appointmentsThisWeek: number;
  warmConversationsToday: number;
  wonAccounts: number;
  recentAppointments: { name: string; channel?: string; at?: string }[];
  activeDrips: { name: string; stage: string }[];
}

function rag(value: number, yellow: number, green: number): "green" | "yellow" | "red" {
  if (value >= green) return "green";
  if (value >= yellow) return "yellow";
  return "red";
}

export interface OverviewScope {
  /** Show only this motion's pipeline (BD vs recruiting). Unset = both. */
  motion?: "bd" | "recruiting";
  /** Show only prospects owned by this recruiter (per-recruiter drill-down). */
  ownerId?: string;
}

export async function overview(workspaceId: string, scope: OverviewScope = {}): Promise<OverviewSnapshot> {
  const core = getCore();
  const all = await core.listProspects(workspaceId);
  // Motion buckets the pipeline; unset legacy records default to recruiting (the
  // app's default motion). ownerId narrows to one recruiter's book of business.
  const prospects = all.filter((p) => {
    if (scope.motion && (p.motion ?? "recruiting") !== scope.motion) return false;
    if (scope.ownerId && p.ownerId !== scope.ownerId) return false;
    return true;
  });
  const accounts = listLinkedInAccounts(workspaceId).filter((a) => a.active);
  const domains = listDomains(workspaceId).filter((d) => d.active);
  const emailCapacity = domains.reduce((s, d) => s + d.inboxes * 30, 0); // ~30/inbox/day warmed
  const liCapacity = accounts.reduce((s, a) => s + a.quotas.connects + a.quotas.dms, 0);

  const t = today();
  const booked = prospects.filter((p) => p.status === "booked");
  const appointmentsToday = booked.filter((p) => p.bookedAt === t).length;
  const responses = await recentResponses(workspaceId);

  return {
    capacity: [
      { label: "LinkedIn accounts", value: accounts.length, status: rag(accounts.length, 1, 2) },
      { label: "Sending domains", value: domains.length, status: rag(domains.length, 3, 5) },
      { label: "Email capacity/day", value: emailCapacity, status: rag(emailCapacity, 100, 300) },
      { label: "LinkedIn capacity/day", value: liCapacity, status: rag(liCapacity, 40, 80) },
    ],
    activeProspects: prospects.filter((p) => p.status === "in_sequence").length,
    appointmentsToday,
    appointmentsThisWeek: booked.length,
    warmConversationsToday: responses.filter(
      (r) => r.classification.class === "positive" || r.classification.class === "soft_yes",
    ).length,
    wonAccounts: prospects.filter((p) => p.status === "won").length,
    recentAppointments: booked.slice(0, 6).map((p) => ({ name: p.fullName, channel: p.lastChannel, at: p.bookedAt })),
    activeDrips: prospects
      .filter((p) => p.status === "in_sequence")
      .slice(0, 8)
      .map((p) => ({ name: p.fullName, stage: dripLabel(p) })),
  };
}

function dripLabel(p: Prospect): string {
  return p.dripStage ? `Touch ${p.dripStage}` : "queued";
}
