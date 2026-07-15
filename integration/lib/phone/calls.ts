/**
 * RecruitersOS · Phone · Call orchestration
 *
 * The server side of every browser call. Architecture (per current Telnyx
 * docs): plain credential connections cannot take call-control commands, so
 * every PSTN-facing leg lives on the workspace's Call Control application and
 * the browser is always a bridged SIP-credential leg.
 *
 *  OUTBOUND  dial the user's browser (SIP credential leg), and when it
 *            answers, transfer it to the destination with the line's caller
 *            ID. Recording starts when the far end answers.
 *  INBOUND   the number's call.initiated hits the app; we ring every
 *            assigned user's browser as parallel agent legs; first answer
 *            wins (inbound leg is answered + bridged, other legs canceled).
 *
 * After hangup the record flows through the async pipeline:
 *   recording -> transcribing -> analyzing -> complete   (status-driven,
 * webhook-advanced, retry-able; the UI polls the statuses, never blocks).
 */

import { telnyx } from "../providers";
import { decodeClientState } from "../providers/telnyx";
import { withWorkspaceCreds } from "../connected";
import { recordUsage } from "../billing/ledger";
import { rateCost } from "../billing/rates";
import { toE164 } from "../voice/phone";
import { nowIso } from "../core/ids";
import type { Motion } from "../core/types";
import {
  insertCall, updateCall, getCallById, findCallByControlId, findCallBySessionId,
  logCallEvent, getLine, findLineByNumber, getUserState, getPhoneSettings,
  callsInPipeline, getInfra, ensurePhoneReady,
} from "./store";
import { shouldRecord, type CallRecord, type CallTurn } from "./types";
import { sipUriFor } from "./infra";
import { matchByPhone } from "./contacts";
import { analysisForMotion } from "./analysis";

/** How long an inbound call rings the browsers before it is missed. */
const RING_SECONDS = 25;
/** Pipeline stages older than this are marked failed by the sweep. */
const PIPELINE_TIMEOUT_MIN = 20;

interface LegState {
  callId?: string;
  role?: "agent" | "pstn";
  userId?: string;
  workspaceId?: string;
}

/* ============================ outbound ============================ */

export async function startOutboundCall(opts: {
  workspaceId: string;
  motion: Motion;
  userId: string;
  userName?: string;
  to: string;
  lineId: string;
  prospectId?: string;
}): Promise<CallRecord> {
  await ensurePhoneReady();
  const to = toE164(opts.to);
  if (!to) throw Object.assign(new Error("invalid_number: dial E.164 or a 10-digit US number"), { status: 400 });

  const line = getLine(opts.workspaceId, opts.lineId);
  if (!line) throw Object.assign(new Error("line_not_found"), { status: 404 });

  const state = getUserState(opts.workspaceId, opts.userId);
  if (!state.sipUsername) {
    throw Object.assign(new Error("phone_not_ready: open the BD Phone tab first so your device registers"), { status: 409 });
  }

  const matches = await matchByPhone(opts.workspaceId, to).catch(() => []);
  const match = opts.prospectId
    ? matches.find((m) => m.prospectId === opts.prospectId) ?? matches[0]
    : matches.length === 1 ? matches[0] : undefined;

  const settings = getPhoneSettings(opts.workspaceId, opts.motion);
  const call = insertCall({
    workspaceId: opts.workspaceId,
    motion: opts.motion,
    direction: "outbound",
    status: "ringing",
    externalNumber: to,
    lineId: line.id,
    lineNumber: line.e164,
    userId: opts.userId,
    userName: opts.userName,
    prospectId: match?.prospectId,
    contactName: match?.name,
    contactTitle: match?.title,
    companyId: match?.companyId,
    companyName: match?.company,
    startedAt: nowIso(),
    recording: { enabled: shouldRecord(settings, "outbound") },
    pipeline: "idle",
    followUpIds: [],
    events: [],
  });
  logCallEvent(call, "dial", `to ${to} from ${line.e164}`);

  // Ring the user's own browser; on answer the webhook transfers it out.
  const infra = getInfra(opts.workspaceId);
  if (!infra.appId) {
    updateCall(call, { status: "failed", pipeline: "idle", hangupCause: "phone_not_provisioned" });
    throw Object.assign(new Error("phone_not_provisioned: connect Telnyx in the Numbers tab"), { status: 409 });
  }

  try {
    const leg = await withWorkspaceCreds(opts.workspaceId, () =>
      telnyx.dialLeg({
        to: sipUriFor(state.sipUsername!),
        from: line.e164,
        connectionId: infra.appId!,
        clientState: { phone: 1, callId: call.id, role: "agent", userId: opts.userId, workspaceId: opts.workspaceId },
        timeoutSecs: 20,
      }),
    );
    const ccid = leg?.data?.call_control_id;
    if (leg?.dryRun) {
      logCallEvent(call, "dry_run", "telnyx not configured");
    } else if (ccid) {
      updateCall(call, {
        agentLegs: [{ ccid: String(ccid), userId: opts.userId, status: "ringing" }],
        telnyxSessionId: leg?.data?.call_session_id ? String(leg.data.call_session_id) : undefined,
      });
    }
  } catch (e: any) {
    updateCall(call, { status: "failed", hangupCause: String(e?.message ?? e).slice(0, 200) });
    throw e;
  }
  return call;
}

