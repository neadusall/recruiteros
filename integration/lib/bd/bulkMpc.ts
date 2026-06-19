/**
 * RecruitersOS · BD · Bulk MPC engine (the high-volume cold-email engine)
 *
 * The bulk sibling of ./mpcMessaging. Where mpcMessaging writes ONE rich, reasoned
 * MPC package per executive (an LLM call every send, 60-110 words), THIS engine is
 * built for thousands of emails from a single CSV upload, on a cost model that keeps
 * the LLM OFF the send path:
 *
 *   Stage 1  enrichRow()      one cheap LLM call per UNIQUE (title, company, location)
 *                              -> derives the few fields a human couldn't merge-tag:
 *                                 the role one rung BELOW the hiring manager, a real
 *                                 SAME-SIZE competitor, a real origin metro 50-200 mi
 *                                 from the company, and (optionally) a real proof point.
 *   Stage 2  assembleEmail()  NO LLM. Deterministically renders a sub-45-word email
 *                              from a rotating bank of MPC frames, chosen by row index
 *                              so output is varied (no two pattern-match) yet cacheable.
 *
 * The play is the classic "marketing a candidate" MPC move, tuned to what the data
 * says converts in cold outreach: trigger personalization (a candidate from a real
 * same-size competitor relocating to their city), under 45 words, lowercase curiosity
 * subject, a SOFT cta. See the session design notes / docs for the benchmarks.
 *
 * TRUTH IS NON-NEGOTIABLE (inherited house rule, same as mpcMessaging):
 *  - We NAME a competitor only when a REAL candidate from that competitor is attached
 *    to the row. With no real candidate, the engine falls back to honest soft phrasing
 *    ("a competitor your size") and never invents a specific person, company, or metric.
 *  - proofPoint is rendered only when it comes from a real candidate record.
 *  - The dash failsafe (../text/dashes) runs on every assembled field.
 */

import Anthropic from "@anthropic-ai/sdk";
import { sanitizeDashes } from "./sanitize";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
/** Enrichment is structured extraction, so it defaults to the cheap tier. */
const ENRICH_MODEL = process.env.RECRUITEROS_BULK_LLM_MODEL ?? "claude-haiku-4-5-20251001";

/** Geo window for a believable relocation: close enough to be real, far enough to flag. */
export const GEO_MIN_MILES = 50;
export const GEO_MAX_MILES = 200;
/** Hard ceiling on assembled body length — the data says shorter wins. */
export const MAX_BODY_WORDS = 45;

/** A real candidate we actually represent for this row (gates competitor naming). */
export interface BulkCandidate {
  /** Their role (overrides the LLM-derived subordinate role when present). */
  role?: string;
  /** The competitor they currently work at — naming this is what unlocks the hard hook. */
  fromCompany?: string;
  /** Their current metro (used as origin if 50-200 mi from the company). */
  currentCity?: string;
  /** ONE true, concrete achievement. Rendered verbatim-ish; never invented. */
  proofPoint?: string;
  pronoun?: Pronoun;
}

/** One hiring-manager row off the uploaded CSV (post import.ts normalization). */
export interface BulkBdRow {
  firstName: string;
  /** Hiring manager's title — the LLM derives the role one rung below this. */
  title: string;
  company: string;
  /** "Austin, TX" / "Columbus, OH" — anchors the relocation + the geo window. */
  companyLocation: string;
  companyDomain?: string;
  /** Attach a REAL candidate to unlock the named-competitor hook for this row. */
  candidate?: BulkCandidate;
}

export type Pronoun = "he" | "she" | "they";

/** What stage 1 produces; cache this per unique (title, company, location). */
export interface BulkBdEnrichment {
  subordinateRole: string;
  /** The real same-size competitor (only NAMED downstream when nameCompetitor). */
  competitor: string;
  competitorConfidence: number; // 0..1
  originCity: string;
  originMiles: number | null;
  pronoun: Pronoun;
  proofPoint?: string;
  /** Honest gate: name the competitor only with a real candidate from it. */
  nameCompetitor: boolean;
  /** Set when geo or confidence checks tripped a fallback; useful for QA dashboards. */
  notes: string[];
}

