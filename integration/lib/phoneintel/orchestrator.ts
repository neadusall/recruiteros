/**
 * RecruitersOS · Phone Intelligence · Call orchestrator
 *
 * The state machine (spec §5) and the live decision loop. On each real-time
 * transcription segment we classify, then act by the decision philosophy
 * (spec §70): known route → deterministic step; else rule-based discovery by
 * routing priority (spec §8). Guardrails (spec §40-43) cap steps, detect loops,
 * and pause automation the moment a human speaks.
 *
 * Phase 1 is verification-only (spec §53-54): on reaching the target's voicemail
 * or a live human, we identify honestly and exit — never a sales pitch, never a
 * deceptive "wrong number." Reaching + verifying is the deliverable.
 */

import { withWorkspaceCreds } from "../connected";
import { telnyx, sendDtmf, startTranscription } from "./telnyxAdapter";
import { ensureIntelInfra } from "./infra";
import {
  classifyAnswer, extractMenuOptions, parseDirectoryInstruction, matchName,
  promptFingerprint,
} from "./classify";
import { directoryInput } from "./keypad";
import {
  ensureIntelReady, companyKeyOf, upsertProfile, getProfile, patchProfile,
  activeRoute, saveRoute, adjustRouteConfidence, upsertNode,
  insertCall, getCallById, findCallByControlId, updateCall, logEvent,
  insertVerification,
} from "./store";
import { preCallCheck } from "./compliance";
import { recordLiveAnswer, recordVoicemail } from "./outreach";
import {
  GUARDRAILS, CONFIDENCE,
  type IntelCall, type RouteStep, type SuccessType, type Disposition, type AnswerClass,
} from "./types";

/**
 * Fail-safe line played whenever a LIVE person answers (user rule): a graceful,
 * honest exit, then hang up. The number that reached this human is then burned
 * for the contact so they never get a call from it again.
 */
function exitLine(): string {
  return "Sorry, I was directed to the wrong person. Have a good day.";
}

interface StartOpts {
  workspaceId: string;
  companyName: string;
  domain?: string;
  mainPhone: string; // E.164
  targetFirst?: string;
  targetLast?: string;
  targetFull: string;
  targetTitle?: string;
  targetContactId?: string;
  fromNumber: string; // caller ID (a provisioned line)
  lineId?: string;
  /** Callee location ("Austin, TX") for calling-hours + recording jurisdiction. */
  location?: string;
  stateCode?: string;
}

/** Create the call record and place the outbound leg. Returns the IntelCall. */
export async function startCall(opts: StartOpts): Promise<IntelCall> {
  await ensureIntelReady();
  const companyKey = companyKeyOf({ domain: opts.domain, companyName: opts.companyName });

  upsertProfile(opts.workspaceId, {
    companyKey, companyName: opts.companyName, domain: opts.domain, mainPhone: opts.mainPhone,
  });

  // Compliance gate (calling hours, velocity, company fatigue) — fail-closed.
  const gate = preCallCheck({
    workspaceId: opts.workspaceId, companyKey, contactId: opts.targetContactId,
    fromNumber: opts.fromNumber, location: opts.location, stateCode: opts.stateCode,
  });
  if (!gate.allowed) {
    const blocked = insertCall({
      workspaceId: opts.workspaceId, mode: "discovery", state: "failed",
      companyKey, companyName: opts.companyName,
      targetContactId: opts.targetContactId, targetFirst: opts.targetFirst,
      targetLast: opts.targetLast, targetFull: opts.targetFull, targetTitle: opts.targetTitle,
      toNumber: opts.mainPhone, fromNumber: opts.fromNumber, lineId: opts.lineId,
      successTypes: [], stepIndex: 0, ivrSteps: 0, directorySearches: 0, unknownPrompts: 0,
      promptHistory: [], events: [], startedAt: new Date().toISOString(),
      disposition: "UNKNOWN", endedAt: new Date().toISOString(),
    });
    logEvent(blocked, "BLOCKED", { detail: gate.reason, reason: "compliance gate", source: "rule" });
    return blocked;
  }
  const route = activeRoute(opts.workspaceId, companyKey);
  const mode: IntelCall["mode"] =
    route && route.confidence >= CONFIDENCE.REDISCOVER_BELOW ? "known_route" : "discovery";

  const call = insertCall({
    workspaceId: opts.workspaceId,
    mode,
    state: "queued",
    companyKey,
    companyName: opts.companyName,
    targetContactId: opts.targetContactId,
    targetFirst: opts.targetFirst,
    targetLast: opts.targetLast,
    targetFull: opts.targetFull,
    targetTitle: opts.targetTitle,
    toNumber: opts.mainPhone,
    fromNumber: opts.fromNumber,
    lineId: opts.lineId,
    successTypes: [],
    stepIndex: 0,
    ivrSteps: 0,
    directorySearches: 0,
    unknownPrompts: 0,
    promptHistory: [],
    events: [],
    startedAt: new Date().toISOString(),
  });
  logEvent(call, "QUEUED", { detail: `${mode} mode`, source: mode === "known_route" ? "known_route" : "rule" });

  try {
    await withWorkspaceCreds(opts.workspaceId, async () => {
      const infra = await ensureIntelInfra(opts.workspaceId);
      if (!infra.connectionId) throw new Error("phone_intel_not_provisioned: connect Telnyx for this workspace");
      const leg = await telnyx.dialLeg({
        to: opts.mainPhone,
        from: opts.fromNumber,
        connectionId: infra.connectionId,
        clientState: { intel: 1, callId: call.id, workspaceId: opts.workspaceId },
        timeoutSecs: 40,
      });
      const ccid = leg?.data?.call_control_id;
      updateCall(call, { state: "dialing", telnyxCallControlId: ccid ? String(ccid) : undefined });
      logEvent(call, "DIALING", { detail: opts.mainPhone });
    });
  } catch (e: any) {
    updateCall(call, { state: "failed", disposition: "UNKNOWN", endedAt: new Date().toISOString() });
    logEvent(call, "DIAL_FAILED", { detail: String(e?.message ?? e).slice(0, 200) });
  }
  return call;
}

