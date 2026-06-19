/**
 * RecruitersOS · Copy guardrail (deterministic scanner)
 *
 * The free, always-on first line of defense. Scans any generated copy against the
 * machine-checkable rules in lib/copy/guidelines and reports every violation. No LLM,
 * no cost — it runs everywhere (manual and automated). The Haiku critic (lib/copy/critic)
 * is the second pass that catches subtler "sounds like a bot" problems on the auto-send
 * path; this catches the hard, unambiguous ones.
 */

import { hasDash } from "../text/dashes";
import { HOLLOW_OPENERS, FABRICATED_REFERRAL, FORMAT_RULES, type CopyRule } from "./guidelines";

export interface Violation {
  rule: string;
  why: string;
  match: string;
}

export interface ScanResult {
  ok: boolean;
  violations: Violation[];
}

export interface ScanOptions {
  /** Allow referral/intro language because a REAL referral source is attached. */
  hasRealReferralSource?: boolean;
}

function runRules(text: string, rules: CopyRule[], out: Violation[]): void {
  for (const r of rules) {
    const m = text.match(r.test);
    if (m) out.push({ rule: r.id, why: r.why, match: m[0].trim() });
  }
}

/** Scan one string. Combines subject + body before scanning (call once per message). */
export function scanCopy(text: string, opts: ScanOptions = {}): ScanResult {
  const violations: Violation[] = [];
  const t = text ?? "";

  runRules(t, HOLLOW_OPENERS, violations);
  runRules(t, FORMAT_RULES, violations);
  if (!opts.hasRealReferralSource) runRules(t, FABRICATED_REFERRAL, violations);

  // Dashes: delegate to the canonical failsafe (ignores dashes inside URLs).
  if (hasDash(t)) violations.push({ rule: "dash", why: "no dashes of any kind in outbound copy", match: "—/–/-" });

  return { ok: violations.length === 0, violations };
}

/** Convenience: scan a subject+body pair as one message. */
export function scanMessage(msg: { subject?: string; body?: string; text?: string }, opts: ScanOptions = {}): ScanResult {
  const joined = [msg.subject, msg.body ?? msg.text].filter(Boolean).join("\n");
  return scanCopy(joined, opts);
}

/** A human/LLM-readable one-liner of what failed (fed back into self-repair + logs). */
export function describeViolations(v: Violation[]): string {
  return v.map((x) => `- ${x.why}${x.match && x.match !== "—/–/-" ? ` (found: "${x.match}")` : ""}`).join("\n");
}
