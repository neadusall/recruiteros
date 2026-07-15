/**
 * /api/phone/calls/[id]
 *   GET  -> full call record + its follow-ups
 *   POST -> record actions: { action, ... }
 *     notes              { notes }                live/user notes (autosave)
 *     held               { held }                 UI hold state mirror
 *     decline                                     reject a ringing inbound
 *     hangup                                      server-side end fallback
 *     record             { on }                   manual record start/stop
 *     edit-analysis      { field, value }         user override of an AI field
 *     clear-override     { field }                revert to the AI value
 *     regenerate                                  re-run the LLM analysis
 *     retry                                       retry a failed pipeline
 *     toggle-action-item { actionItemId, done }
 *     associate-contact  { prospectId }
 *     create-contact     { name, company?, title? }
 *     create-followup    { title, dueDate?, actionItemId? }
 *     followup-status    { followUpId, status }
 *
 * Notes and analysis edits stay in separate layers: user overrides survive
 * regeneration, and regenerate never touches userNotes.
 */

import { requireCapability, ok, fail, body } from "../../../../../lib/api";
import {
  getCall, updateCall, logCallEvent, listFollowUps, insertFollowUp,
  patchFollowUp, ensurePhoneReady,
} from "../../../../../lib/phone/store";
import {
  declineCall, setRecording, runAnalysis, retryPipeline,
} from "../../../../../lib/phone/calls";
import { asBdAnalysis, type FieldEdit } from "../../../../../lib/phone/types";
import { getCore } from "../../../../../lib/core/repository";
import { addProspect } from "../../../../../lib/prospects";
import { telnyx } from "../../../../../lib/providers";
import { withWorkspaceCreds } from "../../../../../lib/connected";
import { nowIso } from "../../../../../lib/core/ids";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  const call = getCall(g.ctx.workspace.id, params.id);
  if (!call) return fail("not_found", 404);
  return ok({ call, followUps: listFollowUps(call.workspaceId, call.motion, { callId: call.id }) });
}