/* ------------------------------ webhook loop ----------------------------- */

function decodeState(raw?: string | null): Record<string, any> {
  if (!raw) return {};
  try { return JSON.parse(Buffer.from(raw, "base64").toString("utf8")); } catch { return {}; }
}

/** Dispatch a Telnyx event for an intel call. Always resolves (never throws to the webhook). */
export async function handleIntelEvent(type: string, ev: any): Promise<string> {
  const st = decodeState(ev?.client_state);
  const ccid: string | undefined = ev?.call_control_id;
  const call =
    (st.callId ? getCallById(String(st.callId)) : undefined) ??
    (ccid ? findCallByControlId(ccid) : undefined);
  if (!call) return "no_call";
  if (!call.telnyxCallControlId && ccid) updateCall(call, { telnyxCallControlId: ccid });

  switch (type) {
    case "call.answered": return onAnswered(call);
    case "call.machine.detection.ended": return onAmd(call, ev);
    case "call.transcription": return onTranscription(call, ev);
    case "call.hangup": return onHangup(call, ev);
    default: return "ignored";
  }
}

async function onAnswered(call: IntelCall): Promise<string> {
  if (call.state !== "dialing" && call.state !== "queued" && call.state !== "ringing") return "dup_answer";
  updateCall(call, { state: "classifying", answeredAt: new Date().toISOString() });
  logEvent(call, "ANSWERED", { source: "rule" });
  // Company number connects → the number itself is verified regardless of who answers.
  addSuccess(call, "COMPANY_PHONE_VERIFIED");
  patchProfile(call.workspaceId, call.companyKey, { phoneSystemDetected: true, lastVerifiedAt: new Date().toISOString() });
  await withWorkspaceCreds(call.workspaceId, async () => {
    const id = call.telnyxCallControlId!;
    // Evidence recording + real-time transcription for the live decision loop.
    await telnyx.recordStart(id, { transcription: false, channels: "dual", maxLengthSecs: GUARDRAILS.MAX_DURATION_SEC }).catch(() => {});
    await startTranscription(id, { interim: false }).catch(() => {});
  });
  return "answered";
}

function onAmd(call: IntelCall, ev: any): string {
  const result = String(ev?.result ?? ev?.machine_detection_result ?? "").toLowerCase();
  const isMachine = result.includes("machine") ? true : result.includes("human") ? false : undefined;
  logEvent(call, "AMD", { detail: result, source: "classifier" });
  updateCall(call, {} as any);
  (call as any)._amdMachine = isMachine; // transient hint for the next transcription
  return "amd";
}

