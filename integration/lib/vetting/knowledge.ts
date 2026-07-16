/**
 * RecruitersOS · AI Vetting · Role FAQ extraction
 *
 * Candidates on a screening call always ask the practical questions: pay range,
 * remote policy, benefits, the interview process, who the company is. An agent
 * that deflects all of them is the loudest "this is a bot" tell there is, so
 * each desk carries a small knowledge base (KnowledgeItem[]) the agent answers
 * from. This pass drafts that FAQ from the job description so the recruiter
 * starts from a filled-in list instead of a blank one.
 *
 * Grounding is absolute: every answer must come from the JD itself. Anything
 * the JD doesn't state is left OUT (the agent's prompt tells it to defer those
 * questions to the recruiter), because an invented comp band or benefits claim
 * on a recorded call is a real liability. Same client/model + STRICT-JSON
 * conventions as qualifiers.ts; degrades to [] when unconfigured.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { KnowledgeItem } from "./types";
import { normalizeKnowledge } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

const SYSTEM = `You are an executive recruiter prepping a phone-screen agent. From a job description, extract the answers to the practical questions candidates actually ask on a first screen: compensation, location/remote policy, benefits, team, the company, the interview process, start timing.

Rules:
- ONLY use facts stated in the job description. If the JD doesn't state it, DO NOT include that question at all. Never estimate, never generalize from the industry.
- Write answers the way a recruiter would SAY them on the phone: short, plain, first person, speakable. No lists, no markdown, no em-dash characters.
- 4 to 8 items. Fewer good items beat padded ones.

Return STRICT JSON only, an array, no prose, no markdown fences:
[ { "question": string, "answer": string } ]`;

function parse(raw: string): KnowledgeItem[] {
  let arr: any;
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return normalizeKnowledge(
    arr.map((k: any, i: number) => ({
      id: `kn_${i}`,
      question: String(k?.question ?? ""),
      answer: String(k?.answer ?? ""),
    })),
  );
}

/**
 * Draft the role FAQ from a job description. Returns [] when the LLM is
 * unconfigured or the JD is empty, so callers can proceed without it.
 */
export async function generateKnowledge(
  jobDescription: string,
  roleTitle?: string,
  clientCompany?: string,
): Promise<KnowledgeItem[]> {
  const jd = (jobDescription || "").trim();
  if (!jd || !process.env.ANTHROPIC_API_KEY) return [];

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [
        {
          role: "user",
          content:
            `Role: ${roleTitle || "(infer from the description)"}${clientCompany ? ` at ${clientCompany}` : ""}\n\n` +
            `Job description:\n"""\n${jd.slice(0, 8000)}\n"""\n\nReturn the FAQ JSON array.`,
        },
      ],
    });
    const block = response.content.find((b) => b.type === "text");
    return parse(block && block.type === "text" ? block.text : "[]");
  } catch {
    return [];
  }
}
