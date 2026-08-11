/**
 * GET /api/response/list  -> the unified inbox (recent processed responses).
 * Also ships everything the reply center tracks: per-person cross-channel touch
 * summaries, quiet-thread nudges, timing comebacks, the worklist's response
 * windows, and the daily numbers. ALL math lives in lib/response/metrics.ts
 * (pure + unit-tested); this route only gathers data and calls it.
 */

import { recentResponses, ROUTING_RULES, CLASS_ORDER, getInbox } from "../../../../lib/response";
import { personSummary, quietHours, computeStats, computeDraftPerf, type PersonSummary } from "../../../../lib/response/metrics";
import { getCore } from "../../../../lib/core/repository";
import { requireSession, ok } from "../../../../lib/api";
import type { ActivityEvent } from "../../../../lib/core/types";

const NUDGE_H = 48;
const NUDGE_CLASSES = new Set(["positive", "soft_yes", "referral", "timing_objection", "unclassified"]);

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const items = await recentResponses(ws, 100);

  // Cross-channel context per prospect. Best-effort: a summary failure must
  // never take down the inbox list.
  const people: Record<string, PersonSummary> = {};
  const actsByProspect: Record<string, ActivityEvent[]> = {};
  try {
    const ids = [...new Set(items.map((i) => i.inbound.prospectId).filter(Boolean))] as string[];
    for (const pid of ids) {
      const rows = await getInbox().forPerson(ws, { prospectId: pid });
      const acts = await getCore().listActivity(pid);
      const notes = await getInbox().outboundForPerson(ws, { prospectId: pid });
      actsByProspect[pid] = acts;
      const s = personSummary(rows, acts, notes);
      const prospect = await getCore().getProspect(pid);
      if (prospect) {
        s.phone = prospect.phone;
        s.linkedinUrl = prospect.linkedinUrl;
        s.email = prospect.email;
        s.company = prospect.company;
      }
      people[pid] = s;
    }
  } catch { /* list still renders without summaries */ }

  // "Waiting on them": answered threads gone quiet resurface. Computed for the
  // newest actionable row per prospect; sending resets the clock naturally.
  const nudges: Record<string, number> = {};
  try {
    const newestPerProspect = new Map<string, (typeof items)[number]>();
    for (const it of items) {
      const pid = it.inbound.prospectId;
      if (!pid || !NUDGE_CLASSES.has(it.classification.class)) continue;
      const cur = newestPerProspect.get(pid);
      if (!cur || it.inbound.receivedAt > cur.inbound.receivedAt) newestPerProspect.set(pid, it);
    }
    for (const [pid, it] of newestPerProspect) {
      const s = people[pid];
      if (!s) continue;
      const quiet = quietHours(s);
      if (quiet !== null && quiet > NUDGE_H) nudges[it.inbound.id] = quiet;
    }
  } catch { /* best-effort */ }

  // Timing objections become scheduled comebacks.
  const timingUntil: Record<string, string> = {};
  try {
    const { timingToDate } = await import("../../../../lib/response/timing");
    for (const it of items) {
      const captured = it.classification.captured?.timing;
      if (!captured) continue;
      const d = timingToDate(captured);
      if (d && d.getTime() > Date.now()) timingUntil[it.inbound.id] = d.toISOString();
    }
  } catch { /* the chip just doesn't render */ }

  // The daily numbers + the AI-draft outcome loop, all from the tested module.
  let stats = { sent24h: 0, cleared24h: 0, medianFirstResponseMins: -1, booked7d: 0 };
  let draftPerf: Record<string, { sent: number; replied: number }> = {};
  try {
    const notes = await getInbox().outboundForPerson(ws, { responseIds: items.map((i) => i.inbound.id) });
    stats = computeStats(items, notes, actsByProspect);
    draftPerf = computeDraftPerf(items, notes);
  } catch { /* best-effort */ }

  let booking = "";
  try {
    const { bookingUrl } = await import("../../../../lib/bd/booking");
    booking = bookingUrl("consultative");
  } catch { /* composer just hides the insert button */ }

  // The worklist's per-class response windows, so the UI and the watchdog agree
  // on what "overdue" means.
  let windows: Record<string, number> = {};
  try {
    const { responseWindowHours } = await import("../../../../lib/response/watchdog");
    for (const r of Object.keys(ROUTING_RULES)) windows[r] = responseWindowHours(r);
  } catch { windows = {}; }

  return ok({ items, people, nudges, timingUntil, stats, draftPerf, booking, windows, rules: ROUTING_RULES, order: CLASS_ORDER });
}
