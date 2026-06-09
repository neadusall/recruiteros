/**
 * RecruiterOS · BD Persona Messaging
 * Persona- and trigger-grounded business-development outreach generation.
 *
 * This is the BD-side companion to the rapport-rung drafter in ../linkedin/personalize.
 * Where that engine writes one channel touch at a time on a recognize->pitch ladder, this
 * engine takes a single executive lead and emits the FULL multi-channel package at once,
 * reasoned from the Persona-Based Messaging framework rather than from a job posting.
 *
 * The governing idea (Bernays' "interest coincidence", see docs/playbooks/copywriting-playbook.md):
 * a job posting is a SYMPTOM; the executive's business problem is the CAUSE. We never sell
 * recruiting. We open intelligent conversations by demonstrating that we understand what the
 * executive is likely trying to accomplish, then we get out of the way with a single question.
 *
 * Output is strict JSON (the 12 framework fields) so the generation layer can persist it and
 * the approval queue can render it without parsing prose. The model does the reasoning; the
 * taxonomies below are injected (cached) so it reasons inside the house framework.
 *
 * Ethics line (non-negotiable, inherited from the copywriting playbook): every persuasive move
 * is anchored to a REAL observed fact and a TRUE claim. We never fabricate statistics, client
 * outcomes, or people. The market observation must be defensible from the lead we were given.
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/* ------------------------------------------------------------------ */
/* Taxonomies (the framework, as data)                                 */
/* ------------------------------------------------------------------ */

/** The executive personas we write to, each with the five decision elements. */
export type Persona =
  | "ceo"
  | "coo"
  | "cfo"
  | "managing_partner"
  | "cro"
  | "head_of_people";

interface PersonaProfile {
  label: string;
  identity: string;
  pressures: string[];   // the hidden pressures the message must speak under
  outcomes: string[];    // the desired outcomes to align with (interest coincidence)
  themes: string[];      // natural conversation openers for this persona
}

export const PERSONAS: Record<Persona, PersonaProfile> = {
  ceo: {
    label: "CEO",
    identity: "Builder",
    pressures: ["scaling too quickly", "leadership gaps", "poor execution", "retention of key leaders", "market competition"],
    outcomes: ["predictable growth", "a strong leadership bench", "operational maturity", "sustainable scale"],
    themes: ["leadership scale", "future growth", "execution capacity", "building the next layer of leadership"],
  },
  coo: {
    label: "COO",
    identity: "Operator",
    pressures: ["capacity constraints", "operational bottlenecks", "execution failures", "leadership depth"],
    outcomes: ["efficiency", "consistency", "scalable systems"],
    themes: ["execution", "process maturity", "operational leadership", "capacity planning"],
  },
  cfo: {
    label: "CFO",
    identity: "Risk Manager",
    pressures: ["forecast accuracy", "budget pressure", "compliance", "resource allocation"],
    outcomes: ["financial predictability", "reduced risk", "strong financial controls"],
    themes: ["financial leadership", "risk mitigation", "organizational efficiency", "scalable finance functions"],
  },
  managing_partner: {
    label: "Managing Partner",
    identity: "Steward",
    pressures: ["partner succession", "client transition", "talent retention", "future firm leadership"],
    outcomes: ["long-term firm health", "future partners", "client continuity"],
    themes: ["succession", "future leaders", "retention", "institutional knowledge"],
  },
  cro: {
    label: "CRO",
    identity: "Revenue Architect",
    pressures: ["quota attainment", "revenue predictability", "leadership quality", "pipeline performance"],
    outcomes: ["revenue growth", "predictable outcomes", "strong sales leadership"],
    themes: ["sales leadership", "growth readiness", "revenue execution", "leadership effectiveness"],
  },
  head_of_people: {
    label: "Head of People",
    identity: "Talent Architect",
    pressures: ["retention", "hiring velocity", "employer brand", "quality of hire"],
    outcomes: ["better talent outcomes", "reduced turnover", "improved hiring processes"],
    themes: ["talent strategy", "hiring effectiveness", "retention", "workforce planning"],
  },
};

