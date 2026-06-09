/**
 * RecruiterOS · BD · MPC (Most Placeable Candidate) messaging
 *
 * The forward model in the A/B test. Where personaMessaging earns a conversation
 * with advisory insight, this one LEADS WITH THE ASSET: a specific, high-caliber
 * candidate we represent who would excel in the executive's likely open role. It
 * is more direct and more convincing because we have qualified people ready to
 * move — and it creates honest momentum (good people in motion don't stay long).
 *
 * Same 12-field output as personaMessaging (so the rest of the pipeline is
 * model-agnostic), reusing the same persona/industry/trigger framework.
 *
 * TRUTH IS NON-NEGOTIABLE (inherited house rule): never fabricate a candidate, a
 * name, a metric, a client, an outcome, or a competing offer. When a real
 * anonymized candidate profile is provided, write only from it; when none is
 * provided, speak truthfully and generally about the talent we represent in their
 * market — never invent a specific person.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  PERSONAS, INDUSTRY_INTEL, BUSINESS_TRIGGERS, CHANNEL_LIMITS,
  type Persona, type Industry, type BusinessTrigger, type BdLead, type PersonaMessage,
} from "./personaMessaging";
import { sanitizeMessage } from "./sanitize";
import { HOUSE_VOICE } from "./houseVoice";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/** MPC leads may carry a REAL, anonymized candidate to lead with. */
export interface MpcLead extends BdLead {
  /** Anonymized true profile of a candidate we represent (title, strengths, why
   *  they're exploring, availability). Omit if none — the model stays general. */
  candidate?: string;
}

function personaTable(): string {
  return (Object.keys(PERSONAS) as Persona[])
    .map((k) => { const p = PERSONAS[k]; return `- ${p.label} (${k}) | pressures: ${p.pressures.join(", ")} | wants: ${p.outcomes.join(", ")}`; })
    .join("\n");
}
function industryTable(): string {
  return (Object.keys(INDUSTRY_INTEL) as Industry[])
    .map((k) => { const i = INDUSTRY_INTEL[k]; return `- ${i.label} (${k}) | themes: ${i.themes.join(", ")}`; })
    .join("\n");
}

const SYSTEM = `You generate business-development outreach for an expert recruiting firm (Ryan / Lume) using the MOST PLACEABLE CANDIDATE (MPC) method. The objective is to start a conversation by leading with a specific, high-caliber candidate we represent who would excel in the executive's likely open roles. This is the forward, confident model: we have qualified people ready to move, and we lead with that.

YOU SOUND LIKE: a well-connected recruiter who genuinely has an exceptional person to introduce — confident, concise, respectful of their time.
YOU NEVER SOUND LIKE: a mass-blast staffing agency, a desperate salesperson, or hype.

THE MPC MOVE:
- Lead with the candidate as the reason for reaching out: a strong [function/level] professional, currently open to the right move, whose background fits what [company] is likely building.
- Tie the candidate to the executive's specific situation: their hiring signal, their industry, the pressure behind the role.
- Create honest momentum: strong people in motion don't stay available long, so a quick look makes sense now. You may note timing matters; you may NOT invent deadlines, competing offers, or scarcity.
- Make the ask low-friction: a short call to walk the profile, or offer to send a one-page summary.

ABSOLUTE TRUTH RULES (non-negotiable):
- NEVER fabricate a candidate, a name, a number, a metric, a client, an outcome, or a competing offer.
- If an anonymized candidate profile is PROVIDED below, write only from those true details; keep it anonymized (no name).
- If NO candidate profile is provided, speak truthfully and generally — that we are currently representing strong [function] talent in their market who may fit — WITHOUT inventing a specific person or specific achievements.
- Anchor the executive's situation only in the real signal / role / industry / profile provided. Never invent their facts either.

EXECUTIVE DECISION FRAMEWORK — write under the persona's pressure, toward their desired outcome. Generalize to ANY title with real depth:
${personaTable()}

INDUSTRY INTELLIGENCE — reason from the sector's real themes; generalize to ANY industry:
${industryTable()}

BUSINESS TRIGGERS — classify the hiring signal into one or more of: ${BUSINESS_TRIGGERS.join(", ")}.

CHANNEL RULES (lead with the candidate, end with a low-friction ask):
- email: 60-110 words. Open with the candidate-and-fit, one line on why them for this company, then the ask (short call or send the summary). Quiet, specific subject — never hype.
- linkedin_connection: <= 250 characters. The candidate-and-fit hook + a soft ask.
- linkedin_message: 300-500 characters. Candidate, why-fit, ask.
- linkedin_voice_note: 20-35s spoken script (~50-90 words). Warm, confident, candidate-led.
- voicemail: 20-25s spoken script (~50-65 words). Candidate, why-fit, the ask, then the callback number.

HARD STYLE RULES: plain text only; no emojis, no hashtags; NO dashes of any kind (no em dashes, no en dashes, no hyphens) — write compounds as separate words; US dollars with $; reference only real, provided details; the reader should feel "this person has someone I should actually meet," never "this is a mass pitch."

${HOUSE_VOICE}`;

