/**
 * RecruitersOS · JD Sourcing
 * Pure parser for a deep-vet model response → VetResult.
 *
 * Split out of deepVet.ts on purpose: this file has NO runtime imports (only a
 * type-only import), so it stays free and side-effect-free, and the eval harness
 * (scripts/eval-sourcing.ts) can exercise it without loading the Anthropic client or
 * spending a token. The synchronous call and the batch path both parse through here,
 * so a batch result is interpreted identically to a live one.
 */

import type { VetResult } from "./deepVet";

function clampScore(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function strArr(v: unknown, cap = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, cap);
}

/**
 * Parse the model's JSON verdict, tolerating prose around the object. A malformed
 * response degrades to a clearly-flagged "no" verdict rather than throwing — the
 * caller leaves that candidate effectively un-scored instead of crashing the run.
 */
export function parseVetResult(raw: string): VetResult {
  try {
    const o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const verdict = ["strong", "possible", "weak", "no"].includes(o.verdict) ? o.verdict : "possible";
    return {
      verifiedScore: clampScore(o.verifiedScore),
      verdict,
      yearsRelevant: Number.isFinite(Number(o.yearsRelevant)) ? Number(o.yearsRelevant) : undefined,
      strengths: strArr(o.strengths),
      gaps: strArr(o.gaps),
      flags: strArr(o.flags),
      rationale: String(o.rationale || "").slice(0, 400),
    };
  } catch {
    return { verifiedScore: 0, verdict: "no", strengths: [], gaps: [], flags: ["parse_error"], rationale: "Could not parse vetting result." };
  }
}