/* ============================ webhook ============================ */

/** Route one Telnyx call-control event for the phone system. */
export async function handlePhoneEvent(type: string, ev: any): Promise<string> {
  await ensurePhoneReady();
  const ccid: string = ev?.call_control_id ?? "";
  const state = decodeClientState(ev?.client_state) as LegState;

  switch (type) {
    case "call.initiated": {
      // Only PSTN-inbound legs matter here: our own dialed legs also emit
      // call.initiated, but they carry our client_state.
      if (state.callId) return "own_leg";
      if (String(ev?.direction ?? "") !== "incoming") return "ignored";
      return handleInboundInitiated(ccid, ev);
    }
    case "call.answered":
      return handleAnswered(ccid, ev, state);
    case "call.bridged":
      return "bridged";
    case "call.hangup":
      return handleHangup(ccid, ev, state);
    case "call.recording.saved":
      return handleRecordingSaved(ev, state);
    case "call.recording.transcription.saved":
      return handleTranscriptionSaved(ev, state);
    case "call.recording.error":
      return handleRecordingError(ev, state);
    default:
      return "ignored";
  }
}

/* ---------------- inbound ring ---------------- */

async function handleInboundInitiated(ccid: string, ev: any): Promise<string> {
  const toNumber = String(ev?.to ?? "");
  const fromNumber = toE164(String(ev?.from ?? "")) || String(ev?.from ?? "");
  const line = findLineByNumber(toNumber);
  if (!line || !line.inboundEnabled) return "no_line";

  const settings = getPhoneSettings(line.workspaceId, line.motion);
  const matches = await matchByPhone(line.workspaceId, fromNumber).catch(() => []);
  const match = matches.length === 1 ? matches[0] : undefined;

  const call = insertCall({
    workspaceId: line.workspaceId,
    motion: line.motion,
    direction: "inbound",
    status: "ringing",
    externalNumber: fromNumber,
    lineId: line.id,
    lineNumber: line.e164,
    userId: "",
    prospectId: match?.prospectId,
    contactName: match?.name,
    contactTitle: match?.title,
    companyId: match?.companyId,
    companyName: match?.company,
    startedAt: nowIso(),
    telnyxCallControlId: ccid,
    telnyxSessionId: ev?.call_session_id ? String(ev.call_session_id) : undefined,
    telnyxLegId: ev?.call_leg_id ? String(ev.call_leg_id) : undefined,
    recording: { enabled: shouldRecord(settings, "inbound") },
    pipeline: "idle",
    followUpIds: [],
    events: [],
  });
  logCallEvent(call, "inbound", `from ${fromNumber} on ${line.e164}`);

  // Ring every assigned user's registered browser in parallel.
  const infra = getInfra(line.workspaceId);
  const legs: NonNullable<CallRecord["agentLegs"]> = [];
  await withWorkspaceCreds(line.workspaceId, async () => {
    for (const userId of line.assignedUserIds) {
      const st = getUserState(line.workspaceId, userId);
      if (!st.sipUsername) continue;
      try {
        const leg = await telnyx.dialLeg({
          to: sipUriFor(st.sipUsername),
          from: fromNumber.startsWith("+") ? fromNumber : line.e164,
          fromDisplayName: (match?.name ?? "").slice(0, 40) || undefined,
          connectionId: infra.appId!,
          clientState: { phone: 1, callId: call.id, role: "agent", userId, workspaceId: line.workspaceId },
          timeoutSecs: RING_SECONDS,
        });
        const legCcid = leg?.data?.call_control_id;
        if (legCcid) legs.push({ ccid: String(legCcid), userId, status: "ringing" });
      } catch (e: any) {
        logCallEvent(call, "ring_error", `${userId}: ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
  });

  if (!legs.length) {
    logCallEvent(call, "no_agents", "no registered browsers to ring");
    updateCall(call, { status: "missed", endedAt: nowIso() });
    return "no_agents";
  }
  updateCall(call, { agentLegs: legs });
  return `ringing_${legs.length}`;
}

/* ---------------- answer / bridge ---------------- */

async function handleAnswered(ccid: string, ev: any, state: LegState): Promise<string> {
  const call = state.callId
    ? getCallAnyWorkspace(state.callId)
    : findCallByControlId(ccid);
  if (!call) return "unknown_call";

  if (state.role === "agent") {
    const leg = call.agentLegs?.find((l) => l.ccid === ccid);
    if (leg) leg.status = "answered";

    if (call.direction === "outbound") {
      // Browser picked up its own leg: now send it to the real destination.
      logCallEvent(call, "agent_ready");
      await withWorkspaceCreds(call.workspaceId, () =>
        telnyx.transferCall(ccid, call.externalNumber, call.lineNumber, {
          clientState: { phone: 1, callId: call.id, role: "pstn", workspaceId: call.workspaceId },
          timeoutSecs: 45,
        }),
      ).catch((e: any) => {
        logCallEvent(call, "transfer_error", String(e?.message ?? e).slice(0, 160));
        updateCall(call, { status: "failed", hangupCause: "transfer_failed", endedAt: nowIso() });
      });
      return "transferring";
    }

    // Inbound: first browser to answer wins the call.
    if (call.status !== "ringing") {
      await withWorkspaceCreds(call.workspaceId, () => telnyx.hangup(ccid)).catch(() => {});
      return "late_answer";
    }
    updateCall(call, { status: "active", userId: state.userId ?? "", answeredAt: nowIso() });
    logCallEvent(call, "answered", `by ${state.userId ?? "user"}`);
    await withWorkspaceCreds(call.workspaceId, async () => {
      await telnyx.answerCall(call.telnyxCallControlId!, {
        phone: 1, callId: call.id, role: "pstn", workspaceId: call.workspaceId,
      });
      await telnyx.bridgeCalls(call.telnyxCallControlId!, ccid);
      // Cancel the other still-ringing browsers.
      for (const other of call.agentLegs ?? []) {
        if (other.ccid !== ccid && other.status === "ringing") {
          other.status = "done";
          await telnyx.hangup(other.ccid).catch(() => {});
        }
      }
      await maybeStartRecording(call);
    }).catch((e: any) => {
      logCallEvent(call, "bridge_error", String(e?.message ?? e).slice(0, 160));
    });
    return "bridged_inbound";
  }

  if (state.role === "pstn" && call.direction === "outbound") {
    // The destination answered the transferred leg.
    updateCall(call, {
      status: "active",
      answeredAt: nowIso(),
      telnyxCallControlId: ccid,
      telnyxLegId: ev?.call_leg_id ? String(ev.call_leg_id) : call.telnyxLegId,
    });
    logCallEvent(call, "connected");
    await withWorkspaceCreds(call.workspaceId, () => maybeStartRecording(call)).catch(() => {});
    return "connected";
  }

  return "ignored";
}

async function maybeStartRecording(call: CallRecord): Promise<void> {
  if (!call.recording.enabled || !call.telnyxCallControlId) return;
  const settings = getPhoneSettings(call.workspaceId, call.motion);
  try {
    await telnyx.recordStart(call.telnyxCallControlId, {
      transcription: settings.transcriptionEnabled,
    });
    logCallEvent(call, "recording_started");
  } catch (e: any) {
    logCallEvent(call, "recording_error", String(e?.message ?? e).slice(0, 160));
  }
}

/** Manual record control mid-call (settings permitting). */
export async function setRecording(call: CallRecord, on: boolean): Promise<void> {
  if (!call.telnyxCallControlId) throw Object.assign(new Error("no_active_leg"), { status: 409 });
  const settings = getPhoneSettings(call.workspaceId, call.motion);
  await withWorkspaceCreds(call.workspaceId, async () => {
    if (on) {
      await telnyx.recordStart(call.telnyxCallControlId!, { transcription: settings.transcriptionEnabled });
      updateCall(call, { recording: { ...call.recording, enabled: true } });
      logCallEvent(call, "recording_started", "manual");
    } else {
      await telnyx.recordStop(call.telnyxCallControlId!);
      logCallEvent(call, "recording_stopped", "manual");
    }
  });
}

/** Decline an inbound call from the UI: drop the caller + all ringing legs. */
export async function declineCall(call: CallRecord): Promise<void> {
  if (call.status !== "ringing") return;
  updateCall(call, { status: "declined", endedAt: nowIso() });
  logCallEvent(call, "declined");
  await withWorkspaceCreds(call.workspaceId, async () => {
    if (call.telnyxCallControlId) await telnyx.hangup(call.telnyxCallControlId).catch(() => {});
    for (const leg of call.agentLegs ?? []) {
      if (leg.status === "ringing") await telnyx.hangup(leg.ccid).catch(() => {});
      leg.status = "done";
    }
  });
}

/* ---------------- hangup ---------------- */

async function handleHangup(ccid: string, ev: any, state: LegState): Promise<string> {
  const call = state.callId
    ? getCallAnyWorkspace(state.callId)
    : findCallByControlId(ccid);
  if (!call) return "unknown_call";

  const cause = String(ev?.hangup_cause ?? "");
  const leg = call.agentLegs?.find((l) => l.ccid === ccid);
  if (leg) leg.status = "done";

  const terminal = ["completed", "missed", "declined", "canceled", "failed"];
  if (terminal.includes(call.status)) return "already_final";

  if (call.direction === "inbound") {
    const isPstnLeg = ccid === call.telnyxCallControlId;
    if (isPstnLeg) {
      if (call.status === "ringing") {
        // Caller gave up (or rang out) before anyone answered.
        finalizeCall(call, "missed", cause);
        await withWorkspaceCreds(call.workspaceId, async () => {
          for (const l of call.agentLegs ?? []) {
            if (l.status === "ringing") await telnyx.hangup(l.ccid).catch(() => {});
            l.status = "done";
          }
        });
      } else {
        finalizeCall(call, "completed", cause, ev);
      }
      return "inbound_final";
    }
    // An agent leg dropped. If every browser stopped ringing, let the caller
    // ring out to missed rather than leaving legs dangling.
    if (call.status === "ringing") {
      const stillRinging = (call.agentLegs ?? []).some((l) => l.status === "ringing");
      if (!stillRinging) {
        finalizeCall(call, "missed", "no_answer");
        await withWorkspaceCreds(call.workspaceId, () =>
          telnyx.hangup(call.telnyxCallControlId!).catch(() => {}),
        );
      }
      return "agent_leg_down";
    }
    if (call.status === "active" || call.status === "held") {
      // The rep hung up in the browser; the PSTN hangup will follow, but end
      // the record now so the UI is immediate.
      finalizeCall(call, "completed", cause, ev);
      await withWorkspaceCreds(call.workspaceId, () =>
        telnyx.hangup(call.telnyxCallControlId!).catch(() => {}),
      );
    }
    return "agent_hangup";
  }

  // Outbound.
  const isPstnLeg = ccid === call.telnyxCallControlId;
  if (call.status === "ringing") {
    // Never connected: the user abandoned, the destination rejected, or the
    // agent leg failed. timeout/rejection causes read better as "failed".
    const abandoned = state.role === "agent" && (cause === "normal_clearing" || cause === "originator_cancel");
    finalizeCall(call, abandoned ? "canceled" : "failed", cause);
    return "outbound_unanswered";
  }
  if (call.status === "active" || call.status === "held") {
    finalizeCall(call, "completed", cause, ev);
    if (!isPstnLeg && call.telnyxCallControlId) {
      await withWorkspaceCreds(call.workspaceId, () =>
        telnyx.hangup(call.telnyxCallControlId!).catch(() => {}),
      );
    }
  }
  return "outbound_final";
}

function finalizeCall(call: CallRecord, status: CallRecord["status"], cause?: string, ev?: any): void {
  const endedAt = nowIso();
  const durationSec = call.answeredAt
    ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(call.answeredAt)) / 1000))
    : 0;
  updateCall(call, {
    status,
    endedAt,
    durationSec,
    hangupCause: cause || call.hangupCause,
    // A recorded, answered call now waits for Telnyx to hand us the audio.
    pipeline: status === "completed" && call.recording.enabled ? "recording" : call.pipeline,
  });
  logCallEvent(call, "ended", `${status}${cause ? ` (${cause})` : ""}`);
  meterCall(call, ev);
}

function meterCall(call: CallRecord, ev?: any): void {
  if (!call.durationSec || call.durationSec <= 0) return;
  const minutes = Math.ceil(call.durationSec / 60);
  recordUsage({
    workspaceId: call.workspaceId,
    motion: call.motion,
    category: "messaging",
    type: "voice_minute",
    source: "telnyx",
    quantity: minutes,
    unitCostUsd: rateCost("voice_minute"),
    meta: { callId: call.id, direction: call.direction, hangupCause: ev?.hangup_cause },
  });
}

/* ---------------- recording + transcription pipeline ---------------- */

function callForRecordingEvent(ev: any, state: LegState): CallRecord | undefined {
  if (state.callId) {
    const c = getCallAnyWorkspace(state.callId);
    if (c) return c;
  }
  const ccid = ev?.call_control_id ? String(ev.call_control_id) : "";
  if (ccid) {
    const c = findCallByControlId(ccid);
    if (c) return c;
  }
  const session = ev?.call_session_id ? String(ev.call_session_id) : "";
  if (session) return findCallBySessionId(session);
  return undefined;
}

function handleRecordingSaved(ev: any, state: LegState): string {
  const call = callForRecordingEvent(ev, state);
  if (!call) return "unknown_call";
  const urls = ev?.recording_urls ?? {};
  const url = urls.mp3 || urls.wav || "";
  const settings = getPhoneSettings(call.workspaceId, call.motion);
  updateCall(call, {
    recording: {
      ...call.recording,
      enabled: true,
      recordingId: ev?.recording_id ? String(ev.recording_id) : call.recording.recordingId,
      url: url || call.recording.url,
      channels: ev?.channels ? String(ev.channels) : call.recording.channels,
      // Telnyx webhook URLs are valid ~10 minutes; refresh via the API after.
      urlExpiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    },
    pipeline: settings.transcriptionEnabled ? "transcribing" : "complete",
    pipelineAttempts: 0,
  });
  logCallEvent(call, "recording_saved");
  return "recording_saved";
}

function handleRecordingError(ev: any, state: LegState): string {
  const call = callForRecordingEvent(ev, state);
  if (!call) return "unknown_call";
  updateCall(call, { pipeline: "failed", pipelineError: `recording_error: ${str(ev?.reason) || "Telnyx reported a recording failure"}` });
  logCallEvent(call, "recording_error", str(ev?.reason));
  return "recording_error";
}

function handleTranscriptionSaved(ev: any, state: LegState): string {
  const call = callForRecordingEvent(ev, state);
  if (!call) return "unknown_call";
  const text = String(ev?.transcription_text ?? "").trim();
  const transcript = parseTranscriptText(text, call);
  updateCall(call, {
    transcript,
    pipeline: transcript.length ? "analyzing" : "complete",
    pipelineAttempts: 0,
  });
  logCallEvent(call, "transcribed", `${text.length} chars`);
  if (transcript.length) {
    // Fire the LLM pass without blocking the webhook response.
    void runAnalysis(call).catch(() => {});
  }
  return "transcribed";
}

/**
 * Telnyx post-call transcription arrives as one text blob (dual-channel keeps
 * sides on separate audio tracks, but the saved transcription is linear).
 * When the engine emits "Speaker N:" style markers we split into turns;
 * otherwise the transcript is stored as one unattributed turn, which the
 * analysis prompt handles ("SPEAKER").
 */
export function parseTranscriptText(text: string, call: CallRecord): CallTurn[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => /^speaker\s*[a-z0-9]+\s*[:\-]/i.test(l)).length;
  if (marked >= 2 && marked >= lines.length * 0.5) {
    return lines.map((l): CallTurn => {
      const m = l.match(/^speaker\s*([a-z0-9]+)\s*[:\-]\s*(.*)$/i);
      if (!m) return { role: "unknown", text: l };
      // Channel A carries the first leg: inbound = the caller (contact),
      // outbound = the browser (user). Best-effort mapping.
      const first = /^(0|a|1)$/i.test(m[1]);
      const role = call.direction === "inbound" ? (first ? "contact" : "user") : (first ? "user" : "contact");
      return { role, text: m[2] };
    }).filter((t) => t.text);
  }
  return [{ role: "unknown", text: text.slice(0, 60_000) }];
}

/** Run (or re-run) the motion's LLM analysis for a call with a transcript. */
export async function runAnalysis(call: CallRecord): Promise<void> {
  if (!call.transcript?.length) {
    updateCall(call, { pipeline: "failed", pipelineError: "no_transcript: nothing to analyze" });
    return;
  }
  updateCall(call, { pipeline: "analyzing", pipelineError: undefined });
  try {
    const engine = analysisForMotion(call.motion);
    const analysis = await engine({
      transcript: call.transcript,
      userNotes: call.userNotes,
      direction: call.direction,
      contactName: call.contactName,
      contactTitle: call.contactTitle,
      companyName: call.companyName,
      callDate: call.startedAt,
      durationSec: call.durationSec,
      previousVersion: call.analysis?.version ?? 0,
    });
    updateCall(call, { analysis, pipeline: "complete", pipelineError: undefined });
    // The two motions grade calls on different axes: bd on opportunity, recruiting on fit.
    const grade = analysis.kind === "recruiting" ? analysis.fit : analysis.opportunity;
    logCallEvent(call, "analyzed", `v${analysis.version} ${grade}`);
  } catch (e: any) {
    updateCall(call, {
      pipeline: "failed",
      pipelineError: String(e?.message ?? e).slice(0, 300),
      pipelineAttempts: (call.pipelineAttempts ?? 0) + 1,
    });
    logCallEvent(call, "analysis_error", String(e?.message ?? e).slice(0, 160));
  }
}

/** Retry a failed pipeline from whatever stage the call is stuck at. */
export async function retryPipeline(call: CallRecord): Promise<CallRecord> {
  if (call.transcript?.length) {
    await runAnalysis(call);
    return call;
  }
  if (call.recording.recordingId) {
    // Recording exists but transcription never landed. Telnyx post-call
    // transcription is requested at record time; if it was lost the honest
    // state is failed-with-reason, but refresh the audio link on the way.
    await refreshRecordingUrl(call).catch(() => {});
    updateCall(call, {
      pipeline: "failed",
      pipelineError: "transcription_unavailable: Telnyx did not return a transcript for this recording",
    });
    return call;
  }
  updateCall(call, { pipeline: "idle", pipelineError: undefined });
  return call;
}

/** Recording URLs from webhooks last minutes; refresh via the API on demand. */
export async function refreshRecordingUrl(call: CallRecord): Promise<string> {
  if (!call.recording.recordingId) return "";
  const fresh = call.recording.url && call.recording.urlExpiresAt &&
    Date.parse(call.recording.urlExpiresAt) > Date.now() + 30_000;
  if (fresh) return call.recording.url!;
  const rec = await withWorkspaceCreds(call.workspaceId, () =>
    telnyx.getRecording(call.recording.recordingId!),
  );
  const urls = rec?.data?.download_urls ?? {};
  const url = urls.mp3 || urls.wav || "";
  if (url) {
    updateCall(call, {
      recording: {
        ...call.recording,
        url,
        durationSec: rec?.data?.duration_millis
          ? Math.round(Number(rec.data.duration_millis) / 1000)
          : call.recording.durationSec,
        urlExpiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
      },
    });
  }
  return url;
}

/** Fail pipeline stages that have waited unreasonably long (webhook lost). */
export function sweepPipelines(): number {
  const stuck = callsInPipeline(["recording", "transcribing"]).filter((c) => {
    const since = Date.parse(c.updatedAt);
    return Number.isFinite(since) && Date.now() - since > PIPELINE_TIMEOUT_MIN * 60_000;
  });
  for (const call of stuck) {
    updateCall(call, {
      pipeline: "failed",
      pipelineError: `${call.pipeline}_timeout: no Telnyx callback after ${PIPELINE_TIMEOUT_MIN} minutes`,
    });
    logCallEvent(call, "pipeline_timeout", call.pipeline);
  }
  return stuck.length;
}

/* ---------------- helpers ---------------- */

/** Webhooks carry the call id in client_state; workspace comes off the call. */
function getCallAnyWorkspace(callId: string): CallRecord | undefined {
  return getCallById(callId);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
