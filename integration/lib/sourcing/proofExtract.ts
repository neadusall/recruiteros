/**
 * RecruitersOS · JD Sourcing · PROOF EXTRACTION: evidence vocabulary for ANY industry.
 *
 * WHY THIS EXISTS. proofTerms.ts is a hand-written library, and hand-written libraries
 * do not scale past the verticals somebody knew well enough to write down. It covers
 * accounting, finance, behavioral health, healthcare ops and operations because that is
 * what this desk has been staffing. It knows nothing about aviation maintenance, dental
 * practice management, commercial insurance underwriting, semiconductor process
 * engineering, or the several hundred other markets a growing agency will take work in.
 *
 * So the library stops being the definition of evidence and becomes the SEED. For any
 * role, a cheap model call derives the same shape of vocabulary the library holds:
 * the licences, certifications, systems and domain phrases that a qualified person in
 * THAT market actually writes on their profile. Curated terms still win where they
 * exist, because a human who knows the vertical beats a general model on the same
 * question, but their absence is no longer a hole.
 *
 * THE DISCIPLINE THAT MAKES THIS SAFE. A generated term is a guess until it earns its
 * place. Two guards:
 *   1) The prompt demands PROFILE LANGUAGE, not job-description language. A JD says
 *      "must be detail oriented"; a profile says "CPA". Only the second is searchable.
 *      Anything failing isSearchableEvidence is dropped before it can steer a query.
 *   2) Everything generated is provisional, and proofStats.ts measures whether the term
 *      actually shows up on the people we find. A term nobody's profile carries is
 *      demoted out of the query matrix on the evidence of real runs, not opinion.
 *
 * COST. One small-model call per DISTINCT role, cached durably by role signature, so a
 * standing profile sweeping weekly pays for its vocabulary once rather than every sweep.
 * A workspace running a dozen desks pays a dozen calls, ever.
 */

import { anthropicClient } from "./anthropic";
import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";
import type { CandidateICP } from "./types";
import type { ProofTerm, ProofKind } from "./proofTerms";
import { isSearchableEvidence } from "./proofPlan";

const MODEL = process.env.RECRUITEROS_SOURCING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-haiku-4-5";
const KEY = "sourcing_proof_vocab_v1";

/** Cache entries older than this are re-derived: vocabularies drift (new systems ship,
 *  certifications get renamed) but slowly, so a season is the right order of magnitude. */
const STALE_MS = 90 * 24 * 3600_000;

const SYSTEM = `You list the EVIDENCE that proves someone has actually done a job, for recruiting search.

You will be given a role. Return the words and phrases that a genuinely qualified person
writes on their own LinkedIn profile, which an unqualified person would not.

Return STRICT JSON only, no prose:
{"terms":[{"term":"...","aliases":["..."],"kind":"credential|system|domain|scope","weight":1|2|3}]}

WHAT COUNTS (these are searchable, because profiles literally contain them):
- credential: licences, certifications, registrations. CPA, RN, BCBA, PE, CDL, A&P, Series 7,
  CFA, PMP, LEED AP, CPCU, ASE Master, board certifications. Highest value: gate-keeping.
- system: named software, equipment, platforms, tooling. Epic, NetSuite, Yardi, SAP,
  AutoCAD, SolidWorks, Salesforce, Revit, LabWare, Kronos, specific machines or instruments.
- domain: the actual work, named the way practitioners name it. Standards, codes, methods,
  procedures, regulations: "ASC 740", "GD&T", "cGMP", "HACCP", "NEC code", "FAR Part 145",
  "prior authorization", "loss runs", "revenue cycle", "well completions", "clinical trials".
- scope: the shape of the seat that a client is really buying: "multi-site", "P&L ownership",
  "union environment", "Big 4", "high net worth", "Series A to C", "24/7 operation".

WHAT DOES NOT COUNT (never return these):
- Soft skills and character: communication, detail oriented, team player, self starter.
- Generic business words: leadership, management, strategy, results driven, stakeholder.
- Degrees and years: "bachelor's degree", "5+ years experience", "master's preferred".
- Sentences or requirements copied from the job description. You are writing profile
  language, not job-description language. If it reads like a bullet from a JD, drop it.
- Anything so common in the industry that everyone has it and it filters nobody.

RULES:
- 12 to 20 terms. Fewer good ones beats padding.
- Each term 1 to 4 words. Prefer the exact form a practitioner writes.
- aliases: other real spellings of the SAME thing ("Certified Public Accountant" for "CPA",
  "ABA" for "applied behavior analysis"). Not related concepts. Omit if there are none.
- weight 3 = you either hold or have done it, and it separates qualified from not.
  2 = strong specialty evidence. 1 = supporting colour.
- Be specific to THIS role and its industry. A tax role and an audit role have different
  evidence even though both are accounting. If the role is genuinely generic and has no
  distinguishing evidence, return fewer terms, or an empty list. An empty list is a valid
  and useful answer; invented terms are not.`;

