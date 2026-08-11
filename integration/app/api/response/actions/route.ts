/**
 * POST /api/response/actions
 * Manual inbox actions from the recruiter.
 *   { action: "classify", text }           -> test the classifier on raw text
 *   { action: "book", prospectId }         -> mark booked (booked_at + Loxo activity)
 *   { action: "suppress", prospectId }     -> add to do-not-contact across channels
 */

import { classify, markBooked, suppress } from "../../../../lib/response";
import { getInbox } from "../../../../lib/response/repository";
import { getCore } from "../../../../lib/core/repository";
import { nowIso } from "../../../../lib/core/ids";
import { requireSession, body, ok, fail } from "../../../../lib/api";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ action?: string; text?: string; prospectId?: string; responseId?: string; handled?: boolean }>(req);
  if (!b?.action) return fail("missing_action", 422);
  const ws = g.ctx.workspace.id;

  switch (b.action) {
    case "classify": {
      if (!b.text) return fail("missing_text", 422);
      return ok({ classification: await classify(b.text) });
    }
    case "book": {
      if (!b.prospectId) return fail("missing_prospectId", 422);
      await markBooked(b.prospectId);
      return ok({ ok: true });
    }
    case "suppress": {
      if (!b.prospectId) return fail("missing_prospectId", 422);
      const p = await getCore().getProspect(b.prospectId);
      await suppress(ws, [p?.email, p?.linkedinUrl, p?.phone], "manual", nowIso());
      return ok({ ok: true });
    }
    case "reply": {
      // Reply-in-place: send a plain-text reply FROM the same lume box that received it, threaded.
      if (!b.responseId || !b.text) return fail("missing_fields", 422);
      const resp = await getInbox().getById(ws, b.responseId);
      if (!resp) return fail("not_found", 404);
      const inb = resp.inbound;
      if (inb.channel !== "email" || !inb.fromHandle) return fail("not_email", 422);
      if (!inb.toMailbox) return fail("no_sending_box", 409); // older replies without a tracked box
      const { findInboxByEmail, sendViaInbox } = await import("../../../../lib/senders");
      const inbox = await findInboxByEmail(ws, inb.toMailbox);
      if (!inbox) return fail("mailbox_gone", 409);
      const subject = inb.subject ? (/^re:/i.test(inb.subject) ? inb.subject : "Re: " + inb.subject) : "Re: your note";
      const res = await sendViaInbox(inbox, { to: inb.fromHandle, subject, text: b.text, inReplyTo: inb.providerMessageId, references: inb.providerMessageId });
      if (!res.ok) return fail("send_failed", 502, { detail: res.error });
      await getInbox().setHandled(ws, b.responseId, true); // replying clears it from the worklist
      return ok({ ok: true, messageId: res.messageId });
    }
    case "handle": {
      // Checklist: clear a reply from the day's worklist (or un-clear it).
      if (!b.responseId) return fail("missing_responseId", 422);
      const done = await getInbox().setHandled(ws, b.responseId, b.handled !== false);
      return done ? ok({ ok: true }) : fail("not_found", 404);
    }
    default:
      return fail("unknown_action", 400);
  }
}
