/**
 * RecruitersOS · JD Sourcing
 * Optional LLM re-rank of the shortlist.
 *
 * The rule scorer (score.ts) is fast and free but blunt — it can't tell a "VP of Sales
 * who scaled a $50M SaaS book in your exact vertical" from someone whose title merely
 * contains those words. This pass sends a compact view of the top slice + the ICP to a
 * CHEAP model and gets back a 0-100 relevance per candidate, re-sorting the slice so the
 * genuinely-strongest land on top BEFORE the (paid) deep-vet runs. One call for the whole
 * slice — pennies — and it only touches the slice you choose.
 */

import { anthropicClient } from "./anthropic";
import type { CandidateICP, CandidateRow } from "./types";

// Light judgment — default to the cheap tier; override via env.
const MODEL = process.env.RECRUITEROS_RERANK_MODEL ?? "claude-haiku-4-5-20251001";

export interface ReRankResult {
  /** The full list with the top slice re-sorted by llmScore (rest untouched, appended). */
  candidates: CandidateRow[];
  /** How many candidates received an llmScore. */
  ranked: number;
  warning?: string;
}

function renderIcp(icp: CandidateICP): string {
  return [
    `Role: ${icp.label}`,
    `Seniority: ${icp.seniority}${icp.managesTeam ? " (must manage a team)" : ""}`,
    icp.titles.length ? `Target titles: ${icp.titles.slice(0, 12).join(", ")}` : "",
    icp.industries.length ? `Industries: ${icp.industries.slice(0, 12).join(", ")}` : "",
    icp.geos.length ? `Geos: ${icp.geos.slice(0, 12).join(", ")}${icp.remoteOk ? " (remote ok)" : ""}` : "",
    icp.targetCompanies.length ? `Target companies: ${icp.targetCompanies.slice(0, 12).join(", ")}` : "",
    icp.mustHave.length ? `Must have: ${icp.mustHave.slice(0, 12).join(", ")}` : "",
    icp.disqualifiers.length ? `Disqualifiers: ${icp.disqualifiers.slice(0, 12).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

/** First text block out of a Messages response. */
function textOf(content: any[]): string {
  const block = Array.isArray(content) ? content.find((b) => b && b.type === "text") : undefined;
  return block && block.type === "text" ? block.text : "{}";
}

/** Tolerant JSON parse: strips ```json fences and trailing prose. */
function parseScores(text: string): Array<{ i: number; s: number }> {
  let t = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const obj = JSON.parse(t);
    const arr = Array.isArray(obj?.scores) ? obj.scores : [];
    return arr
      .map((x: any) => ({ i: Number(x?.i), s: Number(x?.s) }))
      .filter((x: { i: number; s: number }) => Number.isFinite(x.i) && Number.isFinite(x.s));
  } catch {
    return [];
  }
}

const SYSTEM = `You re-rank candidates by TRUE relevance to a role's ideal-candidate profile.
Score each candidate 0-100 on how well they fit — weigh title/role match, seniority,
company/industry signal, and geography. Be discriminating: most are partial matches.
Return STRICT JSON only, no prose: {"scores":[{"i":<index>,"s":<0-100>}, ...]} with one
entry for every candidate index you were given.`;

/**
 * Re-rank the top `top` candidates by LLM relevance. Returns the full list with that slice
 * re-sorted (each stamped with llmScore) and the rest left in place. Throws only if the
 * model client is unconfigured; on a parse miss it returns the input order unchanged.
 */
export async function reRankCandidates(candidates: CandidateRow[], icp: CandidateICP, top = 100): Promise<ReRankResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const n = Math.max(1, Math.min(top, 100, candidates.length));
  const slice = candidates.slice(0, n);
  const rest = candidates.slice(n);

  const list = slice
    .map((c, i) => `${i}. ${c.fullName} — ${c.title || c.headline || "?"} @ ${c.company || "?"}${c.location ? " · " + c.location : ""}`)
    .join("\n");

  const resp = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `IDEAL PROFILE:\n"""\n${renderIcp(icp)}\n"""\n\nCANDIDATES (index. name — title @ company · location):\n${list}\n\nReturn the scores JSON.`,
    }],
  });

  const scores = parseScores(textOf(resp.content));
  if (!scores.length) {
    return { candidates, ranked: 0, warning: "rerank_parse_failed: kept the rule-score order" };
  }
  for (const { i, s } of scores) {
    if (i >= 0 && i < slice.length) slice[i].llmScore = Math.max(0, Math.min(100, Math.round(s)));
  }
  // Re-sort the slice by LLM score (fall back to the rule score when one is missing).
  slice.sort((a, b) => (b.llmScore ?? b.fitScore) - (a.llmScore ?? a.fitScore));
  return { candidates: [...slice, ...rest], ranked: scores.length };
}
