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

/** Candidates described per model call. Small enough that the scores JSON always fits
 *  inside max_tokens, large enough that a 1,000-row list is ten calls, not a hundred. */
export const RERANK_BATCH = 100;

/** How many batches are in the air at once. Bounded because a re-rank runs inside the
 *  search request: the point is to cover the list quickly, not to open fifty sockets. */
const RERANK_POOL = 4;

/**
 * Hard ceiling on how many people one re-rank will judge. A guard against a runaway
 * bill on a pathological list, not a quality choice: at Haiku prices even the ceiling
 * is a fraction of a cent per person.
 */
export const RERANK_MAX = Math.max(
  RERANK_BATCH,
  Number(process.env.RECRUITEROS_RERANK_MAX) || 1000,
);

/** Score ONE batch. Resolves to the raw index/score pairs, or [] if the model's answer
 *  was unusable — a bad batch must cost that batch its re-rank, never the whole run. */
async function scoreBatch(slice: CandidateRow[], icp: CandidateICP): Promise<Array<{ i: number; s: number }>> {
  const list = slice
    .map((c, i) => `${i}. ${c.fullName} — ${c.title || c.headline || "?"} @ ${c.company || "?"}${c.location ? " · " + c.location : ""}`)
    .join("\n");
  try {
    const resp = await anthropicClient().messages.create({
      model: MODEL,
      // One entry per candidate, so the budget has to scale with the batch.
      max_tokens: 32 * slice.length + 512,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `IDEAL PROFILE:\n"""\n${renderIcp(icp)}\n"""\n\nCANDIDATES (index. name — title @ company · location):\n${list}\n\nReturn the scores JSON.`,
      }],
    });
    return parseScores(textOf(resp.content));
  } catch {
    return [];
  }
}

/**
 * Re-rank the first `top` candidates by LLM relevance. Returns the full list with that
 * span re-sorted (each stamped with llmScore) and the rest left in place. Throws only if
 * the model client is unconfigured; a parse miss returns the input order unchanged.
 *
 * WHY THIS BATCHES (2026-08-07). It used to judge 100 people and no more — the cap was
 * hardcoded, so `top` above 100 silently did nothing. On the desk's real lists that meant
 * a 1,892-person run got LLM judgment on 5% of itself and the other 1,792 people were
 * ordered, delivered and contacted on the rule score alone. The rule scorer is a triage
 * layer by design (see score.ts): blunt, free, and unable to tell a genuine match from a
 * title that merely contains the right words. Now the span is covered in batches of
 * RERANK_BATCH, a few in flight at a time, so the judgment reaches everyone who will
 * actually be contacted. At Haiku prices a 1,000-person list costs a fraction of a cent.
 */
export async function reRankCandidates(candidates: CandidateRow[], icp: CandidateICP, top = 100): Promise<ReRankResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const n = Math.max(1, Math.min(top, RERANK_MAX, candidates.length));
  const slice = candidates.slice(0, n);
  const rest = candidates.slice(n);

  // Batch boundaries. Indices are per-batch, so each batch's scores are applied against
  // its own offset — mixing those up would stamp the right scores onto the wrong people.
  const batches: Array<{ offset: number; rows: CandidateRow[] }> = [];
  for (let o = 0; o < slice.length; o += RERANK_BATCH) {
    batches.push({ offset: o, rows: slice.slice(o, o + RERANK_BATCH) });
  }

  let ranked = 0;
  let failedBatches = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(RERANK_POOL, batches.length) }, async () => {
    for (;;) {
      const b = batches[next++];
      if (!b) return;
      const scores = await scoreBatch(b.rows, icp);
      if (!scores.length) { failedBatches++; continue; }
      for (const { i, s } of scores) {
        if (i >= 0 && i < b.rows.length) {
          b.rows[i].llmScore = Math.max(0, Math.min(100, Math.round(s)));
          ranked++;
        }
      }
    }
  }));

  if (!ranked) {
    return { candidates, ranked: 0, warning: "rerank_parse_failed: kept the rule-score order" };
  }

  // Re-sort the whole covered span by LLM score (fall back to the rule score when one is
  // missing, so people in a batch the model fumbled keep their triage position rather
  // than sinking below everyone).
  slice.sort((a, b) => (b.llmScore ?? b.fitScore) - (a.llmScore ?? a.fitScore));
  // Keep the location split intact: on a geo-pinned search the in-area block always
  // precedes the out-of-area block, so the re-rank can't hoist an out-of-area person
  // above the locals (order within each block is the LLM order).
  const inArea = slice.filter((c) => !c.outOfArea);
  const outArea = slice.filter((c) => c.outOfArea);
  return {
    candidates: [...inArea, ...outArea, ...rest],
    ranked,
    warning: failedBatches
      ? `rerank_partial: ${failedBatches} of ${batches.length} batches kept the rule-score order`
      : undefined,
  };
}