function leadBrief(lead: MpcLead): string {
  const first = lead.firstName ?? lead.fullName?.split(/\s+/)[0];
  return [
    lead.fullName ? `Executive: ${lead.fullName}${first ? ` (first name: ${first})` : ""}` : null,
    lead.title ? `Title: ${lead.title}` : null,
    lead.company ? `Company: ${lead.company}` : null,
    lead.industry ? `Industry (given): ${INDUSTRY_INTEL[lead.industry as Industry]?.label ?? String(lead.industry)} (generalize to the same depth if outside the list)` : "Industry: infer from title and company, echo it back",
    lead.hiringActivity ? `Observed hiring activity (REAL symptom): ${lead.hiringActivity}` : "Observed hiring activity: (none provided - do not invent one)",
    lead.companyContext ? `Other true context: ${lead.companyContext}` : null,
    lead.profileSummary ? `Executive's background (REAL): ${lead.profileSummary}` : null,
    lead.candidate ? `CANDIDATE TO LEAD WITH (REAL, anonymized — use only these facts): ${lead.candidate}` : "Candidate: (none provided - speak truthfully and generally about the talent we represent in their market; do NOT invent a specific person)",
    `Sender (signoffs): ${lead.sender ?? "the Lume team"}`,
    `Callback number (voicemail close): ${lead.callbackNumber ?? "{{callbackNumber}}"}`,
  ].filter(Boolean).join("\n");
}

export async function generateMpcMessage(lead: MpcLead): Promise<PersonaMessage> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content:
          `Generate the MPC outreach package for this lead.\n\nLEAD:\n${leadBrief(lead)}\n\n` +
          `Respond as strict JSON with exactly these keys and no prose outside the JSON:\n` +
          `{ "industry": string, "persona": string, "business_trigger": string[], "executive_pressure": string, ` +
          `"likely_business_problem": string, "market_observation": string, "email": { "subject": string, "body": string }, ` +
          `"linkedin_connection": string, "linkedin_message": string, "linkedin_voice_note": string, "voicemail": string, "confidence_score": number }`,
      },
    ],
  });

  const raw = response.content.find((b) => b.type === "text");
  const text = raw && raw.type === "text" ? raw.text : "{}";
  return sanitizeMessage(normalize(safeJson(text)));
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    return a >= 0 ? JSON.parse(s.slice(a, b + 1)) : {};
  } catch {
    return {};
  }
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function clampChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}
function normalize(o: Record<string, unknown>): PersonaMessage {
  const triggers = Array.isArray(o.business_trigger)
    ? (o.business_trigger as unknown[]).map(String).filter((t): t is BusinessTrigger => (BUSINESS_TRIGGERS as readonly string[]).includes(t))
    : [];
  const email = (o.email ?? {}) as Record<string, unknown>;
  const score = Number(o.confidence_score);
  return {
    industry: str(o.industry),
    persona: str(o.persona),
    business_trigger: triggers,
    executive_pressure: str(o.executive_pressure),
    likely_business_problem: str(o.likely_business_problem),
    market_observation: str(o.market_observation),
    email: { subject: str(email.subject), body: str(email.body) },
    linkedin_connection: clampChars(str(o.linkedin_connection), CHANNEL_LIMITS.linkedinConnectionChars),
    linkedin_message: clampChars(str(o.linkedin_message), CHANNEL_LIMITS.linkedinMessageChars.max),
    linkedin_voice_note: str(o.linkedin_voice_note),
    voicemail: str(o.voicemail),
    confidence_score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
  };
}
