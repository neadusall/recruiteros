/**
 * RecruitersOS · Phone · the call path itself
 *
 *   npx tsx scripts/test-phone-callpath.mts      (from integration/)
 *
 * Pins the two things that let the browser phone fail silently from
 * 2026-07-20 to 2026-08-07:
 *
 *  1. Every browser leg is dialed to sip:<credential>@sip.telnyx.com, and
 *     Telnyx refuses those calls unless the credential connection allows SIP
 *     URI calling. It ships "disabled". Provisioning has to set it, re-prove
 *     it, and repair it if it is ever turned off again.
 *  2. When a call did fail, nothing could tell "our phone never took the leg"
 *     apart from "the candidate did not pick up" — so eighteen days of a dead
 *     phone read as unlucky dialing. The outcome now records how far the call
 *     actually got.
 *
 * Nothing network-facing runs: Telnyx is stubbed, and the stores are a temp
 * directory.
 */

import { createServer } from "http";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "phone-"));
delete process.env.DATABASE_URL;
process.env.TELNYX_API_KEY = "test-key-not-a-real-credential";
process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-credential";
delete process.env.RESEND_API_KEY; // owner alerts log instead of sending

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
}

/* ---------------- stub Telnyx ---------------- */

interface Seen { method: string; url: string; body: any }
let seen: Seen[] = [];
/** What the stubbed account currently reports for the connection. */
let livePreference = "disabled";

/* The Anthropic SDK does its own HTTP, so it is pointed at a local server
   rather than a patched global fetch: this exercises the real client. */