export interface CraftedEmail {
  subject: string;
  body: string;
  wordCount: number;
  frameId: number;
  /** True when the body names a real competitor (vs the soft "a competitor your size"). */
  named: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 1 — enrichment (the only LLM call; cheap + cacheable)         */
/* ------------------------------------------------------------------ */

const ENRICH_SYSTEM = `You enrich one B2B recruiting lead so a downstream template can write a short cold email. You output STRICT JSON, no prose.

You are given a hiring manager's title, their company, and the company's location. Derive:

1. "subordinateRole": the job title ONE rung directly below the given title in a normal org chart — the person this manager would actually hire and manage. CFO -> "VP of Finance". VP of Sales -> "Director of Sales". Director of Operations -> "Operations Manager". Use the natural title for that company's size and industry. Never return the same level as the input title.

2. "competitor": a REAL, direct competitor of the given company that is IN THE SAME SIZE BAND (similar headcount / revenue / market). A 60-person startup's competitor is a peer startup, NOT a megacorp. An enterprise's competitor is another enterprise. Same industry, same scale. If you are not confident a real same-size competitor exists, still give your best single guess but lower the confidence.

3. "competitorConfidence": 0.0-1.0 — how sure you are this is a real, correctly-sized, direct competitor.

4. "originCity": a REAL metropolitan area that is roughly ${GEO_MIN_MILES}-${GEO_MAX_MILES} miles from the company's location — close enough that relocating is believable, far enough that it is a genuine move. Prefer a city the competitor actually has a presence in. Real place names only.

5. "originMiles": your best integer estimate of the driving-ish distance in miles from originCity to the company location. Keep it within ${GEO_MIN_MILES}-${GEO_MAX_MILES} if at all possible.

6. "pronoun": "they" unless context makes "he"/"she" clearly appropriate — default "they".

RULES:
- Real companies and real places only. Do not invent a competitor or a city. If unsure, lower confidence rather than fabricate.
- Do NOT write any email copy. Output only the JSON object with exactly these keys:
  { "subordinateRole": string, "competitor": string, "competitorConfidence": number, "originCity": string, "originMiles": number, "pronoun": "he"|"she"|"they" }`;

/**
 * Derive the few fields a merge-tag can't. One cheap LLM call. A real candidate on
 * the row short-circuits the parts we already know (role, competitor, origin, proof)
 * and unlocks the named-competitor hook honestly.
 */
export async function enrichRow(row: BulkBdRow): Promise<BulkBdEnrichment> {
  const notes: string[] = [];
  const cand = row.candidate;

  const resp = await client.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 300,
    system: [{ type: "text", text: ENRICH_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content:
          `Title: ${row.title}\nCompany: ${row.company}` +
          (row.companyDomain ? ` (${row.companyDomain})` : "") +
          `\nCompany location: ${row.companyLocation}` +
          (cand?.role ? `\n(Candidate role already known: ${cand.role})` : "") +
          (cand?.currentCity ? `\n(Candidate currently in: ${cand.currentCity})` : "") +
          `\n\nReturn the JSON.`,
      },
    ],
  });

  const raw = resp.content.find((b) => b.type === "text");
  const j = safeJson(raw && raw.type === "text" ? raw.text : "{}");

  // A real candidate's facts always win over the model's guesses.
  const subordinateRole = str(cand?.role) || str(j.subordinateRole) || fallbackSubordinate(row.title);
  const competitor = str(cand?.fromCompany) || str(j.competitor) || "a competitor your size";
  let confidence = clamp01(Number(j.competitorConfidence));
  if (cand?.fromCompany) confidence = 1; // a real candidate from a real competitor is certain

  let originCity = str(cand?.currentCity) || str(j.originCity) || "";
  let originMiles: number | null = Number.isFinite(Number(j.originMiles)) ? Math.round(Number(j.originMiles)) : null;
  if (originMiles !== null && (originMiles < GEO_MIN_MILES || originMiles > GEO_MAX_MILES)) {
    notes.push(`origin ${originMiles}mi outside ${GEO_MIN_MILES}-${GEO_MAX_MILES} window; origin dropped from copy`);
    originCity = ""; // out of window -> assembly simply won't reference distance
    originMiles = null;
  }

  // HONEST GATE: name the competitor only when a real candidate from it is attached.
  const nameCompetitor = Boolean(cand?.fromCompany);
  if (!nameCompetitor) notes.push("no real candidate attached; using soft 'a competitor your size'");
  else if (confidence < 0.5) notes.push(`low competitor confidence (${confidence.toFixed(2)})`);

  return {
    subordinateRole,
    competitor,
    competitorConfidence: confidence,
    originCity,
    originMiles,
    pronoun: normPronoun(cand?.pronoun ?? (j.pronoun as Pronoun)),
    proofPoint: str(cand?.proofPoint) || undefined, // proof ONLY from a real candidate
    nameCompetitor,
    notes,
  };
}

