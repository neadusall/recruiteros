/**
 * RecruitersOS · Phone Intelligence · Telnyx adapter
 *
 * The carrier seam (spec §32-34). Everything the IVR engine needs from Telnyx
 * goes through here so the orchestrator never touches the provider directly and
 * a future carrier swap is a one-file change.
 *
 * Most Call Control actions already exist on the shared `telnyx` client
 * (dialLeg, answerCall, hangup, speak, recordStart, transferCall) and are
 * re-exported. Only the two IVR-specific primitives — DTMF send and REAL-TIME
 * transcription — are added here, as direct v2 calls. Callers wrap every action
 * in withWorkspaceCreds(), which activates the workspace's TELNYX_API_KEY in
 * env, so these read the same per-tenant credential as the rest of the app.
 */

const BASE = "https://api.telnyx.com/v2";

function apiKey(): string {
  const k = process.env.TELNYX_API_KEY;
  if (!k) throw new Error("telnyx_not_configured: TELNYX_API_KEY unset in this workspace context");
  return k;
}

/** base64 JSON client_state, matching the shared client's encoding. */
export function encodeState(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

async function action(callControlId: string, verb: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/calls/${encodeURIComponent(callControlId)}/actions/${verb}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`telnyx_${verb}_${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * Send DTMF on an answered leg — the core of IVR navigation. `digits` accepts
 * 0-9, *, #, and w (0.5s) / W (1s) pauses between tones. Emits `call.dtmf.sent`.
 */
export function sendDtmf(callControlId: string, digits: string, clientState?: Record<string, unknown>) {
  return action(callControlId, "send_dtmf", {
    digits,
    ...(clientState ? { client_state: encodeState(clientState) } : {}),
  });
}

/**
 * Start real-time transcription so IVR menus/greetings arrive as
 * `call.transcription` webhooks mid-call, letting the router read a menu and
 * decide the next keypress while the call is live.
 */
export function startTranscription(
  callControlId: string,
  opts?: { engine?: string; language?: string; interim?: boolean },
) {
  return action(callControlId, "transcription_start", {
    transcription_engine: opts?.engine ?? "B",
    language: opts?.language ?? "en",
    interim_results: opts?.interim ?? false,
  });
}

export function stopTranscription(callControlId: string) {
  return action(callControlId, "transcription_stop", {});
}

// The rest of the surface (dialLeg, answerCall, hangup, speak, recordStart/Stop,
// transferCall, getRecording) is already implemented and tenant-safe on the
// shared client; re-export it so the orchestrator imports Telnyx from one place.
export { telnyx } from "../providers";