const modelCalls: string[] = [];
const modelServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    modelCalls.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "stub",
      content: [{ type: "text", text: MODEL_REPLY }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
  });
});
await new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(modelServer.address() as any).port}`;

/** What the stubbed model returns for a finished screening call. */
const MODEL_REPLY = JSON.stringify({
  headline: "Dana Whitfield, open to a VP Operations move",
  summary: "Warm first call. Open to hearing about the role and willing to talk again this week.",
  fit: "possible",
  sentiment: "positive",
  currentRole: "Director of Operations",
  availability: "Two weeks' notice",
  location: "Chicago, IL",
  motivations: ["Wants a bigger operations remit"],
  strengths: ["Ran a 40-person operations org"],
  concerns: ["Has not managed a P&L"],
  compensation: [{ kind: "base", amount: "$185,000" }],
  submittal: "Dana Whitfield is a Director of Operations in Chicago who is open to a VP-level move. She has run a 40-person operations organization and is looking for a bigger remit. Comp expectation is around $185,000 base, available on two weeks' notice.",
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(typeof input === "string" ? input : input?.url ?? "");
  const method = String(init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url.startsWith("https://api.anthropic.com")) {
    seen.push({ method, url, body });
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: MODEL_REPLY }], usage: { input_tokens: 10, output_tokens: 10 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (!url.startsWith("https://api.telnyx.com")) return realFetch(input, init);
  seen.push({ method, url, body });

  if (url.includes("/credential_connections/")) {
    if (method === "PATCH" && body?.sip_uri_calling_preference) {
      livePreference = String(body.sip_uri_calling_preference);
    }
    return new Response(
      JSON.stringify({ data: { id: "conn_1", sip_uri_calling_preference: livePreference } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { ensureInfra } = await import("../lib/phone/infra.js");
const {
  patchInfra, getInfra, insertCall, getCallById, logCallEvent, ensurePhoneReady,
  savePhoneSettings, getPhoneSettings,
} = await import("../lib/phone/store.js");
const { handlePhoneEvent, runAnalysis } = await import("../lib/phone/calls.js");
const { encodeClientState } = await import("../lib/providers/telnyx.js");
const { shouldRecord } = await import("../lib/phone/types.js");

await ensurePhoneReady();

/* ---------------- 1. the setting the whole phone hangs on ---------------- */

const WS = "ws_test";
patchInfra(WS, { appId: "app_1", credentialConnectionId: "conn_1" });

await ensureInfra(WS);
const patched = seen.find((s) => s.method === "PATCH" && s.url.includes("/credential_connections/conn_1"));
check("an already-provisioned workspace still gets SIP URI calling turned on",
  Boolean(patched), "no PATCH was sent");
check("it is enabled for this account's own connections, not the whole internet",
  patched?.body?.sip_uri_calling_preference === "internal", String(patched?.body?.sip_uri_calling_preference));
check("the proven value is recorded so it is not re-patched on every connect",
  getInfra(WS).sipUriCalling === "internal", getInfra(WS).sipUriCalling);
check("and it is stamped, so it can be re-proven later",
  Boolean(getInfra(WS).sipUriCallingAt));

seen = [];
await ensureInfra(WS);
check("a freshly proven setting is not written again",
  !seen.some((s) => s.method === "PATCH"), `${seen.length} calls`);

/* Someone turns it off in the Telnyx portal, and the trust window lapses. */
livePreference = "disabled";
patchInfra(WS, { sipUriCallingAt: new Date(Date.now() - 12 * 3600_000).toISOString() });
seen = [];
await ensureInfra(WS);
check("a setting turned off elsewhere is caught on the next re-check and repaired",
  livePreference === "internal" && seen.some((s) => s.method === "PATCH"), livePreference);

/* Telnyx refusing the write must not take the token path down with it. */
livePreference = "disabled";
patchInfra(WS, { sipUriCallingAt: new Date(Date.now() - 12 * 3600_000).toISOString() });
const brokenFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("telnyx unreachable"); }) as typeof fetch;
let threw = false;
try { await ensureInfra(WS); } catch { threw = true; }
globalThis.fetch = brokenFetch;
check("a Telnyx outage during the check does not break issuing a token", !threw);

/* ---------------- 2. an unsuccessful call says how far it got ---------------- */

function outboundCall() {
  return insertCall({
    workspaceId: WS, motion: "bd", direction: "outbound", status: "ringing",
    externalNumber: "+14155550123", lineId: "line_1", lineNumber: "+19295430608",
    userId: "usr_1", userName: "Ryan", startedAt: new Date().toISOString(),
    recording: { enabled: false }, pipeline: "idle", followUpIds: [], events: [],
  });
}
function hangup(callId: string, role: "agent" | "pstn", cause: string) {
  return handlePhoneEvent("call.hangup", {
    call_control_id: "ccid_x",
    hangup_cause: cause,
    client_state: encodeClientState({ phone: 1, callId, role, workspaceId: WS }),
  });
}

const dead = outboundCall();
dead.agentLegs = [{ ccid: "ccid_x", userId: "usr_1", status: "ringing" }];
await hangup(dead.id, "agent", "user_busy");
const deadAfter = getCallById(dead.id);
check("a call whose browser leg never answered is a failure of the phone",
  deadAfter?.status === "failed" && deadAfter?.failureStage === "browser",
  `${deadAfter?.status}/${deadAfter?.failureStage}`);

const rangOut = outboundCall();
rangOut.agentLegs = [{ ccid: "ccid_x", userId: "usr_1", status: "ringing" }];
logCallEvent(rangOut, "agent_ready");
await hangup(rangOut.id, "pstn", "no_answer");
const rangAfter = getCallById(rangOut.id);
check("a candidate who did not pick up is a no answer, not a broken phone",
  rangAfter?.status === "missed" && rangAfter?.failureStage === "candidate",
  `${rangAfter?.status}/${rangAfter?.failureStage}`);

const bailed = outboundCall();
bailed.agentLegs = [{ ccid: "ccid_x", userId: "usr_1", status: "ringing" }];
logCallEvent(bailed, "agent_ready");
await hangup(bailed.id, "agent", "normal_clearing");
const bailedAfter = getCallById(bailed.id);
check("hanging up while it rings is canceled, and nobody is blamed",
  bailedAfter?.status === "canceled", bailedAfter?.status);

/* The classification must survive the leg bookkeeping: handleHangup marks the
   leg "done" before deciding, which is why it reads the event log. */
check("the decision does not depend on a leg status that is already overwritten",
  (rangAfter?.agentLegs ?? []).every((l) => l.status !== "answered"));

/* ---------------- 3. an answered call comes back as notes ----------------
   Everything after the candidate picks up, webhook by webhook, because that
   half of the product has never been observed working end to end on this box:
   answer -> record -> transcript -> hiring-manager submittal. */

savePhoneSettings(WS, "recruiting", {
  recordingMode: "all",
  transcriptionEnabled: true,
  recordingConsentAttested: true,
  manualRecordingToggle: true,
});
check("recording stays blocked until the workspace attests consent",
  shouldRecord(getPhoneSettings(WS, "bd"), "outbound") === false
  && shouldRecord(getPhoneSettings(WS, "recruiting"), "outbound") === true);

const live = insertCall({
  workspaceId: WS, motion: "recruiting", direction: "outbound", status: "ringing",
  externalNumber: "+14155550123", lineId: "line_1", lineNumber: "+19295430608",
  userId: "usr_1", userName: "Ryan", contactName: "Dana Whitfield",
  startedAt: new Date().toISOString(),
  recording: { enabled: shouldRecord(getPhoneSettings(WS, "recruiting"), "outbound") },
  pipeline: "idle", followUpIds: [], events: [],
});
live.agentLegs = [{ ccid: "ccid_agent", userId: "usr_1", status: "ringing" }];
logCallEvent(live, "agent_ready");

const cs = (role: "agent" | "pstn") =>
  encodeClientState({ phone: 1, callId: live.id, role, workspaceId: WS });

await handlePhoneEvent("call.answered", {
  call_control_id: "ccid_pstn", call_leg_id: "leg_1", client_state: cs("pstn"),
});
let now = getCallById(live.id);
check("the candidate answering puts the call on the air",
  now?.status === "active" && Boolean(now?.answeredAt) && now?.telnyxCallControlId === "ccid_pstn",
  `${now?.status}`);
check("and recording starts on the leg that carries the audio",
  seen.some((s) => s.url.includes("/calls/ccid_pstn/actions/record_start")),
  seen.map((s) => s.url).join(" "));

await handlePhoneEvent("call.hangup", {
  call_control_id: "ccid_pstn", hangup_cause: "normal_clearing", client_state: cs("pstn"),
});
now = getCallById(live.id);
check("hanging up completes the call and hands it to the pipeline",
  now?.status === "completed" && now?.pipeline === "recording", `${now?.status}/${now?.pipeline}`);

await handlePhoneEvent("call.recording.saved", {
  call_control_id: "ccid_pstn", client_state: cs("pstn"),
  recording_id: "rec_1", channels: "dual",
  recording_urls: { mp3: "https://example.invalid/rec_1.mp3" },
});
now = getCallById(live.id);
check("the saved recording is attached and waits on the transcript",
  now?.pipeline === "transcribing" && now?.recording.url === "https://example.invalid/rec_1.mp3",
  `${now?.pipeline}`);

await handlePhoneEvent("call.recording.transcription.saved", {
  call_control_id: "ccid_pstn", client_state: cs("pstn"),
  transcription_text: "Speaker 0: Hi Dana, this is Ryan calling about the VP Operations role.\nSpeaker 1: Great timing, I am open to hearing about it.",
});
now = getCallById(live.id);
check("the transcript keeps the two sides apart",
  now?.transcript?.length === 2 && now?.transcript?.[0].role === "user" && now?.transcript?.[1].role === "contact",
  JSON.stringify(now?.transcript));

await runAnalysis(getCallById(live.id)!);
now = getCallById(live.id);
const notes: any = now?.analysis;
check("the finished call comes back as a recruiting screen, not a BD one",
  now?.pipeline === "complete" && notes?.kind === "recruiting", `${now?.pipeline}/${notes?.kind}`);
check("with the hiring-manager submittal filled in",
  typeof notes?.submittal === "string" && notes.submittal.length > 20, String(notes?.submittal).slice(0, 40));
check("and the call reads as connected in the day's numbers",
  Boolean(now?.answeredAt) && (now?.durationSec ?? 0) >= 0 && now?.status === "completed");

/* A key that is missing must fail loudly on the record, not vanish. */
const keyWas = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
await runAnalysis(getCallById(live.id)!);
now = getCallById(live.id);
check("a missing AI key leaves a stated pipeline error, not a silent blank",
  now?.pipeline === "failed" && /anthropic/i.test(now?.pipelineError ?? ""), now?.pipelineError);
process.env.ANTHROPIC_API_KEY = keyWas;

/* ---------------- 4. what the recruiter is told ---------------- */

const here = dirname(fileURLToPath(import.meta.url));
const command = readFileSync(join(here, "..", "..", "assets", "js", "command.js"), "utf8");
const engine = readFileSync(join(here, "..", "..", "assets", "js", "bd-phone.js"), "utf8");

check("the console reads the same signal the server records",
  command.includes("failureStage") && command.includes('e.type === "agent_ready"'));
check("a phone that is merely still connecting does not claim a call is in progress",
  /still connecting/.test(engine) && /function blockReason/.test(engine));
check("only a real live call reports one",
  /case "dialing":[\s\S]{0,120}A call is already in progress/.test(engine));
check("a dial that never rings cannot wedge the phone forever",
  /armDialGuard/.test(engine) && /S\.phase !== "dialing" \|\| S\.sdkCall/.test(engine));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
