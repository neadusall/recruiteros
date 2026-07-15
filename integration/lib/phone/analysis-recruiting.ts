/**
 * RecruitersOS · Phone · Recruiting call intelligence
 *
 * One LLM pass turns a finished CANDIDATE screening call (transcript + the
 * recruiter's live notes) into the structured screen: current role, comp,
 * availability, location, motivations, must-haves, strengths, concerns, fit,
 * next steps, and, the headline deliverable, a polished hiring-manager
 * SUBMITTAL the recruiter can send as-is.
 *
 * This is the "recruiting" motion's analysis engine. It plugs into the shared
 * telephony pipeline via analysisForMotion() in analysis.ts. Same contract as
 * the BD engine (analysis.ts): Anthropic client, temperature 0, cached system
 * prompt, STRICT-JSON with defensive normalization, grounding is the law.
 */

import Anthropic from "@anthropic-ai/sdk";
import { nowIso, rid } from "../core/ids";
import type { AnalyzeInput } from "./analysis";
import type {
  RecruitingCallAnalysis, CallTurn, CallSentiment,
  CandidateFit, CompDetail, CallActionItem,
} from "./types";

const MODEL =
  process.env.RECRUITEROS_PHONE_MODEL ??
  process.env.RECRUITEROS_LLM_MODEL ??
  "claude-sonnet-4-6";

const SYSTEM = `You are a senior technical recruiter at an executive search firm. You turn one finished candidate screening call into a factual, structured screen and a polished submittal a hiring manager will actually read.

THE GROUNDING RULE (overrides everything): document ONLY what the candidate actually said or what the conversation strongly supports. Never invent comp figures, employers, skills, years of experience, or interest that was not stated. When a topic never came up, return "" for strings, [] for lists. An empty field is correct; a fabricated one is a firing offense. Do not editorialize on personality or make protected-class inferences (age, race, gender, family status, health, national origin): recruit on skills, experience, and stated preferences only.

The recruiter's own typed notes are provided when they exist. Treat them as high-trust context from the person on the call: use them to resolve names, spellings, comp, and commitments. Do not contradict them without transcript evidence.

Produce these fields:
- summary: 2-4 short factual sentences recapping the screen.
- currentRole: candidate's current title. "" if not stated.
- currentEmployer: candidate's current company. "" if not stated.
- yearsExperience: relevant years as stated or clearly supported, e.g. "8 years". "" if unclear.
- currentComp: array of { "kind": one of "base"|"ote"|"total"|"hourly"|"equity"|"bonus"|"other", "amount": verbatim-faithful figure as said, e.g. "$145k base" }. [] if comp not discussed.
- compExpectations: same shape, the candidate's desired range/target. [] if not discussed.
- availability: notice period or earliest start, e.g. "2 weeks", "immediately", "3 months (visa)". "" if not discussed.
- location: where the candidate is based. "" if not discussed.
- workModelPreference: one of "remote","hybrid","onsite","flexible","" as stated.
- relocation: the candidate's stated position on relocating. "" if not discussed.
- rolesOfInterest: titles/roles the candidate is targeting or open to.
- motivations: why the candidate is exploring a move (each a short phrase in their spirit).
- mustHaves: non-negotiables the candidate named (comp floor, remote-only, specific tech, etc.).
- dealBreakers: things the candidate said would rule a role out.
- strengths: demonstrated strengths and standout skills, grounded in what was actually said or evidenced.
- concerns: risks a recruiter should flag for the hiring manager, ONLY where the conversation supports them (employment gap they explained, comp mismatch, short tenure pattern they described, a skill the role needs that they lack). Never speculation, never character judgments.
- skills: concrete skills, technologies, tools, or domains the candidate claimed.
- fit: one of "strong","possible","weak","not_a_fit","unclear" for the roles discussed.
- fitRationale: 1-2 sentences citing the specific evidence behind the fit read.
- sentiment: one of "very_positive","positive","neutral","resistant","negative" for candidate engagement.
- nextSteps: exactly what happens next, one imperative per entry ("Submit to hiring manager", "Schedule technical round").
- followUpDate: if a date/timeframe was agreed, an ISO date (resolve relative dates from the provided call date); a phrase if only vague; "" if none.
- actionItems: the recruiter's to-do list, each { "text", "dueDate": ISO date or null }. Every commitment the recruiter made must appear.
- headline: ONE punchy factual line to pitch this candidate, e.g. "Senior backend engineer, 9 yrs Go/AWS, available in 2 weeks, targeting $180k". No hype words.
- submittal: the hiring-manager candidate presentation, ready to send as-is. Write 3 to 5 tight paragraphs (or labeled short sections): who the candidate is and current role; most relevant experience and standout strengths for this role; comp expectations, availability, location, and work-model; motivations for the move; and any honest flags the hiring manager should know. Professional, specific, confident, and HONEST. Sell the real candidate, do not oversell. Ground every claim in the call.

Style: plain professional sentences. No exclamation marks. Never use an em-dash anywhere in any field; use commas, colons, periods, or parentheses instead.

Return STRICT JSON only, no prose, no markdown fences, with exactly the keys above.`;

