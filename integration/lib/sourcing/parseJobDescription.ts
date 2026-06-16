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

import Anthropic from "@anthropic-ai/sdk";
import type { CandidateICP } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Extraction is cheap work — default to the fast tier; override via env if desired.
const MODEL = process.env.RECRUITEROS_SOURCING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-haiku-4-5-20251001";

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

Rules:
- Expand vague geography into concrete metros (e.g. "East Coast" -> ["New York","Boston","Washington DC","Atlanta","Philadelphia","Charlotte","Miami"]).
- targetCompanies must be REAL companies that employ this exact profile (competitors first, then adjacent). Never invent company names.
- titles should include common variants (VP/RVP/Area VP/Regional Sales Director, etc.).`;

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

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
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
