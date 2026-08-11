/**
 * GET /api/response/list  -> the unified inbox (recent processed responses).
 * Also returns the routing-rules matrix so the UI can render the rules table,
 * and a per-person cross-channel touch summary (how many emails / LinkedIn
 * touches / texts, in and out) so a reply is never read in isolation.
 */

import { recentResponses, ROUTING_RULES, CLASS_ORDER, getInbox } from "../../../../lib/response";
import { getCore } from "../../../../lib/core/repository";
import { requireSession, ok } from "../../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const items = await recentResponses(ws, 100);

  // Cross-channel context per prospect: inbound counts from the inbox itself,
  // outbound from the activity log + the reply center's own sends. Best-effort:
  // a summary failure must never take down the inbox list.
  const people: Record<string, { in: Record<string, number>; out: Record<string, number>; lastInAt?: string; lastOutAt?: string; phone?: string; linkedinUrl?: string; email?: string; company?: string }> = {};
  try {
    const ids = [...new Set(items.map((i) => i.inbound.prospectId).filter(Boolean))] as string[];
    for (const pid of ids) {
      const summary = { in: {} as Record<string, number>, out: {} as Record<string, number>, lastInAt: undefined as string | undefined, lastOutAt: undefined as string | undefined, phone: undefined as string | undefined, linkedinUrl: undefined as string | undefined, email: undefined as string | undefined, company: undefined as string | undefined };
      // Direct-contact handles so the row can offer Call / LinkedIn profile in one click.
      const prospect = await getCore().getProspect(pid);
      if (prospect) {
        summary.phone = prospect.phone;
        summary.linkedinUrl = prospect.linkedinUrl;
        summary.email = prospect.email;
        summary.company = prospect.company;
      }
      const rows = await getInbox().forPerson(ws, { prospectId: pid });
      for (const r of rows) {
        summary.in[r.inbound.channel] = (summary.in[r.inbound.channel] || 0) + 1;
        if (!summary.lastInAt || r.inbound.receivedAt > summary.lastInAt) summary.lastInAt = r.inbound.receivedAt;
      }
      const acts = await getCore().listActivity(pid);
      for (const a of acts) {
        if (a.channel === "system" || !/_sent$/.test(a.type)) continue;
        summary.out[a.channel] = (summary.out[a.channel] || 0) + 1;
        if (!summary.lastOutAt || a.at > summary.lastOutAt) summary.lastOutAt = a.at;
      }
      const notes = await getInbox().outboundForPerson(ws, { prospectId: pid });
      for (const n of notes) {
        // The email reply path logs its own activity event; LinkedIn/SMS notes ride
        // sendTouch which also logs one. Count activity as the source of truth and
        // only add notes that never produced an event (none today, but stay safe).
        if (!acts.some((a) => a.channel === n.channel && Math.abs(Date.parse(a.at) - Date.parse(n.at)) < 3 * 60_000)) {
          summary.out[n.channel] = (summary.out[n.channel] || 0) + 1;
          if (!summary.lastOutAt || n.at > summary.lastOutAt) summary.lastOutAt = n.at;
        }
      }
      people[pid] = summary;
    }
  } catch { /* list still renders without summaries */ }

  // "Waiting on them": a reply you answered but that went silent resurfaces after
  // 48h (interested replies sitting 3 days convert at roughly half the rate of ones
  // nudged inside two). Computed for the newest actionable row per prospect; sending
  // a nudge updates lastOutAt and naturally restarts the clock.
  const NUDGE_MS = 48 * 3600_000;
  const NUDGE_CLASSES = new Set(["positive", "soft_yes", "timing_objection", "referral", "unclassified"]);
  const nudges: Record<string, number> = {}; // inbound id -> hours silent
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
      if (!s || !s.lastOutAt) continue;
      const answered = !s.lastInAt || s.lastOutAt > s.lastInAt; // ball is in their court
      const silentMs = Date.now() - Date.parse(s.lastOutAt);
      if (answered && silentMs > NUDGE_MS && !it.deletedAt) {
        nudges[it.inbound.id] = Math.round(silentMs / 3600_000);
      }
    }
  } catch { /* best-effort */ }

  // Timing objections become scheduled comebacks: parse "Q4" / "next quarter" /
  // "in 3 months" into a concrete resurface date for one-click snooze-until-then.
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

  // Reply-center performance: how fast and how much, so the recruiter sees the
  // needle move. First-response = outbound note minus its inbound's receivedAt.
  const stats = { sent24h: 0, cleared24h: 0, medianFirstResponseMins: -1, booked7d: 0 };
  try {
    const dayAgo = Date.now() - 24 * 3600_000;
    const weekAgo = Date.now() - 7 * 24 * 3600_000;
    const byId = new Map(items.map((i) => [i.inbound.id, i]));
    const deltas: number[] = [];
    const notes = await getInbox().outboundForPerson(ws, { responseIds: items.map((i) => i.inbound.id) });
    for (const n of notes) {
      const at = Date.parse(n.at);
      if (at >= dayAgo) stats.sent24h++;
      const anchor = byId.get(n.responseId);
      if (anchor && at >= weekAgo) {
        const d = at - Date.parse(anchor.inbound.receivedAt);
        if (d > 0 && d < 14 * 24 * 3600_000) deltas.push(d / 60_000);
      }
    }
    for (const i of items) if (i.handledAt && Date.parse(i.handledAt) >= dayAgo) stats.cleared24h++;
    // Meetings booked in the last 7 days across the people in this inbox.
    for (const pid of Object.keys(people)) {
      const acts = await getCore().listActivity(pid);
      if (acts.some((a) => /book/.test(a.type) && Date.parse(a.at) >= weekAgo)) stats.booked7d++;
    }
    if (deltas.length) {
      deltas.sort((a, b) => a - b);
      stats.medianFirstResponseMins = Math.round(deltas[Math.floor(deltas.length / 2)]);
    }
  } catch { /* best-effort */ }

  // The outcome loop: per-objective reply rates for AI-assisted sends, so the
  // drafter is judged on what actually got answered, not on how it reads.
  const draftPerf: Record<string, { sent: number; replied: number }> = {};
  try {
    const notes = await getInbox().outboundForPerson(ws, { responseIds: items.map((i) => i.inbound.id) });
    for (const n of notes) {
      if (!n.objective || n.aiDraft === "none" || !n.aiDraft) continue;
      const perf = (draftPerf[n.objective] ||= { sent: 0, replied: 0 });
      perf.sent++;
      // Did the person come back after this send? Any inbound from the same
      // person (prospect id or the original row's handle) later than the note.
      const anchor = items.find((i) => i.inbound.id === n.responseId);
      const cameBack = items.some((i) =>
        i.inbound.receivedAt > n.at &&
        ((n.prospectId && i.inbound.prospectId === n.prospectId) ||
          (anchor?.inbound.fromHandle && i.inbound.fromHandle === anchor.inbound.fromHandle)));
      if (cameBack) perf.replied++;
    }
  } catch { /* best-effort */ }

  let booking = "";
  try {
    const { bookingUrl } = await import("../../../../lib/bd/booking");
    booking = bookingUrl("consultative");
  } catch { /* composer just hides the insert button */ }

  // The worklist's per-class response windows (tighter than the routing matrix
  // for hot classes), so the UI and the watchdog agree on what "overdue" means.
  let windows: Record<string, number> = {};
  try {
    const { responseWindowHours } = await import("../../../../lib/response/watchdog");
    for (const r of ROUTING_RULES ? Object.keys(ROUTING_RULES) : []) windows[r] = responseWindowHours(r);
  } catch { windows = {}; }

  return ok({ items, people, nudges, timingUntil, stats, draftPerf, booking, windows, rules: ROUTING_RULES, order: CLASS_ORDER });
}