/** Industry market context the model should reason from when the industry is known. */
export type Industry =
  | "accounting"
  | "banking"
  | "fintech"
  | "saas"
  | "legal"
  | "insurance";

interface IndustryProfile {
  label: string;
  themes: string[];          // current market themes
  conversations: string[];   // the executive conversations a peer would naturally start
}

export const INDUSTRY_INTEL: Record<Industry, IndustryProfile> = {
  accounting: {
    label: "Accounting",
    themes: ["aging partner population", "manager shortages", "partner succession concerns", "tax leadership shortages", "busy-season strain", "retention challenges"],
    conversations: ["Who becomes partner next?", "How do we retain future leaders?", "How do we protect client relationships?"],
  },
  banking: {
    label: "Banking",
    themes: ["commercial lender shortages", "deposit growth pressure", "market expansion", "leadership transition", "credit talent scarcity"],
    conversations: ["How do we grow deposits?", "How do we replace experienced lenders?", "How do we expand without weakening culture?"],
  },
  fintech: {
    label: "Fintech",
    themes: ["growth-stage leadership", "fundraising pressure", "compliance requirements", "product delivery speed", "revenue acceleration"],
    conversations: ["Can our leadership team support our growth stage?", "Can we scale without creating operational risk?"],
  },
  saas: {
    label: "SaaS",
    themes: ["enterprise sales hiring", "customer retention", "revenue efficiency", "product leadership", "go-to-market maturity"],
    conversations: ["Can our team support the next growth phase?", "Where are we missing leadership depth?"],
  },
  legal: {
    label: "Legal",
    themes: ["partner succession", "associate retention", "practice expansion", "client ownership transition"],
    conversations: ["Who inherits key client relationships?", "How do we build future rainmakers?"],
  },
  insurance: {
    label: "Insurance",
    themes: ["producer recruiting", "leadership succession", "claims leadership shortages", "underwriting talent shortages"],
    conversations: ["How do we maintain growth while experienced producers retire?"],
  },
};

/** The business triggers a hiring signal classifies into. The model may emit one or more. */
export const BUSINESS_TRIGGERS = [
  "growth",
  "expansion",
  "succession",
  "capacity_constraints",
  "transformation",
  "leadership_gap",
  "revenue_expansion",
  "private_equity_initiative",
  "m_and_a_activity",
  "digital_transformation",
  "ai_transformation",
  "compliance_pressure",
  "operational_scale",
] as const;
export type BusinessTrigger = (typeof BUSINESS_TRIGGERS)[number];

/* ------------------------------------------------------------------ */
/* Channel envelope (hard limits the output is clamped to)             */
/* ------------------------------------------------------------------ */

/** Hard envelope per channel, from the framework. Text channels are character-bounded;
 *  spoken channels are second-bounded (we approximate with a word budget at ~2.5 wps). */
export const CHANNEL_LIMITS = {
  emailWords: { min: 50, max: 100 },
  linkedinConnectionChars: 250,
  linkedinMessageChars: { min: 300, max: 500 },
  voiceNoteSeconds: { min: 20, max: 35 },   // ~50-90 words
  voicemailSeconds: { min: 20, max: 25 },   // ~50-65 words
} as const;

/* ------------------------------------------------------------------ */
/* IO types                                                            */
/* ------------------------------------------------------------------ */

/** The lead we are writing to. Industry/persona are optional and NOT limited to the
 *  curated tables: pass any industry string or any job title and the model reasons to
 *  the same depth, inferring the persona/industry and echoing its inference back. */
export interface BdLead {
  fullName?: string;
  firstName?: string;
  title?: string;
  company?: string;
  /** A curated industry key OR any free-text industry; the model generalizes. */
  industry?: Industry | (string & {});
  /** A curated persona key OR left empty; the model infers from the exact title. */
  persona?: Persona | (string & {});
  /** The observed, REAL hiring activity or event that surfaced this lead (the symptom).
   *  e.g. "posted a Tax Director and two Senior Manager roles in the last 30 days". */
  hiringActivity?: string;
  /** Optional extra true context: stage, headcount, recent funding/news, location. */
  companyContext?: string;
  /** The prospect's own background, in their words: headline, recent roles, tenure,
   *  specialties — pulled from their profile. Grounds the message in THEIR experience
   *  and lets the model speak their exact role + industry vocabulary. Raises confidence. */
  profileSummary?: string;
  /** Sender name for spoken-channel signoffs and the callback line. */
  sender?: string;
  /** Callback number for the voicemail close. Omitted -> the model uses a placeholder token. */
  callbackNumber?: string;
}

