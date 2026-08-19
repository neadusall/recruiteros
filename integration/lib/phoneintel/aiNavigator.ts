/**
 * RecruitersOS · Phone Intelligence · AI fallback navigator
 *
 * WHY THIS EXISTS. There are dozens of corporate phone-system vendors
 * (RingCentral, 8x8, Cisco Unity, Avaya, Mitel, Zoom Phone, Nextiva, Dialpad,
 * Vonage, GoTo, Genesys, Five9, Microsoft Teams Phone, Google Voice, …), but they
 * converge onto the SAME handful of interaction primitives (menu, dial-by-name,
 * extension, operator, voicemail). The deterministic reader in classify.ts +
 * planner in navigation.ts cover those primitives across every phrasing we have
 * seen — cheaply, with zero latency, and that is what runs 99% of the time.
 *
 * This module is the SAFETY NET for the long tail: a prompt phrased in a way the
 * rules do not recognize. Instead of aborting, we hand the model exactly what we
 * heard, who we are trying to reach (first + last name as the benchmark), and the
 * digits actually on offer, and let it choose ONE next move — CONSTRAINED so it
 * can only pick a real option, ask us to key the target's name (we do the keypad
 * encoding deterministically, so the model never invents digits), dial a known
 * extension, wait through a transfer, or give up. That is how we stay effective
 * on an IVR variation we have never encountered before.
 *
 * Fires ONLY when the deterministic planner returns "unknown", so cost + latency
 * are paid on the rare novel prompt, not the common path. Dry-run safe: with no
 * ANTHROPIC_API_KEY it returns null and the caller falls back to its own guard.
 * Latency matters (the IVR is live), so it defaults to the fast model.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IvrMove, NavTarget, NavContext } from "./navigation";
import type { MenuOption } from "./classify";
import { fingerprintSystem } from "./classify";
import type { DirectorySpec } from "./keypad";

// Fast model by default — the switchboard will not wait many seconds for a key.
const MODEL = process.env.RECRUITEROS_PHONE_INTEL_MODEL ?? "claude-haiku-4-5";

const SYSTEM = `You navigate a company phone system (IVR) on a LIVE call to reach ONE specific person's voicemail. You are given exactly what was just heard, the person you must reach, and the keypad options detected. Choose the SINGLE best next action to get closer to that person.

MISSION: reach the target person (their extension / dial-by-name entry / voicemail). The target's FIRST and LAST NAME is your benchmark for every choice.

PRIORITIES (most preferred first):
1. A dial-by-name / company directory — the deterministic route to a specific person.
2. If a directory read back MULTIPLE people, choose the one whose name matches the target.
3. If it is asking you to key or say a name, tell us to enter the target's name (never a menu digit).
4. A department that matches the target's title, then a receptionist/operator who can transfer by name.
Never invent social proof. Never choose a path that leads away from a specific person when a directory is available.

You do NOT compute keypad digits for a name — if the prompt wants a name, return action "enter_name" (for keypad) or "speak_name" (for a speech directory) and the system keys the target's real name for you.

Return STRICT JSON only, no prose:
{"action":"press"|"enter_name"|"speak_name"|"extension"|"wait"|"none",
 "digit":"<a single digit 0-9 or * or # — REQUIRED for press, must be one of the offered digits or 0>",
 "field":"last"|"first"|"firstlast"|"lastfirst",  // for enter_name: which name part the directory wants
 "length":<number or "full">,                      // for enter_name: how many leading letters
 "input":"dtmf"|"speech",                           // for enter_name (dtmf) vs speak
 "reason":"<short why>"}
- "press": choose a menu digit that exists in the offered options (or 0 for operator).
- "enter_name": the prompt is a dial-by-name keypad entry — give field/length/input.
- "speak_name": a speech directory asked to say the name.
- "extension": dial the known extension (only if one is provided).
- "wait": a transfer/hold is in progress; do nothing.
- "none": nothing sensible to do.`;

interface AiAction {
  action: "press" | "enter_name" | "speak_name" | "extension" | "wait" | "none";
  digit?: string;
  field?: DirectorySpec["field"];
  length?: number | "full";
  input?: DirectorySpec["input"];
  reason?: string;
}

function parseJson(s: string): AiAction | null {
  try {
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    return JSON.parse(s.slice(a, b + 1)) as AiAction;
  } catch {
    return null;
  }
}

/** Digits the model is allowed to press: the offered options plus the 0, star and pound universals. */
function allowedDigits(options: MenuOption[]): Set<string> {
  const s = new Set<string>(["0", "*", "#"]);
  for (const o of options) s.add(o.digit);
  return s;
}