/** Enrich many rows with bounded concurrency (cheap model, but be a good citizen). */
export async function enrichRows(rows: BulkBdRow[], concurrency = 6): Promise<BulkBdEnrichment[]> {
  const out: BulkBdEnrichment[] = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      try {
        out[i] = await enrichRow(rows[i]);
      } catch {
        // Never let one bad row kill the batch — fall back to a safe soft enrichment.
        out[i] = softFallback(rows[i]);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

/* ------------------------------------------------------------------ */
/* Stage 2 — deterministic assembly (no LLM, cacheable, varied)        */
/* ------------------------------------------------------------------ */

/**
 * The frame bank — the 20 MPC refs distilled into render templates. Each frame is
 * chosen by row index so a batch stays varied (no two adjacent rows share a skeleton)
 * yet identical inputs always render identically (cacheable, testable).
 *
 * Tokens: {first} {role} {competitor} {location} {origin} {proof}
 *  - {competitor} resolves to the real name OR the soft "a competitor your size".
 *  - frames that consume {origin}/{proof} are skipped when those fields are absent.
 */
interface Frame {
  subject: string;
  body: string;
  needs?: Array<"origin" | "proof">;
}

const FRAMES: Frame[] = [
  { subject: "someone at {competitor}", body: "{first}, I've got a {role} from {competitor} relocating to {location}. Worth a quick look?" },
  { subject: "quick one", body: "Hey {first}, a {role} at {competitor} is moving to {location} and open to conversations. Want their background?" },
  { subject: "{location} relocation", body: "{first}, working with a {role} out of {competitor} who wants to be in {location}. Open to a look?" },
  { subject: "{role} headed your way", body: "Morning {first}, a {role} at {competitor} is relocating to {location}. {proof}. Worth a look?", needs: ["proof"] },
  { subject: "from {competitor}", body: "{first}, quick one. {role} at {competitor} moving to {location}. Should I send the details over?" },
  { subject: "thought worth flagging", body: "Hey {first}, a {role} from {competitor} is making a move to {location}. Interested?" },
  { subject: "someone in your space", body: "{first}, I'm working with a {role} at {competitor} relocating to {location}. Want a quick look before I keep going?" },
  { subject: "{location}", body: "{first}, a {role} from {competitor} wants to land in {location}. {proof}. Open to it?", needs: ["proof"] },
  { subject: "quick question", body: "Hey {first}, would a {role} coming out of {competitor} into {location} be worth a look for you?" },
  { subject: "relocating your way", body: "{first}, {role} at {competitor} relocating to {location}, currently around {origin}. Want the background?", needs: ["origin"] },
  { subject: "one for you", body: "{first}, got a {role} from {competitor} moving to {location}. Strong one. Worth a quick look?" },
  { subject: "someone at {competitor}", body: "Hey {first}, a {role} at {competitor} is open and relocating to {location}. Should I send it over?" },
  { subject: "heads up", body: "{first}, heads up. {role} from {competitor} headed to {location}. {proof}. Look?", needs: ["proof"] },
  { subject: "quick one", body: "{first}, I've got a {role} out of {competitor} who wants to be in {location}. Open to a look?" },
  { subject: "{role}, {location}", body: "Hey {first}, a {role} at {competitor} is relocating to {location}. Worth ten minutes?" },
  { subject: "from a competitor", body: "{first}, working with a {role} from {competitor} moving into {location}. Want their details?" },
  { subject: "someone worth meeting", body: "{first}, a {role} at {competitor} wants to relocate to {location}. {proof}. Interested?", needs: ["proof"] },
  { subject: "quick one for you", body: "Morning {first}, {role} from {competitor} relocating to {location}. Open to a quick look?" },
  { subject: "{location} move", body: "{first}, got a {role} at {competitor} planning a move to {location}. Should I send the background?" },
  { subject: "relocating to {location}", body: "{first}, a {role} from {competitor} is relocating to {location} and open to talking. Worth a look?" },
];

/**
 * Render the email for a row. Deterministic in `index` (rotate the frame bank), so a
 * 200K-row batch is varied but every row is reproducible and cacheable. Picks the
 * first frame at/after `index` whose data needs are satisfied (skips proof/origin
 * frames when those fields are absent), then strips dashes and enforces the word cap.
 */
export function assembleEmail(row: BulkBdRow, enr: BulkBdEnrichment, index = 0): CraftedEmail {
  const competitorText = enr.nameCompetitor ? enr.competitor : "a competitor your size";
  const has = { origin: Boolean(enr.originCity), proof: Boolean(enr.proofPoint) };

  // Deterministic frame pick: start at index, advance until data needs are met.
  let frameId = ((index % FRAMES.length) + FRAMES.length) % FRAMES.length;
  for (let step = 0; step < FRAMES.length; step++) {
    const f = FRAMES[(frameId + step) % FRAMES.length];
    if (!f.needs || f.needs.every((n) => has[n])) { frameId = (frameId + step) % FRAMES.length; break; }
  }
  const frame = FRAMES[frameId];

  const tokens: Record<string, string> = {
    first: row.firstName?.trim() || "there",
    role: enr.subordinateRole,
    competitor: competitorText,
    location: row.companyLocation,
    origin: enr.originCity,
    proof: enr.proofPoint ?? "",
  };

  const subject = sanitizeDashes(render(frame.subject, tokens)).toLowerCase();
  let body = sanitizeDashes(tidy(render(frame.body, tokens)));
  body = enforceWordCap(body, MAX_BODY_WORDS);

  return { subject, body, wordCount: wordCount(body), frameId, named: enr.nameCompetitor };
}

/** Convenience: enrich + assemble one row. Prefer enrich-once/assemble-many at scale. */
export async function craftBulkMpc(row: BulkBdRow, index = 0): Promise<CraftedEmail> {
  return assembleEmail(row, await enrichRow(row), index);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function render(tpl: string, tokens: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? "");
}

/** Clean up artifacts from empty tokens / soft phrasing (double spaces, stray punctuation). */
function tidy(s: string): string {
  return s
    .replace(/\s+([.,?!])/g, "$1") // space before punctuation
    .replace(/([.?!])\s*\1+/g, "$1") // doubled terminal punctuation (". .")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim to a word ceiling without leaving a dangling clause; keep terminal punctuation. */
function enforceWordCap(s: string, max: number): string {
  const words = s.split(/\s+/);
  if (words.length <= max) return s;
  const kept = words.slice(0, max).join(" ").replace(/[,;:]?\s*$/, "");
  return /[.?!]$/.test(kept) ? kept : kept + "?";
}

function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    return a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
function normPronoun(p: unknown): Pronoun {
  return p === "he" || p === "she" ? p : "they";
}

/** Cheap heuristic for the role one rung below, used only if the LLM yields nothing. */
function fallbackSubordinate(title: string): string {
  const t = title.toLowerCase();
  if (/(chief|^c[a-z]o\b|cfo|ceo|coo|cto|cmo|cro|cio)/.test(t)) return "VP" + roleSuffix(t);
  if (/\bvp\b|vice president/.test(t)) return "Director" + roleSuffix(t);
  if (/\bdirector\b/.test(t)) return "Manager" + roleSuffix(t);
  if (/\bhead of\b/.test(t)) return "Manager" + roleSuffix(t);
  return "senior team member";
}
function roleSuffix(t: string): string {
  if (/finance|cfo/.test(t)) return " of Finance";
  if (/sales|revenue|cro/.test(t)) return " of Sales";
  if (/market|cmo/.test(t)) return " of Marketing";
  if (/engineer|cto|technolog/.test(t)) return " of Engineering";
  if (/operation|coo/.test(t)) return " of Operations";
  if (/product/.test(t)) return " of Product";
  if (/people|hr|human/.test(t)) return " of HR";
  return "";
}

/** Safe enrichment when the LLM call fails outright: soft phrasing, no fabrication. */
function softFallback(row: BulkBdRow): BulkBdEnrichment {
  const cand = row.candidate;
  return {
    subordinateRole: str(cand?.role) || fallbackSubordinate(row.title),
    competitor: str(cand?.fromCompany) || "a competitor your size",
    competitorConfidence: cand?.fromCompany ? 1 : 0,
    originCity: str(cand?.currentCity) || "",
    originMiles: null,
    pronoun: normPronoun(cand?.pronoun),
    proofPoint: str(cand?.proofPoint) || undefined,
    nameCompetitor: Boolean(cand?.fromCompany),
    notes: ["enrichment fell back (LLM unavailable)"],
  };
}