/** The 12 framework output fields. `email` is structured into subject + body so the cadence
 *  push can carry them as the custom variables it already expects; every other channel is a
 *  single ready-to-send string. */
export interface PersonaMessage {
  industry: string;
  persona: string;
  business_trigger: BusinessTrigger[];
  executive_pressure: string;
  likely_business_problem: string;
  market_observation: string;
  email: { subject: string; body: string };
  linkedin_connection: string;
  linkedin_message: string;
  linkedin_voice_note: string;
  voicemail: string;
  /** Model's self-rated confidence that the reasoning is grounded and the message will land, 0-1. */
  confidence_score: number;
}

/* ------------------------------------------------------------------ */
/* System prompt (static, cached)                                      */
/* ------------------------------------------------------------------ */

function renderPersonaTable(): string {
  return (Object.keys(PERSONAS) as Persona[]).map((k) => {
    const p = PERSONAS[k];
    return `- ${p.label} (${k}) | identity: ${p.identity} | pressures: ${p.pressures.join(", ")} | wants: ${p.outcomes.join(", ")} | themes: ${p.themes.join(", ")}`;
  }).join("\n");
}

function renderIndustryTable(): string {
  return (Object.keys(INDUSTRY_INTEL) as Industry[]).map((k) => {
    const i = INDUSTRY_INTEL[k];
    return `- ${i.label} (${k}) | themes: ${i.themes.join(", ")} | natural questions: ${i.conversations.join(" / ")}`;
  }).join("\n");
}

