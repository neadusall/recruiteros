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

import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "phone-"));
delete process.env.DATABASE_URL;
process.env.TELNYX_API_KEY = "test-key-not-a-real-credential";
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

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(typeof input === "string" ? input : input?.url ?? "");
  const method = String(init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
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
const { patchInfra, getInfra, insertCall, getCallById, logCallEvent, ensurePhoneReady } =
  await import("../lib/phone/store.js");
const { handlePhoneEvent } = await import("../lib/phone/calls.js");
const { encodeClientState } = await import("../lib/providers/telnyx.js");

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

/* ---------------- 3. what the recruiter is told ---------------- */

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