/**
 * Analyze one finished candidate screening call. Throws when the Anthropic key
 * is missing (clean pipeline error with retry). A malformed model reply degrades
 * to an empty-but-valid analysis flagged in the summary.
 */
export async function analyzeRecruitingCall(input: AnalyzeInput): Promise<RecruitingCallAnalysis> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const who = [
    input.contactName && `Candidate: ${input.contactName}`,
    input.contactTitle && `Stated title: ${input.contactTitle}`,
    input.companyName && `Current/So-far employer: ${input.companyName}`,
  ].filter(Boolean).join("\n") || "Candidate: unknown (no CRM match)";

  const notes = (input.userNotes ?? "").trim();
  const userContent =
    `Candidate screening call, ${input.direction}, on ${input.callDate.slice(0, 10)}` +
    `${input.durationSec ? `, ${Math.round(input.durationSec / 60)} min` : ""}.\n` +
    `${who}\n\n` +
    `Recruiter's live notes (high-trust context, may be empty):\n"""\n${notes.slice(0, 4000) || "(none)"}\n"""\n\n` +
    `Call transcript ("USER" is our recruiter, "CONTACT" is the candidate):\n"""\n` +
    transcriptText(input.transcript).slice(0, 24000) +
    `\n"""\n\nReturn the structured recruiting screen JSON, including the hiring-manager submittal.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    temperature: 0,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{ role: "user", content: userContent }],
  });

  const block = response.content.find((b) => b.type === "text");
  return normalize(block && block.type === "text" ? block.text : "{}", input.previousVersion ?? 0);
}

function transcriptText(turns: CallTurn[]): string {
  return turns
    .map((t) => `${t.role === "user" ? "USER" : t.role === "contact" ? "CONTACT" : "SPEAKER"}: ${t.text}`)
    .join("\n");
}

/* ---------------- normalization ---------------- */

const SENTIMENTS: CallSentiment[] = ["very_positive", "positive", "neutral", "resistant", "negative"];
const FITS: CandidateFit[] = ["strong", "possible", "weak", "not_a_fit", "unclear"];
const COMP_KINDS = new Set(["base", "ote", "total", "hourly", "equity", "bonus", "other"]);

function str(v: unknown, max = 600): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function strList(v: unknown, maxItems = 20, maxLen = 300): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
}

function compList(v: unknown): CompDetail[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((c: any): CompDetail => ({
      kind: COMP_KINDS.has(str(c?.kind, 20).toLowerCase()) ? str(c?.kind, 20).toLowerCase() : "other",
      amount: str(c?.amount, 120),
    }))
    .filter((c) => c.amount)
    .slice(0, 8);
}

function normalize(raw: string, previousVersion: number): RecruitingCallAnalysis {
  let o: any = {};
  try {
    o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    o = {};
  }
  const parsed = Object.keys(o).length > 0;

  const actionItems: CallActionItem[] = (Array.isArray(o.actionItems) ? o.actionItems : [])
    .map((a: any): CallActionItem => ({
      id: rid("act"),
      text: str(a?.text, 300),
      dueDate: isoDateOrEmpty(a?.dueDate) || undefined,
      done: false,
    }))
    .filter((a: CallActionItem) => a.text)
    .slice(0, 15);

  const wm = str(o.workModelPreference, 20).toLowerCase();

  return {
    kind: "recruiting",
    summary: str(o.summary, 1200) || (parsed ? "No summary produced." : "Analysis failed to parse; regenerate to retry."),
    currentRole: str(o.currentRole, 200),
    currentEmployer: str(o.currentEmployer, 200),
    yearsExperience: str(o.yearsExperience, 60),
    currentComp: compList(o.currentComp),
    compExpectations: compList(o.compExpectations),
    availability: str(o.availability, 200),
    location: str(o.location, 200),
    workModelPreference: /^(remote|hybrid|onsite|flexible)$/.test(wm) ? wm : "",
    relocation: str(o.relocation, 200),
    rolesOfInterest: strList(o.rolesOfInterest, 12, 160),
    motivations: strList(o.motivations, 12),
    mustHaves: strList(o.mustHaves, 12),
    dealBreakers: strList(o.dealBreakers, 12),
    strengths: strList(o.strengths, 15),
    concerns: strList(o.concerns, 15),
    skills: strList(o.skills, 30, 120),
    fit: FITS.includes(o.fit) ? o.fit : "unclear",
    fitRationale: str(o.fitRationale, 600),
    sentiment: SENTIMENTS.includes(o.sentiment) ? o.sentiment : "neutral",
    nextSteps: strList(o.nextSteps, 12),
    followUpDate: str(o.followUpDate, 60) || undefined,
    actionItems,
    submittal: str(o.submittal, 6000) || "No submittal produced. Regenerate to retry.",
    headline: str(o.headline, 300),
    generatedAt: nowIso(),
    model: MODEL,
    version: previousVersion + 1,
  };
}

/** Keep real ISO dates; drop junk. */
function isoDateOrEmpty(v: unknown): string {
  const s = str(v, 60);
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}