/** All static guidance lives here so the API caches it and we don't pay for it per lead. */
const SYSTEM = `You generate business-development outreach for an expert recruiting firm (Ryan / Lume). The objective is NOT to sell recruiting services. The objective is to start an intelligent conversation with an executive by demonstrating that you understand their industry, their role, their company's likely objectives, and the business problem behind their hiring.

YOU SOUND LIKE: an industry advisor, a market observer, an executive peer, a talent strategist.
YOU NEVER SOUND LIKE: a recruiter, a staffing agency, a salesperson, or a generic AI system.

CORE PRINCIPLE — causes, not symptoms:
A job posting is a symptom. A business challenge is the cause. Focus on the cause. Never focus on the job itself. For the lead, determine: why might this role exist, what business problem likely created it, what executive concern sits behind it, what market trend is influencing the decision, and what conversation an industry insider would naturally start.

EXECUTIVE DECISION FRAMEWORK — every executive operates from identity, responsibilities, pressures, risks, and desired outcomes. Write under the pressure and toward the desired outcome. Personas:
${renderPersonaTable()}

INDUSTRY INTELLIGENCE — reason from the current market themes when the industry is known:
${renderIndustryTable()}

GENERALIZATION (CRITICAL) — the personas and industries above are EXEMPLARS of the depth required, not a closed list. You will receive titles and industries far outside them. For ANY job title and ANY industry, reason to the exact same depth:
- Infer the persona's identity, the hidden pressures they operate under, the risks they fear, and the outcomes they want — derived from THIS specific title and seniority, not a generic bucket. A "VP of Revenue Operations", a "Director of Clinical Operations", a "Plant Manager", and a "Head of Trust & Safety" each live in a different world; write to that world.
- Infer the industry's current, real market themes and the questions a respected insider in THAT sector would naturally raise.
- Speak their language: use the vocabulary, metrics, and concerns native to their exact role and industry (a CFO hears "forecast accuracy"; a Head of Clinical Ops hears "site activation and protocol deviations"). Never sound generic, never sound like a template. The reader must feel you live in their world.
- Echo the persona and industry you inferred back in the output fields.

BUSINESS TRIGGERS — classify the hiring signal into one or more of: ${BUSINESS_TRIGGERS.join(", ")}.

CONTENT FORMULA — every message follows Observation -> Interpretation -> Curiosity. Never pitch, never sell, never request a meeting, never ask for business. The message ends on a genuine question, not an ask.

CHANNEL RULES:
- email: 50-100 words. Formula: observation, interpretation, question. Goal: create curiosity. Return a subject line and a body. The subject is a quiet, peer-level thought, never a pitch.
- linkedin_connection: <= 250 characters. Formula: observation, relevant insight, question. Goal: earn the accept.
- linkedin_message: 300-500 characters. Formula: industry observation, business implication, question. Goal: expand the conversation.
- linkedin_voice_note: a 20-35 second script (~50-90 words). Formula: why I noticed, what it may indicate, question. Written to be spoken aloud, conversational.
- voicemail: a 20-25 second script (~50-65 words). Formula: observation, business implication, question, then the callback number. Written to be spoken aloud.

PROFILE GROUNDING — when the lead's own background (headline, recent roles, tenure, specialties) is provided, anchor at least one concrete, specific reference to THEIR experience or THEIR company in the message, so it could not have been sent to anyone else. Reference only what you are given; never embellish a detail you were not told.

GROUNDING & CONFIDENCE — confidence_score reflects how defensibly the message is grounded in the SPECIFIC, REAL context you were given (title, company, industry, hiring signal, profile background), not how polished it reads. Score honestly: rich, specific context that lets you name a real pressure and a real observation -> high (0.8-1.0); thin context where you had to generalize the observation -> low (below 0.6). A low score is a signal that this lead needs human review or more enrichment before sending — do NOT inflate it, and never invent context to raise it.

SOCIAL PROOF — you may use measured framing: "We've noticed...", "A trend we've observed...", "Several leaders we've spoken with...", "Organizations at your stage often...", "Companies making similar hires frequently...". You may NOT use "most companies", "everyone", "guaranteed", or "best". Never fabricate statistics. Never invent client outcomes.

HARD STYLE RULES (house standard):
- Plain text only. No emojis. No hashtags. No links unless explicitly provided.
- Never use em dashes or en dashes. Use commas or periods.
- All money in US dollars with a $ sign.
- Reference only the real, specific details provided. Do NOT invent facts, names, numbers, or events. If a detail is missing, write around it; never guess.
- The market_observation must be defensible from the lead context provided.

The prospect should finish reading and feel: "this person understands what we are likely trying to accomplish" - never "this recruiter saw our job posting." Every message reads as the continuation of a thoughtful business conversation, not the start of a sales process.`;

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

function leadBrief(lead: BdLead): string {
  const first = lead.firstName ?? lead.fullName?.split(/\s+/)[0];
  return [
    lead.fullName ? `Name: ${lead.fullName}${first ? ` (first name: ${first})` : ""}` : null,
    lead.title ? `Title: ${lead.title}` : null,
    lead.company ? `Company: ${lead.company}` : null,
    lead.industry ? `Industry (given): ${INDUSTRY_INTEL[lead.industry as Industry]?.label ?? String(lead.industry)} (if outside the curated list, reason to the same depth and echo it back)` : "Industry: infer from title and company, then echo it back",
    lead.persona ? `Persona (given): ${PERSONAS[lead.persona as Persona]?.label ?? String(lead.persona)} (if outside the curated list, infer from the exact title and echo it back)` : "Persona: infer from the exact title, then echo it back",
    lead.hiringActivity ? `Observed hiring activity (the symptom, REAL): ${lead.hiringActivity}` : "Observed hiring activity: (none provided - do not invent one)",
    lead.companyContext ? `Other true context: ${lead.companyContext}` : null,
    lead.profileSummary ? `Prospect's own background (REAL, ground at least one specific reference in this): ${lead.profileSummary}` : null,
    `Sender (for spoken signoffs): ${lead.sender ?? "the Lume team"}`,
    `Callback number (voicemail close): ${lead.callbackNumber ?? "{{callbackNumber}}"}`,
  ].filter(Boolean).join("\n");
}