async function onTranscription(call: IntelCall, ev: any): Promise<string> {
  const data = ev?.transcription_data ?? ev;
  if (data?.is_final === false) return "interim";
  const text: string = String(data?.transcript ?? "").trim();
  if (!text) return "empty";

  // Guardrails first (spec §40).
  const elapsed = (Date.now() - Date.parse(call.startedAt)) / 1000;
  if (elapsed > GUARDRAILS.MAX_DURATION_SEC || call.ivrSteps > GUARDRAILS.MAX_IVR_STEPS) {
    return finishAndHangup(call, "IVR_ROUTE_FAILED", "guardrail: max steps/duration");
  }

  const fp = promptFingerprint(text);
  const sameNode = call.promptHistory.filter((h) => h === fp).length;
  if (sameNode >= GUARDRAILS.MAX_SAME_NODE) {
    return finishAndHangup(call, "IVR_ROUTE_FAILED", "loop detected");
  }
  updateCall(call, { promptHistory: [...call.promptHistory.slice(-20), fp] });

  const isMachine = (call as any)._amdMachine as boolean | undefined;
  const cls = classifyAnswer(text, isMachine);
  logEvent(call, "PROMPT", { detail: text.slice(0, 160), reason: cls.class, confidence: cls.confidence, source: "rule" });

  switch (cls.class) {
    case "voicemail_named": return verifyVoicemail(call, cls.detectedName ?? "", text);
    case "human_receptionist":
    case "human_generic": return humanExit(call, cls.class, text);
    case "voicemail_generic": {
      // Generic mailbox: capture any extension, mark number valid, exit.
      const ext = text.match(/extension\s+(\d{2,6})/i)?.[1];
      if (ext) { updateCall(call, { extension: ext }); addSuccess(call, "EXTENSION_DISCOVERED"); }
      return finishAndHangup(call, "GENERIC_VOICEMAIL", "generic mailbox");
    }
    case "ivr":
    default: return navigateIvr(call, text, fp);
  }
}

/** IVR present: either replay the known route step or discover the next action. */
async function navigateIvr(call: IntelCall, text: string, fp: string): Promise<string> {
  addSuccess(call, "IVR_DETECTED");
  patchProfile(call.workspaceId, call.companyKey, { systemType: "ivr", phoneSystemDetected: true });
  updateCall(call, { state: "navigating", ivrSteps: call.ivrSteps + 1 });

  // Known-route replay.
  if (call.mode === "known_route") {
    const route = activeRoute(call.workspaceId, call.companyKey);
    const step = route?.steps[call.stepIndex];
    if (step) {
      // Change detection (spec §12): the expected prompt must still fingerprint-match.
      if (step.waitFor && step.waitFor !== fp) {
        logEvent(call, "ROUTE_MISMATCH", { detail: "menu changed; entering discovery", source: "rule" });
        if (route) adjustRouteConfidence(call.workspaceId, route.id, CONFIDENCE.MENU_CHANGED, false);
        updateCall(call, { mode: "discovery" });
      } else {
        return execStep(call, step);
      }
    }
  }

  // Discovery: directory instruction? (name-search prompt)
  const dir = parseDirectoryInstruction(text);
  if (dir) return enterDirectory(call, dir, fp);

  // Otherwise a menu — extract options and choose by routing priority (spec §8).
  const options = extractMenuOptions(text);
  if (options.length) {
    upsertNode(call.workspaceId, {
      companyKey: call.companyKey, promptHash: fp, promptTranscript: text.slice(0, 400),
      options,
    });
    // Priority: extension-known < directory < operator (only if no directory).
    const directory = options.find((o) => o.isDirectory);
    const chosen = directory ?? options.find((o) => o.isOperator) ?? options[0];
    recordStep(call, { waitFor: fp, action: { type: "dtmf", value: chosen.digit }, meaning: chosen.meaning });
    logEvent(call, "SEND_DTMF", { detail: chosen.digit, reason: chosen.meaning, confidence: directory ? 0.95 : 0.6, source: "rule" });
    await withWorkspaceCreds(call.workspaceId, () => sendDtmf(call.telnyxCallControlId!, chosen.digit).catch(() => {}));
    if (directory) addSuccess(call, "DIRECTORY_FOUND");
    return "menu_dtmf";
  }

  // Unknown prompt — count toward the abort guardrail.
  const unknown = call.unknownPrompts + 1;
  updateCall(call, { unknownPrompts: unknown });
  logEvent(call, "UNKNOWN_PROMPT", { detail: text.slice(0, 120), source: "rule" });
  if (unknown >= GUARDRAILS.MAX_UNKNOWN_PROMPTS) {
    return finishAndHangup(call, "IVR_ROUTE_FAILED", "too many unknown prompts");
  }
  return "unknown_prompt";
}

