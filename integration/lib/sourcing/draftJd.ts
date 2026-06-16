/**
 * RecruitersOS · JD Sourcing
 * JD builder — turn a title + company (+ optional notes) into a tight, sourcing-
 * optimized brief the recruiter can drop straight into the JD box.
 *
 * The brief is written for the DOWNSTREAM ICP extractor, not for a careers page: it
 * deliberately spells out the exact title/level, real peer companies to source from,
 * geography, domain, must-haves, buyer personas, deal-breakers, and proof-of-impact —
 * the inputs that make the search sharp. One generative call (default Sonnet tier).
 */

import { anthropicClient } from "./anthropic";

const MODEL = process.env.RECRUITEROS_DRAFT_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

const SYSTEM = `You are an expert recruiter writing a concise, sourcing-optimized hiring brief — NOT a
public job ad. A candidate-sourcing engine will parse your output to build an ideal-candidate
profile and find/rank people, so be explicit and specific.

Cover, naturally and tightly (a few short paragraphs or compact bullets):
- The exact role title and seniority (IC / manager / director / VP / exec), and whether it manages a team.
- 5-10 REAL competitor or peer companies whose people would be ideal to source from. Use real, well-known
  companies in this exact space; NEVER invent company names. If unsure of competitors, name adjacent real ones.
- Target locations / metros (expand vague geography to real metros), or state remote. If a search
  radius is given with the location (e.g. "within ~50 miles"), list EVERY metro/city within roughly
  that estimated driving distance, not just the named city — wider radius means more metros.
- The industry / domain that strong candidates come from.
- Must-have experience and skills — what they've actually DONE, not nice-to-haves.
- Required skills, tools, certifications, and licenses for THIS role (role-appropriate, e.g. RN license,
  CPA, PE, AWS, Epic/EHR, Salesforce, specific machinery or software). High-signal across any field.
- Seniority and scope — years of relevant experience, and the size of team or budget/P&L they have owned.
- Who they sell to / buyer personas — ONLY if it's a sales or GTM role; omit otherwise.
- Deal-breakers — traits or backgrounds that should disqualify a candidate.
- Proof-of-impact signals to match on — measurable results appropriate to the role (outcomes, scale, growth,
  revenue, patient/customer/quality metrics, projects delivered, team or budget size). Not just sales quota.

Cast a sensible WIDE net — recall matters because people rarely put everything on LinkedIn:
- List adjacent and variant titles, not just the literal one (e.g. for "VP Sales" also CRO, RVP,
  Area VP, Regional Sales Director, Head of Sales, Sales Director).
- Name a broad set of real peer companies (competitors AND adjacent ones), not just the obvious 2-3.
- Keep deal-breakers MINIMAL and only truly disqualifying — a thin profile is not a deal-breaker;
  over-tight rules cut strong people whose LinkedIn just doesn't spell everything out.
- Frame must-haves as the core signal, knowing some qualified people won't list every detail.

If the recruiter provides EXISTING MATERIAL (a rough JD, notes, or a prior brief), treat it as the
FOUNDATION — do not start from scratch. Keep their real specifics (named companies, locations,
titles, requirements, metrics), then strengthen, complete the gaps, and widen the net. Never discard
their details or contradict them.

Infer sensibly from the company and title. Prefer specific over generic, but favor recall over a
narrow net. Do NOT include salary, benefits, EEO/legal boilerplate, or application instructions.
Output plain text only — no markdown headings, no preamble such as "Here is" — just the brief, ready to paste.`;

export interface DraftInput {
  title?: string;
  company?: string;
  companyUrl?: string;
  notes?: string;
  /** Existing material to strengthen — a rough JD or prior brief the recruiter already has. */
  base?: string;
}

/** Generate/strengthen a sourcing-ready JD brief. Throws only if the model client is unconfigured. */
export async function draftJobDescription(input: DraftInput): Promise<string> {
  const title = (input.title || "").trim();
  const base = (input.base || "").trim();
  if (!title && !base) return "";
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const company = [input.company, input.companyUrl].map((x) => (x || "").trim()).filter(Boolean).join(" · ");
  const lines = [
    title ? `Role title: ${title}` : "",
    company ? `Hiring company: ${company}` : "",
    input.notes && input.notes.trim() ? `Extra notes from the recruiter: ${input.notes.trim().slice(0, 800)}` : "",
    base ? `Existing material to strengthen (keep its real specifics, fill the gaps, widen the net):\n"""\n${base.slice(0, 8000)}\n"""` : "",
    "",
    base ? "Strengthen the existing material into a tight sourcing brief." : "Write the sourcing brief.",
  ].filter(Boolean);

  const response = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{ role: "user", content: lines.join("\n") }],
  });
  const block = response.content.find((b) => b.type === "text");
  return (block && block.type === "text" ? block.text : "").trim();
}