/**
 * Generate the full persona-grounded outreach package for one BD lead.
 * Returns the validated 12-field object; throws only on an unrecoverable API error.
 */
export async function generatePersonaMessage(lead: BdLead): Promise<PersonaMessage> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    // cache_control is honored by the API but untyped in this SDK version.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content:
          `Generate the outreach package for this lead.\n\nLEAD:\n${leadBrief(lead)}\n\n` +
          `Respond as strict JSON with exactly these keys and no prose outside the JSON:\n` +
          `{\n` +
          `  "industry": string,\n` +
          `  "persona": string,\n` +
          `  "business_trigger": string[],   // one or more of: ${BUSINESS_TRIGGERS.join(", ")}\n` +
          `  "executive_pressure": string,   // the single dominant pressure you are writing under\n` +
          `  "likely_business_problem": string,  // the cause behind the hiring symptom\n` +
          `  "market_observation": string,   // defensible from the lead context\n` +
          `  "email": { "subject": string, "body": string },\n` +
          `  "linkedin_connection": string,  // <= 250 chars\n` +
          `  "linkedin_message": string,     // 300-500 chars\n` +
          `  "linkedin_voice_note": string,  // 20-35s spoken script\n` +
          `  "voicemail": string,            // 20-25s spoken script, ends on the callback number\n` +
          `  "confidence_score": number      // 0 to 1\n` +
          `}`,
      },
    ],
  });

  const raw = response.content.find((b) => b.type === "text");
  const text = raw && raw.type === "text" ? raw.text : "{}";
  return normalize(safeJson(text), lead);
}

/* ------------------------------------------------------------------ */
/* Parsing + validation                                                */
/* ------------------------------------------------------------------ */

function safeJson(s: string): Record<string, unknown> {
  try {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    return start >= 0 ? JSON.parse(s.slice(start, end + 1)) : {};
  } catch {
    return {};
  }
}

/** Coerce the model output into a well-formed PersonaMessage and enforce the channel envelope.
 *  We clamp lengths defensively rather than re-prompting, so the call stays single-shot. */
function normalize(o: Record<string, unknown>, lead: BdLead): PersonaMessage {
  const triggers = Array.isArray(o.business_trigger)
    ? (o.business_trigger as unknown[]).map(String).filter((t): t is BusinessTrigger => (BUSINESS_TRIGGERS as readonly string[]).includes(t))
    : [];
  const email = (o.email ?? {}) as Record<string, unknown>;
  const score = Number(o.confidence_score);

  return {
    industry: str(o.industry) || (lead.industry ? (INDUSTRY_INTEL[lead.industry as Industry]?.label ?? String(lead.industry)) : ""),
    persona: str(o.persona) || (lead.persona ? (PERSONAS[lead.persona as Persona]?.label ?? String(lead.persona)) : ""),
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

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Trim to a hard character ceiling on a word boundary, so we never ship an over-limit note. */
function clampChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/* ------------------------------------------------------------------ */
/* Persona inference helper (optional, deterministic)                  */
/* ------------------------------------------------------------------ */

/** Best-effort persona from a raw title, for callers that want to pre-fill lead.persona.
 *  Returns undefined when no confident match; the model will infer it instead. */
export function inferPersona(title?: string): Persona | undefined {
  if (!title) return undefined;
  const t = title.toLowerCase();
  if (/\b(ceo|chief executive|founder|president)\b/.test(t)) return "ceo";
  if (/\b(coo|chief operating|head of operations|vp[, ]+operations)\b/.test(t)) return "coo";
  if (/\b(cfo|chief financial|controller|vp[, ]+finance)\b/.test(t)) return "cfo";
  if (/\b(managing partner|firm administrator)\b/.test(t)) return "managing_partner";
  if (/\b(cro|chief revenue|vp[, ]+sales|head of sales|head of revenue)\b/.test(t)) return "cro";
  if (/\b(chro|chief people|head of people|vp[, ]+(people|hr|talent)|head of talent|head of hr)\b/.test(t)) return "head_of_people";
  return undefined;
}