/**
 * Map a validated model action onto a concrete IvrMove. PURE + exported so the
 * mapping (the safety-critical part) is unit-tested without a network call. An
 * out-of-bounds digit or nonsense action collapses to null (caller aborts safely).
 */
export function mapAiAction(
  action: AiAction | null,
  options: MenuOption[],
  ctx: NavContext,
): IvrMove | null {
  if (!action) return null;
  switch (action.action) {
    case "press": {
      const digit = String(action.digit ?? "").trim();
      if (!digit || !allowedDigits(options).has(digit) || (ctx.triedDigits ?? []).includes(digit)) return null;
      return { kind: "dtmf", digit, reason: `AI: ${action.reason || "menu choice"}`, confidence: 0.65 };
    }
    case "enter_name": {
      const field: DirectorySpec["field"] =
        action.field === "first" || action.field === "firstlast" || action.field === "lastfirst" ? action.field : "last";
      const length: DirectorySpec["length"] =
        typeof action.length === "number" && action.length > 0 ? action.length : "full";
      return { kind: "directory_enter", spec: { field, length, input: "dtmf" }, reason: `AI: ${action.reason || "name entry"}`, confidence: 0.65 };
    }
    case "speak_name":
      return { kind: "directory_enter", spec: { field: "firstlast", length: "full", input: "speech" }, reason: `AI: ${action.reason || "speak name"}`, confidence: 0.65 };
    case "extension":
      if (!ctx.knownExtension) return null;
      return { kind: "extension", digits: ctx.knownExtension, reason: `AI: ${action.reason || "dial extension"}`, confidence: 0.65 };
    case "wait":
      return { kind: "wait", reason: `AI: ${action.reason || "transfer in progress"}`, confidence: 0.55 };
    case "none":
    default:
      return null;
  }
}

export interface AiNavContext extends NavContext {
  companyName?: string;
}

/**
 * Ask the model for ONE next move on a prompt the rules could not classify.
 * Returns null on: no API key (dry-run), a model/parse error, or an action that
 * fails validation — in every one of those cases the caller keeps its own guard.
 */
export async function aiPlanMove(
  transcript: string,
  target: NavTarget,
  options: MenuOption[],
  ctx: AiNavContext = {},
): Promise<IvrMove | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const fp = fingerprintSystem(transcript);
  const offered = options.length
    ? options.map((o) => `  ${o.digit} = ${o.meaning}${o.isDirectory ? " [directory]" : ""}${o.isOperator ? " [operator]" : ""}`).join("\n")
    : "  (no clear press-N options detected)";
  const user =
    `TARGET person to reach:\n` +
    `  first name: ${target.first || "(unknown)"}\n  last name: ${target.last || "(unknown)"}\n` +
    (target.title ? `  title: ${target.title}\n` : "") +
    (ctx.companyName ? `  company: ${ctx.companyName}\n` : "") +
    (ctx.knownExtension ? `  known extension: ${ctx.knownExtension}\n` : "") +
    (ctx.triedDigits?.length ? `  already pressed (do NOT repeat): ${ctx.triedDigits.join(", ")}\n` : "") +
    (fp.system ? `  detected phone system: ${fp.system}${fp.note ? ` (${fp.note})` : ""}\n` : "") +
    `\nWhat was just heard on the call:\n"""${transcript.slice(0, 700)}"""\n\n` +
    `Offered keypad options:\n${offered}\n\nReturn the single best next action as JSON.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [{ role: "user", content: user }],
    });
    const block = res.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text : "";
    return mapAiAction(parseJson(text), options, ctx);
  } catch {
    return null;
  }
}
