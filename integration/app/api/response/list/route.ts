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

  return ok({ items, people, rules: ROUTING_RULES, order: CLASS_ORDER });
}
