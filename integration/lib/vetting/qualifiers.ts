/**
 * RecruiterOS · AI Vetting · Qualifier extraction
 *
 * The recruiter shouldn't have to hand-write screening questions. Given a job
 * description, one LLM pass pulls the TOP 3-4 things a first phone-screen must
 * confirm — the highest-signal, most disqualifying-if-missing requirements — and
 * returns them in the same shape the desk stores (prompt + passCriteria +
 * mustHave). The agent then works these into the conversation; the scorer judges
 * answers against the same passCriteria.
 *
 * Same client/model + STRICT-JSON-with-fallback convention as
 * sourcing/parseJobDescription. Never throws on a bad model response — it
 * degrades to an empty list so the desk still saves (just without scored
 * qualifiers) when the model is unconfigured or misbehaves.
 */

import Anthropic from "@anthropic-ai/sdk";
import { rid } from "../core/ids";
import type { QualifyingQuestion } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Light judgment (picking the few highest-signal screens), not heavy reasoning —
// default to the shared LLM tier; override via env.
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

const SYSTEM = `You are an elite executive recruiter designing a SHORT phone screen. From a job description, pick the TOP 3-4 things a first call must confirm — the highest-signal requirements that, if missing, most likely disqualify the candidate. Favor concrete, checkable requirements (years of experience, scope/scale owned, specific domain or tooling, leadership span, location/comp ONLY if the JD states them). Avoid vague culture-fluff and avoid more than 4.

For each, return:
- "prompt": the thing to probe, phrased as what the recruiter is trying to learn (short, e.g. "Years owning an individual quota of $5M+").
- "passCriteria": what a PASSING answer looks like, concrete (e.g. "3+ years personally carrying a $5M+ quota, not team/managed").
- "mustHave": true only if failing THIS alone should disqualify the candidate.

Return STRICT JSON only — an array, no prose, no markdown fences:
[ { "prompt": string, "passCriteria": string, "mustHave": boolean } ]

Return 3 or 4 items. If the JD is too thin to infer specifics, return the best general screens you can for the role.`;

function normalize(raw: string): QualifyingQuestion[] {
  let arr: any;
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((q) => q && typeof q.prompt === "string" && q.prompt.trim())
    .slice(0, 4)
    .map((q) => ({
      id: rid("vq"),
      prompt: String(q.prompt).trim().slice(0, 240),
      passCriteria: String(q.passCriteria ?? "").trim().slice(0, 300) || "A clear, credible answer demonstrating this requirement.",
      mustHave: Boolean(q.mustHave),
    }));
}

/**
 * Generate the top 3-4 qualifiers from a job description. Returns [] when the
 * LLM is unconfigured or the JD is empty, so callers can save the desk anyway.
 */
export async function generateQualifiers(
  jobDescription: string,
  roleTitle?: string,
  clientCompany?: string,
): Promise<QualifyingQuestion[]> {
  const jd = (jobDescription || "").trim();
  if (!jd || !process.env.ANTHROPIC_API_KEY) return [];

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [
        {
          role: "user",
          content:
            `Role: ${roleTitle || "(infer from the description)"}${clientCompany ? ` at ${clientCompany}` : ""}\n\n` +
            `Job description:\n"""\n${jd.slice(0, 8000)}\n"""\n\nReturn the qualifier JSON array.`,
        },
      ],
    });
    const block = response.content.find((b) => b.type === "text");
    return normalize(block && block.type === "text" ? block.text : "[]");
  } catch {
    return [];
  }
}
