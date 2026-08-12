/**
 * POST /api/response/actions
 * Manual inbox actions from the recruiter.
 *   { action: "classify", text }                       -> test the classifier on raw text
 *   { action: "book", prospectId }                     -> mark booked (booked_at + Loxo activity)
 *   { action: "suppress", prospectId }                 -> add to do-not-contact across channels
 *   { action: "send", responseId, channel, text }      -> reply on email / linkedin / sms
 *   { action: "reply", responseId, text }              -> legacy alias for send on email
 *   { action: "handle", responseId, handled? }         -> clear from / restore to the worklist
 *   { action: "delete", responseId }                   -> remove from the inbox for good
 */

import { classify, markBooked, suppress, isSuppressed } from "../../../../lib/response";
import { getInbox } from "../../../../lib/response/repository";
import { getCore } from "../../../../lib/core/repository";
import { nowIso, rid } from "../../../../lib/core/ids";
import { requireSession, body, ok, fail } from "../../../../lib/api";
import type { ProcessedResponse } from "../../../../lib/response/types";

type SendChannel = "email" | "linkedin" | "sms";

/** Human-readable reasons for the toasts, so the recruiter never sees a raw code. */
const SEND_ERRORS: Record<string, string> = {
  suppressed: "This person asked not to be contacted, so sending is blocked.",
  sms_disabled_for_bd: "SMS is turned off for business-development prospects.",
  no_sending_box: "The mailbox that received this reply is no longer tracked.",
  mailbox_gone: "The mailbox that received this reply is no longer connected.",
  no_prospect: "This reply is not linked to a prospect yet, so only email replies work.",
  no_handle: "No address on file for this channel.",
};

