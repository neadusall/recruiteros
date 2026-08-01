/**
 * AI Vetting backend — regression suite (no network, no live keys).
 * Run: npx tsx lib/vetting/vetting.test.ts   (exits non-zero on failure)
 *
 * Locks the load-bearing, provider-shape-tolerant logic that the live phone path
 * depends on: transcript parsing (both webhook + Conversations-API shapes),
 * conversation matching, the finalize idempotency guard, phone matching, the
 * reconciler work-list, and dry-run model resolution.
 */

import { parseTranscript, parseConversationMessages, turnsFromArray, toRole } from "./transcript";
import { conversationMatches, conversationEnded } from "./reconcile";
import { finalizeVettingCall } from "./finalize";
import { resolveEngineModel, voiceIsCloned } from "./assistant";
import {
  ensureVettingReady, upsertDesk, createCall, getCall, updateCall,
  findDeskByNumber, upsertCandidate, findCandidate, listCallsNeedingScore, phoneDigits,
} from "./store";
import type { VettingDesk } from "./types";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ FAIL: ") + m); if (!c) fails++; };
const eq = (got: unknown, exp: unknown, m: string) =>
  ok(JSON.stringify(got) === JSON.stringify(exp), m + (JSON.stringify(got) === JSON.stringify(exp) ? "" : `\n      got: ${JSON.stringify(got)}\n      exp: ${JSON.stringify(exp)}`));

