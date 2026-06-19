/**
 * RecruitersOS · Copy review gate (the fail-safe)
 *
 * Wraps any copy generator with: deterministic scan -> self-repair -> (auto-send only)
 * Haiku critic -> stage-for-review. Nothing weird ships on the automated path.
 *
 *   1. generate() -> scanCopy. Clean? continue. Dirty? regenerate feeding the exact
 *      violations back into the prompt (self-repair), up to maxTries.
 *   2. AUTO-SEND path only: once the scan is clean, run the critic. If it flags, take
 *      its rewrite (when that rewrite itself scans clean) or regenerate.
 *   3. Still failing after maxTries -> status "held": the caller stages it for human
 *      review instead of sending.
 *
 * Manual path: steps 1 + 3 only (no LLM critic); the human approval queue is the review.
 */

import { scanMessage, describeViolations, type Violation } from "./guardrail";
import { critique, type Critique } from "./critic";

export interface Copy {
  subject?: string;
  body: string;
}

/** A generator that, given an optional repair hint (the prior violations), produces copy. */
export type Generator = (repairHint?: string) => Promise<Copy>;

export interface ReviewOptions {
  /** True on the automated send path (no human will see it first) -> run the critic. */
  autoSend: boolean;
  /** A real referral source is attached -> referral/intro language is allowed. */
  hasRealReferralSource?: boolean;
  channel?: string;
  /** Current on-voice winner for this segment, passed to the critic as a reference. */
  winnerExample?: string;
  /** Regeneration attempts after the first (default 2). */
  maxTries?: number;
}

export interface ReviewResult {
  copy: Copy;
  status: "clean" | "repaired" | "held";
  violations: Violation[];
  critique?: Critique;
}

function joined(c: Copy): string {
  return [c.subject, c.body].filter(Boolean).join("\n");
}

/** Run the full fail-safe around a generator. */
export async function reviewCopy(generate: Generator, opts: ReviewOptions): Promise<ReviewResult> {
  const maxTries = opts.maxTries ?? 2;
  const scanOpts = { hasRealReferralSource: opts.hasRealReferralSource };
  let last: Copy = { body: "" };
  let lastViolations: Violation[] = [];
  let everRepaired = false;

  for (let attempt = 0; attempt <= maxTries; attempt++) {
    const hint = attempt === 0 ? undefined : describeViolations(lastViolations);
    last = await generate(hint);

    // 1) deterministic scan
    const scan = scanMessage(last, scanOpts);
    if (!scan.ok) {
      lastViolations = scan.violations;
      everRepaired = true;
      continue; // self-repair: regenerate with the violations fed back
    }

    // 2) auto-send only: the Haiku critic
    if (opts.autoSend) {
      const crit = await critique(joined(last), {
        channel: opts.channel,
        referralSource: opts.hasRealReferralSource ? "attached" : undefined,
        winnerExample: opts.winnerExample,
      });
      if (!crit.pass && !crit.skipped) {
        // Prefer the critic's rewrite if IT scans clean; otherwise regenerate.
        if (crit.rewrite) {
          const rw: Copy = { subject: last.subject, body: crit.rewrite };
          if (scanMessage(rw, scanOpts).ok) {
            return { copy: rw, status: "repaired", violations: [], critique: crit };
          }
        }
        lastViolations = (crit.issues.length ? crit.issues : ["fails the voice critic"]).map((i) => ({ rule: "critic", why: i, match: "" }));
        everRepaired = true;
        continue;
      }
      return { copy: last, status: everRepaired ? "repaired" : "clean", violations: [], critique: crit };
    }

    return { copy: last, status: everRepaired ? "repaired" : "clean", violations: [] };
  }

  // Exhausted tries -> hold for human review (never auto-send weird copy).
  return { copy: last, status: "held", violations: lastViolations };
}
