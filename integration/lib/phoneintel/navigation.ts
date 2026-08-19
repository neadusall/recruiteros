/**
 * RecruitersOS · Phone Intelligence · IVR navigation planner
 *
 * The single deterministic brain that turns "what we just heard" into "the next
 * keystroke", always using the TARGET'S FIRST + LAST NAME as the benchmark. It
 * composes the readers in classify.ts into ONE ranked decision so the orchestrator
 * has exactly one place to ask "given this prompt and who I'm after, what now?".
 *
 * Priority (highest first) — each rung is the most direct path to the named
 * person that the current prompt supports:
 *
 *   1. CONFIRMATION      the system read a name back ("did you say John Smith?").
 *                        Press yes iff it matches the target; else press no/retry.
 *   2. NAMED LIST        a multi-match directory list ("for John Smith press 1,
 *                        for John Smyth press 2"). Pick the digit whose spoken
 *                        name best matches the target.
 *   3. CONNECTING        "please hold while I connect you to <name>" — a transfer
 *                        in progress; wait (we are being routed to the person).
 *   4. DIRECTORY FORMAT  a name-entry instruction ("enter first 3 of last name",
 *                        "say the name") — key/say the TARGET'S name.
 *   5. EXTENSION AHEAD   "if you know the extension, dial it now" AND we know it.
 *   6. DIRECTORY OPTION  a menu that offers the company directory — press it; the
 *                        directory is the deterministic route to a specific person.
 *   7. DEPARTMENT        no directory, but a department fits the target's title
 *                        ("press 3 for sales", target is VP Sales) — a human on
 *                        that team can transfer us by name.
 *   8. OPERATOR          no directory/department — reach a receptionist who can
 *                        look the person up by first + last name.
 *   9. ZERO-OUT          a menu with no parsed operator — press 0 (near-universal
 *                        operator), once.
 *  10. UNKNOWN           nothing actionable — the orchestrator counts it toward
 *                        the abort guardrail.
 *
 * Pure and dependency-free; navigation is fully unit-testable without a call.
 */

import type { DirectorySpec, NameParts } from "./keypad";
import {
  extractMenuOptions, matchNamedOptions, parseConfirmation, detectConnecting,
  parseDirectoryInstruction, detectExtensionInvite, detectContinueGate,
  departmentForTitle, matchDepartmentOption, matchName,
  type MenuOption,
} from "./classify";

export interface NavTarget extends NameParts {
  /** Job title, used only for the department-fallback rung. */
  title?: string;
}

export interface NavContext {
  /** Known/discovered extension for this person, if any (dial-ahead). */
  knownExtension?: string;
  /** Digits already sent on this call, so we never loop the same keypress. */
  triedDigits?: string[];
  /** Directory searches already attempted (cap guard). */
  directorySearches?: number;
}

export type IvrMove =
  | { kind: "directory_enter"; spec: DirectorySpec; reason: string; confidence: number }
  | { kind: "dtmf"; digit: string; reason: string; confidence: number; isDirectoryNav?: boolean; isOperator?: boolean }
  | { kind: "extension"; digits: string; reason: string; confidence: number }
  | { kind: "wait"; reason: string; confidence: number }
  | { kind: "unknown"; reason: string; confidence: number };

const tried = (ctx: NavContext, d: string) => (ctx.triedDigits ?? []).includes(d);

/**
 * Decide the single next move for an IVR prompt. `options` may be passed in
 * (when the caller already parsed them) or is derived from the transcript.
 */
export function planIvrMove(
  transcript: string,
  target: NavTarget,
  ctx: NavContext = {},
  options?: MenuOption[],
): IvrMove {
  const opts = options ?? extractMenuOptions(transcript);

  // 1. Confirmation read-back — a direct question about our target.
  const conf = parseConfirmation(transcript);
  if (conf.isConfirmation) {
    if (conf.name) {
      const m = matchName(target, conf.name);
      if (m.verdict !== "no_match") {
        return { kind: "dtmf", digit: conf.yesDigit, reason: `confirm match "${conf.name}" (${m.score})`, confidence: 0.9 };
      }
      if (conf.noDigit) {
        return { kind: "dtmf", digit: conf.noDigit, reason: `reject wrong name "${conf.name}"`, confidence: 0.7 };
      }
      return { kind: "unknown", reason: `confirmation for a non-matching name "${conf.name}" with no reject option`, confidence: 0.4 };
    }
    // Read-back with no name we could hear (e.g. "if correct press 1"): accept,
    // since we only reach a confirmation right after keying the target's name.
    return { kind: "dtmf", digit: conf.yesDigit, reason: "confirm (assumed our entry)", confidence: 0.6 };
  }

  // 2. Multi-match named list — pick the person who IS our target.
  const named = matchNamedOptions(opts, target);
  if (named.digit) {
    return {
      kind: "dtmf", digit: named.digit,
      reason: `matched target in list: "${named.detectedName}" (${named.score})`,
      confidence: Math.min(0.95, 0.6 + named.score * 0.35),
    };
  }

  // 3. Connecting/progress statement — a transfer is under way; hold.
  const conn = detectConnecting(transcript);
  if (conn.connecting && opts.length === 0) {
    return { kind: "wait", reason: conn.name ? `connecting to "${conn.name}"` : "transfer in progress", confidence: 0.7 };
  }

  // 4. A name-entry directory instruction — key/say the TARGET'S name.
  const dir = parseDirectoryInstruction(transcript);
  if (dir && !("extension" in dir)) {
    return { kind: "directory_enter", spec: dir, reason: `directory name search (${dir.field}/${dir.length}/${dir.input})`, confidence: 0.9 };
  }

  // 5. Extension dial-ahead (only if we actually know the extension).
  if ((("extension" in (dir ?? {})) || detectExtensionInvite(transcript)) && ctx.knownExtension) {
    return { kind: "extension", digits: ctx.knownExtension, reason: "known extension, dialing ahead", confidence: 0.85 };
  }

  // 5b. A pass-through gate ("press 1 to continue") on a spam-filtered line.
  const gate = detectContinueGate(transcript);
  if (gate && !tried(ctx, gate)) {
    return { kind: "dtmf", digit: gate, reason: "pass continue/connect gate", confidence: 0.6 };
  }

  // 6. A menu that offers the company directory — the deterministic route in.
  const directory = opts.find((o) => o.isDirectory && !tried(ctx, o.digit));
  if (directory) {
    return { kind: "dtmf", digit: directory.digit, reason: `open directory (${directory.meaning})`, confidence: 0.9, isDirectoryNav: true };
  }

  // 7. A department that fits the target's title — a human there can transfer us.
  const dept = departmentForTitle(target.title);
  const deptDigit = matchDepartmentOption(opts, dept);
  if (deptDigit && !tried(ctx, deptDigit)) {
    return { kind: "dtmf", digit: deptDigit, reason: `route to ${dept} (target's team)`, confidence: 0.65 };
  }

  // 8. Operator / receptionist — a person who can look up first + last name.
  const operator = opts.find((o) => o.isOperator && !tried(ctx, o.digit));
  if (operator) {
    return { kind: "dtmf", digit: operator.digit, reason: `operator (${operator.meaning})`, confidence: 0.6, isOperator: true };
  }

  // 9. A menu with no parsed operator — try 0 once (near-universal operator).
  if (opts.length > 0 && !tried(ctx, "0")) {
    return { kind: "dtmf", digit: "0", reason: "zero-out to operator (no explicit option)", confidence: 0.4, isOperator: true };
  }

  // 10. Nothing actionable.
  return { kind: "unknown", reason: "no directory, department, or operator path found", confidence: 0.2 };
}
