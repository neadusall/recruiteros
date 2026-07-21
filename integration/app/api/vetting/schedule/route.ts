/**
 * AI Vetting · Scheduled Calls API  (the native booking loop's window)
 *   GET  /api/vetting/schedule  -> every candidate in the scheduling loop:
 *                                  booked calls (with the exact time), awaiting
 *                                  replies, clarifies, and recent outcomes.
 *   POST /api/vetting/schedule  -> { action: "ask",    candidateId }  send / resend the availability ask
 *                                  { action: "cancel", candidateId }  call off a booked call
 *
 * Session-gated. This replaced the third-party booking-page sync: the resume
 * inbox opens the loop automatically, candidates answer in their own words,
 * and the voice engine calls them at the moment they asked for.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { telnyx } from "../../../../lib/providers";
import {
  listCandidates, getCandidateById, getDeskById, setCandidateScreen, addScreenStep,
  sendAvailabilityAsk, speakWhen, ensureVettingReady,
  type CandidateProfile,
} from "../../../../lib/vetting";

function row(c: CandidateProfile) {
  const desk = getDeskById(c.deskId);
  const s = c.screen!;
  return {
    candidateId: c.id,
    name: `${c.firstName} ${c.lastName}`.trim(),
    phone: c.phone,
    email: c.email,
    deskId: c.deskId,
    deskName: desk?.name || "",
    roleTitle: desk?.roleTitle || "",
    status: s.status,
    askedAt: s.askedAt,
    askChannel: s.askChannel,
    lastReply: s.lastReply || "",
    lastReplyAt: s.lastReplyAt || null,
    scheduledFor: s.scheduledFor || null,
    scheduledForLabel: s.scheduledFor && s.timezone ? speakWhen(s.scheduledFor, s.timezone) : "",
    timezone: s.timezone || "",
    tzSource: s.tzSource || "",
    note: s.note || "",
    steps: (s.steps || []).slice(-12),
  };
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensureVettingReady();

  const all = listCandidates(g.ctx.workspace.id).filter((c) => c.screen);
  const rank: Record<string, number> = { booked: 0, clarify: 1, awaiting_reply: 2, completed: 3, declined: 4, canceled: 5, expired: 6 };
  const rows = all
    .map(row)
    .sort((a, b) =>
      (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
      Date.parse(a.scheduledFor || a.askedAt) - Date.parse(b.scheduledFor || b.askedAt));

  return ok({
    rows,
    counts: {
      booked: rows.filter((r) => r.status === "booked").length,
      waiting: rows.filter((r) => r.status === "awaiting_reply" || r.status === "clarify").length,
      completed: rows.filter((r) => r.status === "completed").length,
    },
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensureVettingReady();

  const b = await body<{ action?: string; candidateId?: string }>(req);
  const cand = b?.candidateId ? getCandidateById(b.candidateId) : undefined;
  if (!cand || cand.workspaceId !== g.ctx.workspace.id) return fail("candidate_not_found", 404);
  const desk = getDeskById(cand.deskId);
  if (!desk) return fail("desk_not_found", 404);

  if (b?.action === "ask") {
    if (cand.screen && ["awaiting_reply", "clarify", "booked"].includes(cand.screen.status)) {
      return fail("already_in_flight", 409);
    }
    const sent = await sendAvailabilityAsk(desk, cand, { force: true });
    if (!sent) return fail("ask_failed", 502);
    return ok({ sent: true, row: row(getCandidateById(cand.id)!) });
  }

  if (b?.action === "cancel") {
    const s = cand.screen;
    if (!s || s.status !== "booked") return fail("nothing_booked", 409);
    if (s.eventId && !s.eventId.startsWith("dry_") && desk.assistantId) {
      try {
        await withWorkspaceCreds(desk.workspaceId, () =>
          telnyx.deleteAssistantScheduledEvent(desk.assistantId!, s.eventId!));
      } catch { /* the event may already be gone */ }
    }
    s.status = "canceled";
    s.note = "canceled by the recruiter";
    setCandidateScreen(cand.id, s);
    addScreenStep(cand.id, { at: new Date().toISOString(), kind: "canceled", ok: true, note: "by the recruiter" });
    return ok({ canceled: true, row: row(getCandidateById(cand.id)!) });
  }

  return fail("unknown_action", 422);
}
