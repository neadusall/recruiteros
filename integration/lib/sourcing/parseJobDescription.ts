/**
 * RecruitersOS · JD Sourcing
 * Parse a job description into a structured CandidateICP via the LLM.
 *
 * One cheap model call per JD (a JD is a few thousand tokens). We deliberately use a
 * small model — this is extraction, not reasoning — and normalize the output so a
 * malformed response degrades to a usable ICP rather than throwing.
 *
 * Mirrors the client/model conventions already used in linkedin/classify.ts.
 */

import { anthropicClient } from "./anthropic";
import type { CandidateICP } from "./types";

// Extraction is cheap work — default to the fast tier; override via env if desired.
const MODEL = process.env.RECRUITEROS_SOURCING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-haiku-4-5";

const SYSTEM = `You turn a job description into a structured ideal-CANDIDATE profile for sourcing
people who would be a great fit to HIRE for this role (not customers). Infer sensibly from
the role even when the JD is terse. Return STRICT JSON only, no prose.

Shape:
{
  "label": string,                       // e.g. "VP Sales — Source-to-Pay (East Coast)"
  "seniority": "ic"|"manager"|"director"|"vp"|"exec",
  "managesTeam": boolean,                // true if the role implies leading a team
  "titles": string[],                    // candidate titles to search, most-specific first
  "geos": string[],                      // metros/regions to source from (expand "East Coast" to metros)
  "remoteOk": boolean,
  "industries": string[],                // domains the ideal candidate comes from
  "targetCompanies": string[],           // 10-30 REAL named competitors + adjacent companies to poach from
  "sellsTo": string[],                   // buyer personas (e.g. CFO, CPO) if a sales role
  "verticals": string[],                 // industry verticals to weight
  "mustHave": string[],                  // hard requirements / strong signals
  "niceToHave": string[],
  "disqualifiers": string[]              // traits that should drop a candidate
}

PRIME DIRECTIVE — CAST A WIDE NET. This profile drives a live search; an over-tight profile finds
NOBODY. Strongly favor RECALL over precision. People rarely spell everything out on LinkedIn, so a
qualified person will often be missing a keyword. When unsure, INCLUDE rather than exclude. It is far
better to surface 500 plausible people the recruiter can skim than 5 "perfect" ones.

Rules:
- titles: be EXPANSIVE. Include the literal title PLUS a generous set of adjacent, variant, senior, and
  junior-adjacent titles people actually use (e.g. for "VP Sales" also CRO, Chief Revenue Officer, SVP/RVP/
  Area VP, Regional Sales Director, Head of Sales, Sales Director, National Sales Manager, GM). Aim for
  10-20 title strings. More titles = more candidates found.
- disqualifiers: LEAVE THIS EMPTY ([]) by default. A disqualifier removes a person from the results entirely,
  so only add one if the recruiter EXPLICITLY stated a hard deal-breaker (e.g. "must not be from an agency").
  NEVER infer disqualifiers from the role. When in doubt, no disqualifier.
- mustHave: keep this SHORT — at most 3 truly non-negotiable items (e.g. a required license like RN/CPA, or
  a legally required credential). Everything else — preferred skills, tools, years, seniority, impact metrics —
  goes in niceToHave. mustHave is weighted heavily, so a long list silently filters out strong people.
- niceToHave: this is where breadth lives — put the role's skills, tools, certifications (RN, CPA, PE, AWS,
  Epic/EHR, Salesforce), seniority/scope, and measurable-impact signals here. These boost ranking without
  excluding anyone.
- Expand vague geography into concrete metros (e.g. "East Coast" -> ["New York","Boston","Washington DC","Atlanta","Philadelphia","Charlotte","Miami"]).
- If a location is given with a search radius (e.g. "within ~50 miles of Fair Lawn, NJ"), expand geos to EVERY metro, city, and town within roughly that estimated driving distance — the realistic commute/relocation range — not just the named city. Be generous and specific (e.g. for ~50mi of Fair Lawn, NJ include Newark, Jersey City, Paterson, New York, Yonkers, White Plains, Stamford, Edison, etc.). Larger radius = more metros. Set remoteOk true unless the role is clearly on-site only.
- targetCompanies must be REAL companies that employ this profile (competitors first, then a broad set of adjacent ones). Aim for 15-30. Never invent company names.
- sellsTo applies only to sales / GTM roles; leave it empty otherwise.`;

const FALLBACK: CandidateICP = {
  label: "Sourcing profile",
  seniority: "director",
  managesTeam: false,
  titles: [],
  geos: [],
  remoteOk: true,
  industries: [],
  targetCompanies: [],
  sellsTo: [],
  verticals: [],
  mustHave: [],
  niceToHave: [],
  disqualifiers: [],
};

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 40);
}

/** Coerce a parsed object into a clean CandidateICP (shared by parse + refine). */
export function normalizeIcpObject(o: any): CandidateICP {
  if (!o || typeof o !== "object") return FALLBACK;
  const seniority = ["ic", "manager", "director", "vp", "exec"].includes(o.seniority) ? o.seniority : "director";
  return {
    label: String(o.label || FALLBACK.label).slice(0, 120),
    seniority,
    managesTeam: Boolean(o.managesTeam),
    titles: strArr(o.titles),
    geos: strArr(o.geos),
    remoteOk: o.remoteOk === undefined ? true : Boolean(o.remoteOk),
    industries: strArr(o.industries),
    targetCompanies: strArr(o.targetCompanies),
    sellsTo: strArr(o.sellsTo),
    verticals: strArr(o.verticals),
    mustHave: strArr(o.mustHave),
    niceToHave: strArr(o.niceToHave),
    disqualifiers: strArr(o.disqualifiers),
  };
}

function normalize(raw: string): CandidateICP {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return normalizeIcpObject(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return FALLBACK;
  }
}

/**
 * Parse a raw job description into a CandidateICP. Throws only when the model
 * client itself is unconfigured (no API key) so the caller can surface a clean
 * setup hint; a malformed model response degrades to a usable fallback ICP.
 */
export async function parseJobDescription(jd: string): Promise<CandidateICP> {
  const text = (jd || "").trim();
  if (!text) return FALLBACK;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }

  const response = await anthropicClient().messages.create({
    model: MODEL,
    // Generous ceiling: the JSON carries up to ~30 target companies plus radius-
    // expanded metros, and a truncated array makes JSON.parse fail -> empty fallback.
    max_tokens: 2600,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content: `Job description:\n"""\n${text.slice(0, 12000)}\n"""\n\nReturn the CandidateICP JSON.`,
      },
    ],
  });

  const block = response.content.find((b) => b.type === "text");
  return normalize(block && block.type === "text" ? block.text : "{}");
}