/** Execute a cached deterministic route step. */
async function execStep(call: IntelCall, step: RouteStep): Promise<string> {
  updateCall(call, { stepIndex: call.stepIndex + 1 });
  if (step.action.type === "dtmf") {
    logEvent(call, "SEND_DTMF", { detail: step.action.value, reason: step.meaning, source: "known_route" });
    await withWorkspaceCreds(call.workspaceId, () => sendDtmf(call.telnyxCallControlId!, (step.action as any).value).catch(() => {}));
    return "route_dtmf";
  }
  if (step.action.type === "dynamic_name_search" || step.action.type === "speak_name") {
    const profile = getProfile(call.workspaceId, call.companyKey);
    if (profile?.directorySpec) {
      const inp = directoryInput(profile.directorySpec, { first: call.targetFirst, last: call.targetLast, full: call.targetFull });
      return submitDirectory(call, inp);
    }
  }
  return "route_step_noop";
}

/** A directory search prompt: parse spec, cache it, submit the target's name. */
async function enterDirectory(
  call: IntelCall,
  dir: ReturnType<typeof parseDirectoryInstruction>,
  fp: string,
): Promise<string> {
  addSuccess(call, "DIRECTORY_FOUND");
  updateCall(call, { state: "searching_directory", directorySearches: call.directorySearches + 1 });
  if (call.directorySearches > GUARDRAILS.MAX_DIRECTORY_SEARCHES) {
    return finishAndHangup(call, "DIRECTORY_NO_MATCH", "exceeded directory attempts");
  }
  if (!dir) return "no_dir_spec";
  if ("extension" in dir) {
    if (call.extension) {
      recordStep(call, { waitFor: fp, action: { type: "extension" }, meaning: "known extension" });
      logEvent(call, "SEND_DTMF", { detail: call.extension, reason: "known extension", source: "rule" });
      await withWorkspaceCreds(call.workspaceId, () => sendDtmf(call.telnyxCallControlId!, call.extension! + "#").catch(() => {}));
      return "extension_dtmf";
    }
    return "extension_prompt_no_ext"; // wait for a directory option instead
  }
  // dir is a DirectorySpec here. Cache the directory format on the profile so
  // every future prospect at this company reuses it (no re-interpretation).
  const spec = dir;
  patchProfile(call.workspaceId, call.companyKey, { directoryAvailable: true, directorySpec: spec });
  recordStep(call, { waitFor: fp, action: { type: spec.input === "speech" ? "speak_name" : "dynamic_name_search" }, meaning: "directory name search" });
  const inp = directoryInput(spec, { first: call.targetFirst, last: call.targetLast, full: call.targetFull });
  return submitDirectory(call, inp);
}

async function submitDirectory(call: IntelCall, inp: { dtmf?: string; speak?: string }): Promise<string> {
  await withWorkspaceCreds(call.workspaceId, async () => {
    const id = call.telnyxCallControlId!;
    if (inp.dtmf) {
      logEvent(call, "SEND_DTMF", { detail: inp.dtmf, reason: "name search", source: "rule" });
      await sendDtmf(id, inp.dtmf).catch(() => {});
    } else if (inp.speak) {
      logEvent(call, "SPEAK_NAME", { detail: inp.speak, reason: "speech directory", source: "rule" });
      await telnyx.speak(id, inp.speak).catch(() => {});
    }
  });
  addSuccess(call, "DIRECTORY_SEARCH_SUCCESS");
  return "directory_submitted";
}

/** Named voicemail reached: fuzzy-match the greeting to the target (spec §15-16). */
function verifyVoicemail(call: IntelCall, detectedName: string, transcript: string): Promise<string> {
  updateCall(call, { state: "verifying", detectedName });
  const m = matchName({ first: call.targetFirst, last: call.targetLast, full: call.targetFull }, detectedName);
  updateCall(call, { nameMatchScore: m.score });
  logEvent(call, "VERIFY", { detail: `heard "${detectedName}"`, reason: m.verdict, confidence: m.score, source: "rule" });

  if (m.verdict === "match") {
    addSuccess(call, "TARGET_VOICEMAIL_VERIFIED");
    addSuccess(call, "ROUTE_VERIFIED");
    // Ledger: this number reached the target's voicemail — prefer it for the
    // targeted voicemail drop + follow-ups (user rule). Phase 2 leaves the
    // message here; Phase 1 verifies and exits.
    if (call.fromNumber) {
      recordVoicemail(
        call.workspaceId,
        { contactId: call.targetContactId, companyKey: call.companyKey, targetFull: call.targetFull },
        call.fromNumber,
      );
    }
    insertVerification({
      workspaceId: call.workspaceId, callId: call.id, companyKey: call.companyKey,
      contactId: call.targetContactId, targetFull: call.targetFull,
      verificationType: "voicemail_name_match", detectedName, confidence: m.score, success: true,
      evidence: { transcript: transcript.slice(0, 240) },
    });
    promoteRoute(call, true);
    return finishAndHangup(call, "TARGET_VERIFIED_VOICEMAIL", `name match ${m.score}`);
  }
  // Probable / no-match: record the extension as evidence but don't over-claim.
  return finishAndHangup(call, m.verdict === "probable" ? "DIRECTORY_MATCH" : "DIRECTORY_NO_MATCH", `name ${m.verdict} ${m.score}`);
}

