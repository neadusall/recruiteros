/**
 * AI Vetting · Client working summary + intro draft API
 *   GET  /api/vetting/client?callId=      -> the call's report + chase state
 *   POST { action: "draft", callId }      -> (re)generate the working summary + intro draft
 *   POST { action: "send", callId, to }   -> email the intro to the client. HARD GATE:
 *                                            only a "ready" report (updated resume in) can send.
 *   POST { action: "mark-sent", callId, to? } -> recruiter sent it by hand; record that.
 *
 * Session-gated. Sending is ALWAYS a human action from the UI; nothing here is
 * called by any automation. The "ready" gate enforces the operating rule: no
 * client intro goes out before the candidate's updated resume is in hand.
 */

import { requireSession, ok, fail } from "../../../../lib/api";
import {
  getCall, draftClientReport, markClientReportSent, getCandidateById,
} from "../../../../lib/vetting";
import { sendWorkspaceEmail } from "../../../../lib/auth";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const callId = new URL(req.url).searchParams.get("callId") || "";
  const call = getCall(ws, callId);
  if (!call) return fail("not_found", 404);
  return ok({ report: call.clientReport ?? null, chase: call.chase ?? null });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  let body: any = {};
  try { body = await req.json(); } catch { /* fall through to validation */ }
  const action = String(body?.action || "");
  const callId = String(body?.callId || "");
  const call = getCall(ws, callId);
  if (!call) return fail("not_found", 404);

  if (action === "draft") {
    const report = await draftClientReport(call.deskId, call.id, true);
    if (!report) return fail("draft_failed", 500);
    return ok({ report });
  }

  if (action === "send") {
    const to = String(body?.to || "").trim();
    const report = call.clientReport;
    if (!report) return fail("no_report", 400);
    if (report.status === "sent") return fail("already_sent", 409);
    if (report.status !== "ready") {
      // The whole point of the gate: the updated resume unlocks the client intro.
      return fail("awaiting_resume: the candidate's updated resume has to be in before the intro goes out", 409);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail("bad_recipient", 400);
    const cand = call.candidateId ? getCandidateById(call.candidateId) : undefined;
    // The working summary rides below the intro so the client gets the full
    // picture in one email; the resume itself is forwarded by the recruiter
    // (attachments stay a human step by design).
    const bodyText =
      `${report.emailBody.trim()}\n\n` +
      `----------------------------------------\n` +
      `WORKING SUMMARY OF THE SCREEN${cand ? ` (${cand.firstName} ${cand.lastName})` : ""}\n` +
      `----------------------------------------\n\n${report.summary.trim()}`;
    try {
      await sendWorkspaceEmail(to, report.emailSubject, bodyText, ws);
    } catch (e: any) {
      return fail(`send_failed: ${e?.message || "email error"}`, 502);
    }
    markClientReportSent(ws, call.id, to);
    return ok({ report: getCall(ws, call.id)?.clientReport ?? null });
  }

  if (action === "mark-sent") {
    if (!call.clientReport) return fail("no_report", 400);
    markClientReportSent(ws, call.id, String(body?.to || "").trim() || undefined);
    return ok({ report: getCall(ws, call.id)?.clientReport ?? null });
  }

  return fail("unknown_action", 400);
}