async function main() {
  await ensureVettingReady();
  const WS = "ws_test";

  /* ---- toRole ---- */
  eq(toRole("assistant"), "agent", "toRole: assistant -> agent");
  eq(toRole("Agent"), "agent", "toRole: Agent -> agent");
  eq(toRole("ai"), "agent", "toRole: ai -> agent");
  eq(toRole("user"), "candidate", "toRole: user -> candidate");
  eq(toRole(undefined), "candidate", "toRole: missing -> candidate");

  /* ---- turnsFromArray (tolerant of field names + nested content) ---- */
  eq(
    turnsFromArray([
      { role: "assistant", content: "Hi there" },
      { speaker: "user", text: "Hello" },
      { role: "bot", message: { text: "nested content" } },
      { role: "user", content: "" },            // empty -> dropped
      { role: "user" },                          // no text -> dropped
      { role: "user", content: ["a", { text: "b" }] }, // array parts -> joined
    ]),
    [
      { role: "agent", text: "Hi there", atSec: undefined },
      { role: "candidate", text: "Hello", atSec: undefined },
      { role: "agent", text: "nested content", atSec: undefined },
      { role: "candidate", text: "a b", atSec: undefined },
    ],
    "turnsFromArray: tolerant field/shape handling, drops empties",
  );

  /* ---- parseTranscript (webhook payload) ---- */
  eq(parseTranscript({ transcript: [{ role: "user", content: "hey" }] }).length, 1, "parseTranscript: array under transcript");
  eq(parseTranscript({ messages: [{ role: "assistant", text: "yo" }] })[0].role, "agent", "parseTranscript: array under messages");
  eq(parseTranscript({ transcription: "just a blob" }), [{ role: "candidate", text: "just a blob" }], "parseTranscript: string blob -> candidate turn");
  eq(parseTranscript({}), [], "parseTranscript: nothing -> empty");

  /* ---- parseConversationMessages (Conversations API) ---- */
  eq(parseConversationMessages({ data: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }).length, 2, "parseConversationMessages: under data");
  eq(parseConversationMessages({ messages: [{ role: "user", content: "a" }] }).length, 1, "parseConversationMessages: under messages");
  eq(parseConversationMessages([{ role: "user", content: "a" }]).length, 1, "parseConversationMessages: bare array");
  eq(parseConversationMessages({ dryRun: true }), [], "parseConversationMessages: dry-run marker -> empty");

  /* ---- conversationMatches (metadata + top-level + mismatch) ---- */
  ok(conversationMatches({ metadata: { call_control_id: "cc_1" } }, "cc_1"), "match: metadata.call_control_id");
  ok(conversationMatches({ telnyx_call_control_id: "cc_2" }, "cc_2"), "match: top-level telnyx_call_control_id");
  ok(!conversationMatches({ metadata: { call_control_id: "cc_1" } }, "cc_9"), "no match: different id");
  ok(!conversationMatches({}, "cc_1"), "no match: no id present");

  /* ---- conversationEnded (status strings + timestamps) ---- */
  ok(conversationEnded({ status: "ended" }), "ended: status ended");
  ok(conversationEnded({ state: "COMPLETED" }), "ended: state completed (case-insensitive)");
  ok(conversationEnded({ ended_at: "2026-01-01T00:00:00Z" }), "ended: ended_at timestamp");
  ok(!conversationEnded({ status: "in_progress" }), "not ended: in_progress");
  ok(!conversationEnded({}), "not ended: nothing");

  /* ---- phone matching + desk/candidate lookup ---- */
  eq(phoneDigits("+1 (310) 555-1234"), "13105551234", "phoneDigits strips to digits");
  const desk = upsertDesk(WS, { name: "Test Desk", roleTitle: "VP Sales", jobDescription: "JD", phoneNumber: "+13855550000" });
  ok(findDeskByNumber("3855550000") === desk, "findDeskByNumber: matches on last-10 without +1");
  ok(findDeskByNumber("+1-385-555-0000") === desk, "findDeskByNumber: matches formatted +1");
  ok(!findDeskByNumber("+13855559999"), "findDeskByNumber: no false match");
  const cand = upsertCandidate(WS, { deskId: desk.id, firstName: "Jane", lastName: "Doe", phone: "+13105551234", email: "j@x.com" });
  ok(findCandidate(desk.id, "3105551234") === cand, "findCandidate: caller-ID match tolerant of formatting");

  /* ---- voiceIsCloned (needs voiceId AND ElevenLabs key ref) ---- */
  const clonedDesk = { ...desk, voiceId: "el_voice_123" } as VettingDesk;
  delete process.env.TELNYX_ELEVENLABS_KEY_REF;
  ok(!voiceIsCloned(clonedDesk), "voiceIsCloned: false without integration secret");
  process.env.TELNYX_ELEVENLABS_KEY_REF = "secret_abc";
  ok(voiceIsCloned(clonedDesk), "voiceIsCloned: true with voiceId + secret");
  ok(!voiceIsCloned(desk), "voiceIsCloned: false without voiceId");
  delete process.env.TELNYX_ELEVENLABS_KEY_REF;

  /* ---- resolveEngineModel (dry-run -> configured default, never throws) ---- */
  delete process.env.RECRUITEROS_VETTING_ENGINE_MODEL;
  eq(await resolveEngineModel(), "meta-llama/Llama-3.3-70B-Instruct", "resolveEngineModel: dry-run returns configured default");
  process.env.RECRUITEROS_VETTING_ENGINE_MODEL = "custom/model-x";
  eq(await resolveEngineModel(), "custom/model-x", "resolveEngineModel: honors env override in dry-run");
  delete process.env.RECRUITEROS_VETTING_ENGINE_MODEL;

  /* ---- listCallsNeedingScore + finalize idempotency (no network path) ---- */
  const call = createCall({ workspaceId: WS, deskId: desk.id, callerPhone: "+13105551234", engineCallId: "cc_finalize" });
  ok(listCallsNeedingScore().some((c) => c.id === call.id), "listCallsNeedingScore: includes a fresh unscored call");

  // Empty transcript -> scored + needsReview, never calls the LLM.
  const r1 = await finalizeVettingCall({ call, desk, transcript: [] });
  eq(r1.scored, false, "finalize(empty): scored=false");
  eq(getCall(WS, call.id)?.status, "scored", "finalize(empty): status becomes scored");
  eq(getCall(WS, call.id)?.needsReview, true, "finalize(empty): flagged needsReview");
  ok(!listCallsNeedingScore().some((c) => c.id === call.id), "finalize(empty): call drops out of the work-list");

  // Idempotency: re-finalizing a scored call is a no-op that reports already_final.
  const r2 = await finalizeVettingCall({ call, desk, transcript: [{ role: "candidate", text: "late transcript" }] });
  eq(r2.reason, "already_final", "finalize(idempotent): second call is already_final");
  eq(getCall(WS, call.id)?.summary, "Call ended with no usable transcript.", "finalize(idempotent): scorecard untouched");

  // A failed call is also terminal for the work-list.
  const call2 = createCall({ workspaceId: WS, deskId: desk.id, callerPhone: "+1999", engineCallId: "cc_failed" });
  updateCall(call2.id, { status: "failed" });
  ok(!listCallsNeedingScore().some((c) => c.id === call2.id), "listCallsNeedingScore: excludes failed calls");

  // A call without an engine id is not reconcilable (nothing to look up).
  const call3 = createCall({ workspaceId: WS, deskId: desk.id, callerPhone: "+1888" });
  ok(!listCallsNeedingScore().some((c) => c.id === call3.id), "listCallsNeedingScore: excludes calls with no engine id");

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