/**
 * Live human — play the fail-safe line, hang up, and burn this calling number
 * for the contact so they never get a call from it again (user rule). Applies
 * whether it's a receptionist, a generic "hello?", or the target endpoint
 * picking up: we do NOT pitch, we exit.
 */
async function humanExit(call: IntelCall, kind: AnswerClass, _text: string): Promise<string> {
  updateCall(call, { state: "exiting" });
  addSuccess(call, kind === "human_receptionist" ? "LIVE_RECEPTIONIST" : "GENERIC_HUMAN");
  logEvent(call, "HUMAN", { detail: kind, reason: "fail-safe exit + burn number", source: "rule" });
  // Ledger: count the live answer and burn the from-number for this contact.
  if (call.fromNumber) {
    recordLiveAnswer(
      call.workspaceId,
      { contactId: call.targetContactId, companyKey: call.companyKey, targetFull: call.targetFull },
      call.fromNumber,
    );
  }
  await withWorkspaceCreds(call.workspaceId, () =>
    telnyx.speak(call.telnyxCallControlId!, exitLine()).catch(() => {}),
  );
  // Give the line ~1.5s to finish playing before the hangup.
  return finishAndHangup(call, kind === "human_receptionist" ? "RECEPTIONIST" : "GENERIC_HUMAN", "fail-safe exit", 1800);
}

/* ------------------------------- helpers -------------------------------- */

function addSuccess(call: IntelCall, s: SuccessType): void {
  if (!call.successTypes.includes(s)) updateCall(call, { successTypes: [...call.successTypes, s] });
}

/** Accumulate a discovered step so a successful call can be saved as a route. */
function recordStep(call: IntelCall, step: RouteStep): void {
  (call as any)._steps = [...((call as any)._steps ?? []), step];
}

function promoteRoute(call: IntelCall, verified: boolean): void {
  const steps: RouteStep[] = (call as any)._steps ?? [];
  if (!steps.length) return;
  const existing = activeRoute(call.workspaceId, call.companyKey);
  if (existing) {
    adjustRouteConfidence(call.workspaceId, existing.id, CONFIDENCE.SUCCESS, verified);
  } else {
    saveRoute(call.workspaceId, {
      companyKey: call.companyKey, mainPhone: call.toNumber, steps,
      confidence: verified ? CONFIDENCE.VERIFIED_AT : 0.6,
    });
    logEvent(call, "ROUTE_SAVED", { detail: `${steps.length} steps`, source: "rule" });
  }
}

async function finishAndHangup(
  call: IntelCall, disposition: Disposition, reason: string, delayMs = 0,
): Promise<string> {
  if (call.state === "completed" || call.state === "failed") return "already_done";
  updateCall(call, { disposition });
  logEvent(call, "DISPOSITION", { detail: disposition, reason, source: "rule" });
  const doHangup = async () => {
    await withWorkspaceCreds(call.workspaceId, async () => {
      const id = call.telnyxCallControlId;
      if (id) { await telnyx.recordStop(id).catch(() => {}); await telnyx.hangup(id).catch(() => {}); }
    });
  };
  if (delayMs > 0) setTimeout(() => { void doHangup(); }, delayMs);
  else await doHangup();
  return "disposition:" + disposition;
}

function onHangup(call: IntelCall, _ev: any): string {
  if (call.state === "completed") return "dup_hangup";
  const ended = new Date().toISOString();
  const dur = call.answeredAt ? Math.round((Date.parse(ended) - Date.parse(call.answeredAt)) / 1000) : 0;
  // No disposition yet → the far end hung up before we classified.
  const disposition: Disposition = call.disposition ??
    (call.answeredAt ? "UNKNOWN" : "NO_ANSWER");
  updateCall(call, { state: "completed", endedAt: ended, durationSec: dur, disposition });
  logEvent(call, "HANGUP", { detail: `${dur}s`, reason: disposition, source: "rule" });
  return "hangup";
}
