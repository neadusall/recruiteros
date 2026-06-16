/**
 * RecruitersOS · JD Sourcing
 * "Dive deeper" — refine a search with a natural-language instruction.
 *
 * The recruiter types something like "only Director+ who sold into manufacturing,
 * exclude agencies" and the LLM edits the existing CandidateICP accordingly — keeping
 * everything it shouldn't touch — then we regenerate the search set from the new ICP.
 * One model call; the same cheap extraction tier as the JD parser.
 */

import { anthropicClient } from "./anthropic";
import type { CandidateICP } from "./types";
import { normalizeIcpObject } from "./parseJobDescription";

const MODEL = process.env.RECRUITEROS_SOURCING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-haiku-4-5";

const SYSTEM = `You refine an existing ideal-CANDIDATE profile (ICP) used for sourcing, applying the
recruiter's instruction. Keep the EXACT same JSON field shape. Change only what the instruction
implies — keep every other field as-is. Expand vague geography into concrete metros. Never invent
fake company names. Return STRICT JSON only, no prose:

{
  "icp": {
    "label": string, "seniority": "ic"|"manager"|"director"|"vp"|"exec", "managesTeam": boolean,
    "titles": string[], "geos": string[], "remoteOk": boolean, "industries": string[],
    "targetCompanies": string[], "sellsTo": string[], "verticals": string[],
    "mustHave": string[], "niceToHave": string[], "disqualifiers": string[]
  },
  "changes": string   // one short sentence describing what you adjusted
}`;

export interface RefineResult {
  icp: CandidateICP;
  changes: string;
}

/** Apply a natural-language refinement to an ICP. Throws only if the client is unconfigured. */
export async function refineIcp(jd: string, current: CandidateICP, instruction: string): Promise<RefineResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const response = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: 1400,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content:
          `Current ICP:\n"""\n${JSON.stringify(current)}\n"""\n\n` +
          (jd ? `Job description (context):\n"""\n${(jd || "").slice(0, 6000)}\n"""\n\n` : "") +
          `Recruiter's refinement instruction:\n"""\n${(instruction || "").slice(0, 1000)}\n"""\n\n` +
          `Return the refined { icp, changes } JSON.`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "{}";
  try {
    const o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      icp: normalizeIcpObject(o.icp ?? o),
      changes: String(o.changes || "Search refined.").slice(0, 240),
    };
  } catch {
    // Couldn't parse — keep the current ICP rather than dropping the recruiter's work.
    return { icp: current, changes: "Could not apply the refinement — left the profile unchanged." };
  }
}