interface VocabEntry {
  terms: ProofTerm[];
  derivedAt: string;
  /** Role signature this was derived for, kept for debugging a bad cache hit. */
  label: string;
}

let store: Record<string, VocabEntry> = {};
let hydrated = false;
const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  const snap = await loadSnapshot<Record<string, VocabEntry>>(KEY);
  if (snap && typeof snap === "object") store = snap;
  hydrated = true;
}

/**
 * Stable cache key for a role.
 *
 * Deliberately built from the ROLE rather than the brief's text: two briefs for the same
 * job, written by different recruiters, should share a vocabulary, and re-wording a brief
 * should not silently re-pay for one. Titles and industries are what actually determine
 * the evidence; the location does not.
 */
export function roleSignature(icp: CandidateICP): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
  const titles = (icp.titles || []).slice(0, 4).map(norm).sort();
  const inds = (icp.industries || []).slice(0, 3).map(norm).sort();
  return [norm(icp.label || ""), titles.join("|"), inds.join("|"), icp.seniority || ""].join("::");
}

const KINDS: ProofKind[] = ["credential", "system", "domain", "scope"];

/** Coerce whatever the model returned into terms we are willing to search on. */
export function normalizeExtracted(raw: string): ProofTerm[] {
  let parsed: any;
  try {
    // Models occasionally wrap JSON in a fence despite instructions.
    const cleaned = String(raw || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.terms) ? parsed.terms : [];
  const out: ProofTerm[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    const term = String(t?.term ?? "").trim();
    if (!term) continue;
    // The same filter the JD-side terms pass. A generated term gets no special trust:
    // this is what keeps "strong analytical skills" out of an X-ray boolean.
    if (!isSearchableEvidence(term)) continue;
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const kind: ProofKind = KINDS.includes(t?.kind) ? t.kind : "domain";
    const w = Number(t?.weight);
    const weight = (w === 1 || w === 2 || w === 3 ? w : 2) as 1 | 2 | 3;
    const aliases = Array.isArray(t?.aliases)
      ? t.aliases.map((a: any) => String(a ?? "").trim()).filter((a: string) => a && a.length <= 42).slice(0, 4)
      : undefined;
    // Short all-caps generated terms get the strict matcher, same as the curated ones:
    // an invented two-letter acronym is exactly the shape that false-positives on prose.
    const strict = /^[A-Z0-9&/.-]{2,5}$/.test(term) || undefined;
    out.push({ term, aliases: aliases?.length ? aliases : undefined, kind, weight, strict });
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * The evidence vocabulary for a role, from cache when we have it.
 *
 * NEVER THROWS. Discovery must run with or without a vocabulary: an unconfigured API key,
 * a model hiccup or a malformed response all degrade to an empty list, which puts the run
 * back on curated-library-plus-JD terms, which is exactly where it was before this file
 * existed. Sourcing failing because a nice-to-have enrichment failed would be a bad trade.
 */
export async function extractProofTerms(
  icp: CandidateICP,
  jd = "",
  opts: { force?: boolean } = {},
): Promise<ProofTerm[]> {
  await hydrate();
  const sig = roleSignature(icp);
  const hit = store[sig];
  if (!opts.force && hit) {
    const age = Date.now() - new Date(hit.derivedAt).getTime();
    if (!Number.isFinite(age) || age < STALE_MS) return hit.terms;
  }
  if (!process.env.ANTHROPIC_API_KEY) return hit?.terms ?? [];

  let terms: ProofTerm[] = [];
  try {
    const roleBlock = [
      `Role: ${icp.label || (icp.titles || [])[0] || "unspecified"}`,
      (icp.titles || []).length ? `Titles: ${(icp.titles || []).slice(0, 8).join(", ")}` : "",
      (icp.industries || []).length ? `Industry: ${(icp.industries || []).slice(0, 4).join(", ")}` : "",
      `Seniority: ${icp.seniority || "unspecified"}`,
      (icp.mustHave || []).length ? `Stated requirements: ${(icp.mustHave || []).slice(0, 8).join(", ")}` : "",
      jd ? `\nJob description (for industry context only, do not copy its wording):\n"""\n${jd.slice(0, 3000)}\n"""` : "",
    ].filter(Boolean).join("\n");

    const response = await anthropicClient().messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [{ role: "user", content: `${roleBlock}\n\nReturn the evidence JSON.` }],
    });
    const block = response.content.find((b) => b.type === "text");
    terms = normalizeExtracted(block && block.type === "text" ? block.text : "");
  } catch {
    // Keep whatever we had rather than caching a failure as an empty vocabulary.
    return hit?.terms ?? [];
  }

  // An empty derivation is a legitimate answer for a genuinely generic role, but it is
  // also what a quietly broken model call looks like, so it is never cached over a
  // vocabulary that previously worked.
  if (!terms.length && hit?.terms?.length) return hit.terms;

  store[sig] = { terms, derivedAt: nowIso(), label: icp.label || "" };
  save();
  return terms;
}