/* Fields a user may override, with the value shape each accepts. */
const STRING_FIELDS = new Set([
  "summary", "callReason", "businessNeed", "currentSituation",
  "hiringUrgency", "hiringTimeline", "followUpDate",
]);
const LIST_FIELDS = new Set(["painPoints", "vendors", "objections", "buyingSignals", "nextSteps"]);
const ENUM_FIELDS: Record<string, string[]> = {
  sentiment: ["very_positive", "positive", "neutral", "resistant", "negative"],
  opportunity: ["hot", "warm", "nurture", "cold", "disqualified"],
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  const ws = g.ctx.workspace.id;
  const call = getCall(ws, params.id);
  if (!call) return fail("not_found", 404);

  const b = await body<any>(req);
  if (!b?.action) return fail("missing_action", 400);
  const isAdmin = g.ctx.capabilities.includes("telnyx:manage");
  const isMine = call.userId === g.ctx.user.id || !call.userId;
  if (!isMine && !isAdmin && !["create-followup", "followup-status"].includes(b.action)) {
    return fail("not_your_call", 403);
  }

  switch (String(b.action)) {
    case "notes": {
      updateCall(call, {
        userNotes: String(b.notes ?? "").slice(0, 20_000),
        userNotesUpdatedAt: nowIso(),
      });
      return ok({ call });
    }

    case "held": {
      if (call.status === "active" || call.status === "held") {
        updateCall(call, { status: b.held ? "held" : "active" });
      }
      return ok({ call });
    }

    case "decline": {
      await declineCall(call);
      return ok({ call });
    }

    case "hangup": {
      // Fallback when the browser leg died: drop whatever is still up.
      await withWorkspaceCreds(ws, async () => {
        if (call.telnyxCallControlId) await telnyx.hangup(call.telnyxCallControlId).catch(() => {});
        for (const leg of call.agentLegs ?? []) {
          if (leg.status !== "done") await telnyx.hangup(leg.ccid).catch(() => {});
          leg.status = "done";
        }
      });
      if (!["completed", "missed", "declined", "canceled", "failed"].includes(call.status)) {
        updateCall(call, {
          status: call.answeredAt ? "completed" : "canceled",
          endedAt: call.endedAt ?? nowIso(),
        });
      }
      return ok({ call });
    }

    case "record": {
      try {
        await setRecording(call, Boolean(b.on));
        return ok({ call });
      } catch (e: any) {
        return fail(String(e?.message ?? "record_failed").slice(0, 200), Number(e?.status) || 502);
      }
    }

    case "edit-analysis": {
      const field = String(b.field ?? "");
      const edit: FieldEdit<any> = { value: b.value, editedBy: g.ctx.user.id, editedAt: nowIso() };
      if (STRING_FIELDS.has(field)) edit.value = String(b.value ?? "").slice(0, 2000);
      else if (LIST_FIELDS.has(field)) {
        if (!Array.isArray(b.value)) return fail("value_must_be_list", 400);
        edit.value = b.value.map((x: unknown) => String(x).slice(0, 300)).filter(Boolean).slice(0, 20);
      } else if (ENUM_FIELDS[field]) {
        if (!ENUM_FIELDS[field].includes(String(b.value))) return fail("invalid_value", 400);
        edit.value = String(b.value);
      } else return fail("unknown_field", 400);
      updateCall(call, {
        analysisOverrides: { ...(call.analysisOverrides ?? {}), [field]: edit },
      });
      logCallEvent(call, "note_edited", field);
      return ok({ call });
    }

    case "clear-override": {
      const field = String(b.field ?? "");
      const overrides = { ...(call.analysisOverrides ?? {}) } as Record<string, unknown>;
      delete overrides[field];
      updateCall(call, { analysisOverrides: overrides });
      return ok({ call });
    }

    case "regenerate": {
      if (!call.transcript?.length) return fail("no_transcript", 409);
      // Overrides + user notes are separate layers and survive by design.
      void runAnalysis(call).catch(() => {});
      return ok({ call: { ...call, pipeline: "analyzing" } });
    }

    case "retry": {
      await retryPipeline(call);
      return ok({ call });
    }

    case "toggle-action-item": {
      const bd = asBdAnalysis(call.analysis);
      const item = bd?.actionItems.find((a) => a.id === String(b.actionItemId ?? ""));
      if (!item) return fail("not_found", 404);
      item.done = Boolean(b.done);
      updateCall(call, {});
      return ok({ call });
    }

    case "associate-contact": {
      const p = await getCore().getProspect(String(b.prospectId ?? ""));
      if (!p || p.workspaceId !== ws) return fail("prospect_not_found", 404);
      updateCall(call, {
        prospectId: p.id,
        contactName: p.fullName || p.firstName,
        contactTitle: p.title,
        companyName: p.company,
      });
      logCallEvent(call, "contact_linked", p.fullName);
      return ok({ call });
    }

    case "create-contact": {
      const name = String(b.name ?? "").trim();
      if (!name) return fail("missing_name", 400);
      const p = await addProspect({
        workspaceId: ws,
        campaignId: "phone",
        fullName: name,
        phone: call.externalNumber,
        company: String(b.company ?? "").trim() || undefined,
        title: String(b.title ?? "").trim() || undefined,
        motion: call.motion,
        ownerId: g.ctx.user.id,
      });
      updateCall(call, {
        prospectId: p.id,
        contactName: p.fullName,
        contactTitle: p.title,
        companyName: p.company,
      });
      logCallEvent(call, "contact_created", p.fullName);
      return ok({ call });
    }

    case "create-followup": {
      const bd = asBdAnalysis(call.analysis);
      const fromItem = b.actionItemId
        ? bd?.actionItems.find((a) => a.id === String(b.actionItemId))
        : undefined;
      const title = String(b.title ?? fromItem?.text ?? "").trim();
      if (!title) return fail("missing_title", 400);
      const f = insertFollowUp({
        workspaceId: ws,
        motion: call.motion,
        callId: call.id,
        title: title.slice(0, 300),
        dueDate: isoDate(b.dueDate) ?? fromItem?.dueDate ?? isoDate(bd?.followUpDate),
        status: "open",
        source: fromItem ? "ai" : "manual",
        actionItemId: fromItem?.id,
        prospectId: call.prospectId,
        contactName: call.contactName,
        companyName: call.companyName,
        createdBy: g.ctx.user.id,
      });
      if (!call.followUpIds.includes(f.id)) {
        updateCall(call, { followUpIds: [...call.followUpIds, f.id] });
      }
      logCallEvent(call, "followup_created", f.title);
      return ok({ call, followUp: f });
    }

    case "followup-status": {
      const status = String(b.status ?? "");
      if (!["open", "done", "dismissed"].includes(status)) return fail("invalid_status", 400);
      const f = patchFollowUp(ws, String(b.followUpId ?? ""), { status: status as any });
      if (!f) return fail("not_found", 404);
      return ok({ followUp: f });
    }

    default:
      return fail("unknown_action", 400);
  }
}

function isoDate(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}
