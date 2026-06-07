/**
 * RecruiterOS · AI decision-maker inference
 *
 * Sharpens "who owns this hire" beyond the keyword heuristic: given a company, its
 * industry + size, and its open roles, an LLM infers the exact title(s) a recruiter
 * should contact — handling ambiguous / cross-functional titles and adjusting for company
 * size (founder at a startup vs a line Manager/Director at an enterprise).
 *
 * On-demand only (one cheap call per company the recruiter actually opens — never during
 * bulk accumulation). With no ANTHROPIC_API_KEY it returns null and the caller keeps the
 * heuristic. Mirrors the client/model conventions in lib/sourcing/parseJobDescription.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { classifyTitle, type JobFunction } from "../signals";
import type { HiringManagerLead } from "./index";

const MODEL =
  process.env.RECRUITEROS_DECISIONMAKER_MODEL ??
  process.env.RECRUITEROS_LLM_MODEL ??
  "claude-haiku-4-5-20251001";

const FUNCTIONS: JobFunction[] = [
  "engineering", "product", "design", "data", "sales", "marketing", "finance",
  "operations", "people_hr", "customer_success", "legal", "executive", "other",
];

const SYSTEM = `You identify the exact hiring decision-maker(s) a recruiter should contact for each open role at a specific company.
For EACH role, return the 1-2 titles MOST LIKELY to OWN that hire AT THIS COMPANY — the person who interviews/approves and would actually engage a recruiter.
Adjust for company SIZE: a small startup's owner may be a founder or C-level; a large enterprise's owner is a line Manager or Director, not the VP. Read ambiguous/cross-functional titles (e.g. "Solutions Architect", "Account Manager") in context.
Return STRICT JSON only, no prose:
{ "roles": [ { "role": "<role verbatim>", "managers": [ { "title": "<decision-maker title>", "function": "engineering|product|design|data|sales|marketing|finance|operations|people_hr|customer_success|legal|executive|other", "why": "<<=12 words on why this person owns it>" } ] } ] }
Most direct owner first. One manager for clear cases; two when both a line manager and a senior approver matter.`;

export function aiManagersConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function normFn(fn: unknown, role: string): JobFunction {
  const f = String(fn || "").toLowerCase() as JobFunction;
  return FUNCTIONS.includes(f) ? f : classifyTitle(role).function;
}

/** Infer the owning decision-maker(s) per role via the LLM. Returns null when the key is
 *  absent or anything fails, so callers fall back to the heuristic. */
export async function aiHiringManagers(input: {
  company: string;
  industry?: string;
  headcountBand?: string;
  roles: string[];
}): Promise<HiringManagerLead[] | null> {
  if (!aiManagersConfigured() || !input.company || !input.roles?.length) return null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const roles = input.roles.slice(0, 12); // cap tokens
    const user =
      `Company: ${input.company}\n` +
      `Industry: ${input.industry ?? "unknown"}\n` +
      `Company size: ${input.headcountBand ?? "unknown"}\n` +
      `Open roles:\n${roles.map((r) => `- ${r}`).join("\n")}`;
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("");
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    const json = JSON.parse(text.slice(start, end + 1)) as {
      roles?: Array<{ role?: string; managers?: Array<{ title?: string; function?: string; why?: string }> }>;
    };
    const out: HiringManagerLead[] = [];
    const seen = new Set<string>();
    for (const r of json.roles ?? []) {
      const role = String(r.role || "").trim();
      if (!role) continue;
      for (const m of (r.managers ?? []).slice(0, 2)) {
        const title = String(m.title || "").trim();
        if (!title) continue;
        const k = role.toLowerCase() + "::" + title.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          role,
          function: normFn(m.function, role),
          managerTitle: title,
          why: typeof m.why === "string" && m.why.trim() ? m.why.trim() : undefined,
          ai: true,
        });
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}
