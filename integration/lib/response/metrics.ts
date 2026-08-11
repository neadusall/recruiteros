/**
 * RecruitersOS · Response · metrics (the numbers the recruiter steers by)
 *
 * ONE pure module computes every tracked number the reply center shows, so the
 * math is testable in isolation and the API route stays a thin caller. Every
 * function takes plain data in and returns plain numbers out; nothing here
 * touches storage or the network.
 *
 * Definitions (each is asserted in response.test.ts):
 *   - Inbound touches NEVER count auto-replies: an out-of-office is not the
 *     person answering, must not inflate "2 in", and must not reset the
 *     quiet-thread clock (an OOO used to silently kill the nudge).
 *   - Median first response = the FIRST reply-center send per thread minus that
 *     thread's receivedAt. Later follow-ups on the same thread are follow-ups,
 *     not first responses; counting them inflated the median.
 *   - Booked = a /book/-typed activity (discovery_call_booked, Booked stamp) in
 *     the window, per prospect, among the people in this inbox.
 */

import type { ProcessedResponse, OutboundNote } from "./types";
import type { ActivityEvent } from "../core/types";

export interface PersonSummary {
  in: Record<string, number>;
  out: Record<string, number>;
  lastInAt?: string;
  lastOutAt?: string;
  phone?: string;
  linkedinUrl?: string;
  email?: string;
  company?: string;
}

const DAY_MS = 24 * 3600_000;

/** Cross-channel touch summary for one person. Auto-replies are machine mail:
 *  excluded from inbound counts and from lastInAt. */
export function personSummary(rows: ProcessedResponse[], acts: ActivityEvent[], notes: OutboundNote[]): PersonSummary {
  const s: PersonSummary = { in: {}, out: {} };
  for (const r of rows) {
    if (r.classification.class === "auto_reply") continue;
    s.in[r.inbound.channel] = (s.in[r.inbound.channel] || 0) + 1;
    if (!s.lastInAt || r.inbound.receivedAt > s.lastInAt) s.lastInAt = r.inbound.receivedAt;
  }
  for (const a of acts) {
    if (a.channel === "system" || !/_sent$/.test(a.type)) continue;
    s.out[a.channel] = (s.out[a.channel] || 0) + 1;
    if (!s.lastOutAt || a.at > s.lastOutAt) s.lastOutAt = a.at;
  }
  for (const n of notes) {
    // The send paths also log an activity event; only count a note that never
    // produced one (nothing today, but the guard keeps the count honest).
    if (!acts.some((a) => a.channel === n.channel && Math.abs(Date.parse(a.at) - Date.parse(n.at)) < 3 * 60_000)) {
      s.out[n.channel] = (s.out[n.channel] || 0) + 1;
      if (!s.lastOutAt || n.at > s.lastOutAt) s.lastOutAt = n.at;
    }
  }
  return s;
}

/** Is the ball in their court AND has it been quiet past the threshold? */
export function quietHours(summary: PersonSummary, now = Date.now()): number | null {
  if (!summary.lastOutAt) return null;
  const answered = !summary.lastInAt || summary.lastOutAt > summary.lastInAt;
  if (!answered) return null;
  return Math.round((now - Date.parse(summary.lastOutAt)) / 3600_000);
}

export interface ReplyStats {
  sent24h: number;
  cleared24h: number;
  medianFirstResponseMins: number; // -1 when no data
  booked7d: number;
}

export function computeStats(
  items: ProcessedResponse[],
  notes: OutboundNote[],
  actsByProspect: Record<string, ActivityEvent[]>,
  now = Date.now(),
): ReplyStats {
  const stats: ReplyStats = { sent24h: 0, cleared24h: 0, medianFirstResponseMins: -1, booked7d: 0 };
  const dayAgo = now - DAY_MS;
  const weekAgo = now - 7 * DAY_MS;
  const byId = new Map(items.map((i) => [i.inbound.id, i]));

  // First send per thread only: later notes on the same responseId are follow-ups.
  const firstNoteByThread = new Map<string, OutboundNote>();
  for (const n of notes) {
    if (Date.parse(n.at) >= dayAgo) stats.sent24h++;
    const cur = firstNoteByThread.get(n.responseId);
    if (!cur || n.at < cur.at) firstNoteByThread.set(n.responseId, n);
  }
  const deltas: number[] = [];
  for (const [rid, n] of firstNoteByThread) {
    const anchor = byId.get(rid);
    if (!anchor || Date.parse(n.at) < weekAgo) continue;
    const d = Date.parse(n.at) - Date.parse(anchor.inbound.receivedAt);
    if (d > 0 && d < 14 * DAY_MS) deltas.push(d / 60_000);
  }
  if (deltas.length) {
    deltas.sort((a, b) => a - b);
    stats.medianFirstResponseMins = Math.round(deltas[Math.floor(deltas.length / 2)]);
  }

  for (const i of items) if (i.handledAt && Date.parse(i.handledAt) >= dayAgo) stats.cleared24h++;
  for (const pid of Object.keys(actsByProspect)) {
    if (actsByProspect[pid].some((a) => /book/.test(a.type) && Date.parse(a.at) >= weekAgo)) stats.booked7d++;
  }
  return stats;
}

/** Per-objective outcome rates for AI-assisted sends: did they come back after it? */
export function computeDraftPerf(items: ProcessedResponse[], notes: OutboundNote[]): Record<string, { sent: number; replied: number }> {
  const perf: Record<string, { sent: number; replied: number }> = {};
  const byId = new Map(items.map((i) => [i.inbound.id, i]));
  for (const n of notes) {
    if (!n.objective || !n.aiDraft || n.aiDraft === "none") continue;
    const p = (perf[n.objective] ||= { sent: 0, replied: 0 });
    p.sent++;
    const anchor = byId.get(n.responseId);
    const cameBack = items.some((i) =>
      i.classification.class !== "auto_reply" &&
      i.inbound.receivedAt > n.at &&
      ((n.prospectId && i.inbound.prospectId === n.prospectId) ||
        (anchor?.inbound.fromHandle && i.inbound.fromHandle === anchor.inbound.fromHandle)));
    if (cameBack) p.replied++;
  }
  return perf;
}