async function sendOnChannel(
  ws: string,
  resp: ProcessedResponse,
  channel: SendChannel,
  text: string,
): Promise<{ ok: true; note: string; provider?: string; toHandle?: string } | { ok: false; error: string; detail?: string }> {
  const inb = resp.inbound;
  const prospect = inb.prospectId ? await getCore().getProspect(inb.prospectId) : undefined;

  // Respect STOP / do-not-contact on every manual send, same as campaign sends.
  const target = channel === "email"
    ? (inb.channel === "email" ? inb.fromHandle : prospect?.email)
    : channel === "sms" ? (prospect?.phone || (inb.channel === "sms" ? inb.fromHandle : undefined))
    : prospect?.linkedinUrl;
  if (target && (await isSuppressed(ws, target))) return { ok: false, error: "suppressed" };

  if (channel === "email") {
    // Reply FROM the box that received the person's email, threaded onto it.
    const inbox = getInbox();
    const anchorEmail = inb.channel === "email" && inb.toMailbox ? resp
      : (await inbox.forPerson(ws, { prospectId: inb.prospectId, handles: [prospect?.email, inb.fromHandle] }))
          .filter((r) => r.inbound.channel === "email" && r.inbound.toMailbox)
          .sort((a, b) => Date.parse(b.inbound.receivedAt) - Date.parse(a.inbound.receivedAt))[0];
    if (!anchorEmail) return { ok: false, error: "no_sending_box" };
    const a = anchorEmail.inbound;
    const { findInboxByEmail, sendViaInbox } = await import("../../../../lib/senders");
    const box = await findInboxByEmail(ws, a.toMailbox!);
    if (!box) return { ok: false, error: "mailbox_gone" };
    const subject = a.subject ? (/^re:/i.test(a.subject) ? a.subject : "Re: " + a.subject) : "Re: your note";
    const res = await sendViaInbox(box, { to: a.fromHandle!, subject, text, inReplyTo: a.providerMessageId, references: a.providerMessageId });
    if (!res.ok) return { ok: false, error: "send_failed", detail: res.error };
    if (inb.prospectId) {
      // Best-effort touch log so the ATS/warehouse sees the manual reply too.
      try {
        await getCore().recordActivity({
          id: rid("act"), workspaceId: ws, prospectId: inb.prospectId,
          channel: "email", type: "email_sent",
          summary: "Reply sent as " + (box.ownerName || box.displayName || a.toMailbox) + " via " + a.toMailbox,
          at: nowIso(),
        });
      } catch { /* the send already succeeded */ }
    }
    return { ok: true, note: "Reply sent", provider: a.toMailbox, toHandle: a.fromHandle };
  }

  // LinkedIn + SMS ride the shared send layer: suppression, pacing, engine
  // capacity and the ATS touch log all apply exactly as they do to campaigns.
  if (!prospect) return { ok: false, error: "no_prospect" };
  if (channel === "linkedin" && !prospect.linkedinUrl) return { ok: false, error: "no_handle" };
  if (channel === "sms" && !prospect.phone) return { ok: false, error: "no_handle" };
  const { sendTouch } = await import("../../../../lib/channels");
  const res = await sendTouch(ws, { channel, prospect, text });
  if (!res.ok) return { ok: false, error: res.error || "send_failed" };
  return {
    ok: true,
    note: channel === "linkedin" ? "Queued on your LinkedIn account (sent with normal pacing)" : "Text sent",
    provider: res.provider,
    toHandle: channel === "linkedin" ? prospect.linkedinUrl : prospect.phone,
  };
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ action?: string; text?: string; prospectId?: string; responseId?: string; handled?: boolean; channel?: string; objective?: string; until?: string; aiDraft?: string; aiObjective?: string }>(req);
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
    case "reply":
    case "send": {
      if (!b.responseId || !b.text) return fail("missing_fields", 422);
      const channel = (b.action === "reply" ? "email" : b.channel) as SendChannel;
      if (!["email", "linkedin", "sms"].includes(channel)) return fail("unknown_channel", 422);
      const resp = await getInbox().getById(ws, b.responseId);
      if (!resp) return fail("not_found", 404);
      const sent = await sendOnChannel(ws, resp, channel, b.text);
      if (sent.ok === false) {
        return fail(sent.error, 409, { detail: SEND_ERRORS[sent.error] || sent.detail || sent.error });
      }
      await getInbox().addOutbound({
        id: rid("out"), workspaceId: ws, responseId: b.responseId,
        prospectId: resp.inbound.prospectId || null, toHandle: sent.toHandle,
        channel, text: b.text, at: nowIso(), provider: sent.provider,
        aiDraft: b.aiDraft === "verbatim" || b.aiDraft === "edited" ? b.aiDraft : "none",
        objective: typeof b.aiObjective === "string" && b.aiObjective ? b.aiObjective.slice(0, 24) : undefined,
      });
      await getInbox().setHandled(ws, b.responseId, true); // answering clears it from the worklist
      return ok({ ok: true, note: sent.note });
    }
    case "draft": {
      // AI-suggested reply for the composer. Never auto-sent; the recruiter edits it.
      if (!b.responseId) return fail("missing_responseId", 422);
      const resp = await getInbox().getById(ws, b.responseId);
      if (!resp) return fail("not_found", 404);
      const objective = (["book_call", "send_info", "nudge", "close_polite", "forwardable"].includes(String(b.objective)) ? b.objective : "send_info") as import("../../../../lib/response/draft").DraftObjective;
      const channel = (["email", "linkedin", "sms"].includes(String(b.channel)) ? b.channel : "email") as "email" | "linkedin" | "sms";
      try {
        const { draftForRow } = await import("../../../../lib/response/draft");
        // Sign as the recruiter whose mailbox the reply sends from, not whoever
        // is logged in: the admin answering Josh's thread writes as Josh.
        let signAs = g.ctx.user?.name;
        if (channel === "email") {
          try {
            const { sendAsFor } = await import("../../../../lib/response/sendAs");
            signAs = (await sendAsFor(ws, resp))?.name || signAs;
          } catch { /* session name is still a fine sign-off */ }
        }
        const text = await draftForRow(ws, resp, objective, channel, signAs);
        return ok({ text });
      } catch (e: any) {
        return fail("draft_failed", 502, { detail: "The AI drafter is unavailable right now. Write it by hand or try again." });
      }
    }
    case "referral_prospect": {
      // "Talk to Sam" is a warm lead. One click puts the referred person into the
      // pipeline, inheriting campaign + company context from the referrer.
      if (!b.responseId) return fail("missing_responseId", 422);
      const resp = await getInbox().getById(ws, b.responseId);
      if (!resp) return fail("not_found", 404);
      const raw = resp.classification.captured?.referralTo || "";
      const name = raw.replace(/^(my|our|the)\s+/i, "").replace(/^(colleague|coworker|co-worker|friend|boss|manager|partner)\s+/i, "").trim();
      if (name.length < 2) return fail("no_referral_name", 409, { detail: "No usable name was captured from the reply. Add them by hand from Candidates." });
      const referrer = resp.inbound.prospectId ? await getCore().getProspect(resp.inbound.prospectId) : undefined;
      const prospect = {
        id: rid("pro"), workspaceId: ws,
        campaignId: referrer?.campaignId || resp.inbound.campaignId || "",
        motion: referrer?.motion,
        fullName: name, firstName: name.split(/\s+/)[0],
        company: referrer?.company,
        status: "queued" as const, dripStage: null, warmth: 20,
      };
      await getCore().saveProspect(prospect as any);
      try {
        await getCore().recordActivity({
          id: rid("act"), workspaceId: ws, prospectId: prospect.id,
          channel: "system", type: "referral_captured",
          summary: "Referred by " + (referrer?.fullName || resp.inbound.fromName || "a reply") + " in the reply center",
          at: nowIso(),
        });
      } catch { /* prospect is already saved */ }
      return ok({ ok: true, name, detail: name + " added to your pipeline (referred by " + (referrer?.fullName || resp.inbound.fromName || "this reply") + ")" });
    }
    case "snooze": {
      // Hide until a moment, then resurface on top of the worklist.
      if (!b.responseId) return fail("missing_responseId", 422);
      const done = await getInbox().setSnooze(ws, b.responseId, b.until);
      return done ? ok({ ok: true }) : fail("not_found", 404);
    }
    case "handle": {
      // Checklist: clear a reply from the day's worklist (or un-clear it).
      if (!b.responseId) return fail("missing_responseId", 422);
      const done = await getInbox().setHandled(ws, b.responseId, b.handled !== false);
      return done ? ok({ ok: true }) : fail("not_found", 404);
    }
    case "delete": {
      // Remove a reply from the inbox for good (soft-delete; it never lists again).
      if (!b.responseId) return fail("missing_responseId", 422);
      const gone = await getInbox().remove(ws, b.responseId);
      return gone ? ok({ ok: true }) : fail("not_found", 404);
    }
    default:
      return fail("unknown_action", 400);
  }
}
