/**
 * RecruitersOS · AI Vetting · Desk auto-fill from a job description
 *
 * One JD in, the whole desk drafted. A single LLM pass pulls the facts the
 * desk form needs that qualifiers.ts and knowledge.ts don't already cover:
 * the spoken role title, the hiring company (only when the JD names one),
 * a short internal desk name, and up to two ROLE-SPECIFIC extraction fields
 * beyond the standard comp/notice/relocation/interest set.
 *
 * Same client/model + STRICT-JSON-with-fallback convention as
 * vetting/qualifiers. Never throws on a bad model response: it degrades to
 * null so the caller can still return whatever qualifiers/knowledge produced.
 */

import Anthropic from "@anthropic-ai/sdk";
import { rid } from "../core/ids";
import type { ExtractionField } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Light extraction work, not heavy reasoning: default to the shared LLM tier.
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/** The desk-form facts one JD pass can fill (everything here may be ""/empty). */
export interface DeskProfile {
  /** Role title the agent speaks on the call, e.g. "VP of Sales". */
  roleTitle: string;
  /** Hiring company, "" when the JD doesn't name one (confidential search). */
  clientCompany: string;
  /** Short internal desk label, e.g. "VP Sales, East". */
  deskName: string;
  /** Extra role-specific facts worth capturing on every call (max 2). */
  extraction: ExtractionField[];
}

const SYSTEM = `You are an elite executive recruiter setting up an AI phone-screen desk from a job description. Extract:

- "roleTitle": the role title the way a recruiter would SAY it on a call (short, natural, e.g. "VP of Sales", not the JD's full requisition string).
- "clientCompany": the hiring company's name ONLY if the JD clearly states it. If it's absent, generic ("our client"), or the search reads confidential, return null.
- "deskName": a short internal label for this desk: role plus location/team/seniority when the JD gives one (e.g. "VP Sales, East", "Sr. Embedded Eng, Austin"). Max ~40 chars.
- "extraction": 0-2 EXTRA role-specific facts worth capturing from every screening call, BEYOND current comp, notice period, relocation, and interest level (those are always captured, never repeat them). Think license/certification held, visa status, shift availability, security clearance, specific tooling years. Each: { "label": string (short, e.g. "CDL class"), "type": "text"|"number"|"boolean"|"enum", "enumOptions": string[] or null (only for "enum") }. Return [] if nothing beyond the standard set is worth asking every candidate.

Return STRICT JSON only, no prose, no markdown fences:
{ "roleTitle": string, "clientCompany": string|null, "deskName": string, "extraction": [ ... ] }`;

function normalizeProfile(raw: string): DeskProfile | null {
  let o: any;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    o = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const types = ["text", "number", "boolean", "enum"];
  const extraction: ExtractionField[] = (Array.isArray(o.extraction) ? o.extraction : [])
    .filter((f: any) => f && typeof f.label === "string" && f.label.trim())
    .slice(0, 2)
    .map((f: any) => {
      const label = String(f.label).trim().slice(0, 60);
      const type = types.includes(f.type) ? f.type : "text";
      const enumOptions = type === "enum" && Array.isArray(f.enumOptions)
        ? f.enumOptions.map((s: any) => String(s).trim()).filter(Boolean).slice(0, 8)
        : undefined;
      return {
        id: rid("xf"),
        key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40),
        label,
        type,
        enumOptions,
      };
    });
  return {
    roleTitle: str(o.roleTitle, 80),
    clientCompany: str(o.clientCompany, 80),
    deskName: str(o.deskName, 60),
    extraction,
  };
}

/**
 * Pull the desk-form facts from a job description. Returns null when the LLM
 * is unconfigured, the JD is empty, or the response can't be read, so the
 * caller can still use whatever the qualifier/FAQ passes produced.
 */
export async function generateDeskProfile(jobDescription: string): Promise<DeskProfile | null> {
  const jd = (jobDescription || "").trim();
  if (!jd || !process.env.ANTHROPIC_API_KEY) return null;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [
        {
          role: "user",
          content: `Job description:\n"""\n${jd.slice(0, 8000)}\n"""\n\nReturn the profile JSON object.`,
        },
      ],
    });
    const block = response.content.find((b) => b.type === "text");
    return normalizeProfile(block && block.type === "text" ? block.text : "");
  } catch {
    return null;
  }
}
