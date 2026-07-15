/**
 * RecruitersOS · Phone · Business Development call intelligence
 *
 * One LLM pass turns a finished BD call (transcript + the rep's live notes)
 * into the structured BD record: summary, reason, need, current situation,
 * hiring detail, pain points, vendors, people, objections, buying signals,
 * next steps, action items, sentiment, and the opportunity classification.
 *
 * Grounding is the contract: the engine documents ONLY what was said or
 * strongly supported by the conversation. Anything not discussed comes back
 * empty / "Not discussed", never invented. The rep's live notes are treated
 * as high-trust context but are NEVER rewritten or replaced; they live on the
 * call record as their own layer.
 *
 * Same conventions as vetting/scoring.ts: Anthropic client, temperature 0
 * for repeatability, cached system prompt, STRICT-JSON-with-fallback, and
 * defensive normalization of every field.
 *
 * This module is the "bd" motion's analysis engine. The future Recruiting
 * phone registers its own engine beside it (see analysisForMotion below);
 * the telephony pipeline is shared, the intelligence is per-motion.
 */

import Anthropic from "@anthropic-ai/sdk";
import { nowIso, rid } from "../core/ids";
import type { Motion } from "../core/types";
import type {
  BdCallAnalysis, RecruitingCallAnalysis, CallTurn, CallSentiment, OpportunityScore,
  HiringRole, CallPerson, CallActionItem,
} from "./types";

const MODEL =
  process.env.RECRUITEROS_PHONE_MODEL ??
  process.env.RECRUITEROS_LLM_MODEL ??
  "claude-sonnet-4-6";

const SYSTEM = `You are a senior business development analyst at an executive search firm. You turn one finished BD phone call into concise, factual, structured notes a recruiter can act on.

THE GROUNDING RULE (overrides everything): document ONLY what was actually said on the call or is strongly supported by it. Never invent pain points, hiring needs, names, dates, or interest that the conversation does not contain. When a topic never came up, return "" for strings, [] for lists, and null where allowed. An empty field is correct; a fabricated one is a failure.

The rep's own typed notes are provided when they exist. Treat them as high-trust context from the person who was on the call: use them to resolve names, spellings, and commitments. Do not contradict them without transcript evidence.

Produce these fields:
- summary: 2-4 short factual sentences recapping the conversation. No fluff.
- callReason: one sentence on why the conversation happened (who initiated and for what).
- businessNeed: the recruiting/hiring/talent/business problem discussed, in 1-2 sentences. "" if none surfaced.
- currentSituation: what the company does for recruiting today, in 1-2 sentences.
- currentApproach: zero or more of exactly ["internal_recruiting","contingent_search","retained_search","staffing_agency","other_search_firm","none","unknown"]. Use "unknown" only when recruiting approach was discussed but unclear; [] when never discussed.
- hiringActive: true only if they stated current or imminent hiring.
- roles: one entry per role being hired, ONLY as stated: { "title", "openings" (number or null), "department", "location", "workModel" ("remote"|"hybrid"|"onsite"|""), "seniority" }. Missing detail = "" or null.
- hiringUrgency: their words on urgency, e.g. "backfill needed this month". "" if not discussed.
- hiringTimeline: stated timeline. "" if not discussed.
- painPoints: pains they actually EXPRESSED (verbatim-faithful paraphrases). Do not infer pain from silence.
- vendors: recruiting firms, staffing agencies, or internal teams they named as current/past resources.
- people: everyone named with buying relevance: { "name", "title", "role": one of "decision_maker"|"influencer"|"referral", "note" }. The person on the call counts when their authority is evident. A referral = someone we were told to speak with.
- objections: each objection actually raised, short ("Already using a recruiting firm", "No budget this quarter", ...).
- buyingSignals: statements or behavior indicating real interest (asked about fees, described an open role, agreed to a next step, asked for information).
- nextSteps: exactly what happens next, one imperative per entry ("Send fee agreement", "Call back Friday afternoon").
- followUpDate: if a date or timeframe was agreed, an ISO date (resolve relative dates from the provided call date). If only vague ("sometime next quarter"), return the phrase. "" if none.
- actionItems: the executable to-do list for the rep, each { "text", "dueDate": ISO date or null }. Every commitment the rep made must appear.
- sentiment: one of "very_positive","positive","neutral","resistant","negative" for how the contact engaged.
- opportunity: one of "hot","warm","nurture","cold","disqualified". Criteria:
  hot = live hiring need + engaged decision maker + a concrete agreed next step.
  warm = real need or strong interest, but authority, timing, or next step incomplete.
  nurture = no current need but the door is open; worth periodic touches.
  cold = no need, no interest, no next step.
  disqualified = a hard blocker: told never to contact, exclusively locked to a competitor, wrong audience entirely.
- opportunityRationale: 1-2 sentences citing the specific evidence behind the classification.

Style: plain sentences. No exclamation marks. Never use an em-dash anywhere in any field; use commas, colons, or periods instead.

Return STRICT JSON only, no prose, no markdown fences, with exactly the keys above.`;

export interface AnalyzeInput {
  transcript: CallTurn[];
  userNotes?: string;
  direction: "inbound" | "outbound";
  contactName?: string;
  contactTitle?: string;
  companyName?: string;
  /** ISO start time, used to resolve relative dates ("Friday"). */
  callDate: string;
  durationSec?: number;
  previousVersion?: number;
}

/** Analysis engines by motion. Telephony rails are shared; intelligence is
 *  per-motion. The recruiting engine lives in analysis-recruiting.ts and is
 *  imported lazily so this module has no dependency cycle with it. */
export function analysisForMotion(motion: Motion): (input: AnalyzeInput) => Promise<BdCallAnalysis | RecruitingCallAnalysis> {
  if (motion === "bd") return analyzeBdCall;
  if (motion === "recruiting") {
    return async (input: AnalyzeInput) => {
      const { analyzeRecruitingCall } = await import("./analysis-recruiting");
      return analyzeRecruitingCall(input);
    };
  }
  throw Object.assign(new Error(`phone_analysis_unavailable: no ${motion} engine yet`), { status: 409 });
}

/**
 * Analyze one finished BD call. Throws when the Anthropic key is missing
 * (surfaced as a clean pipeline error with retry); a malformed model reply
 * degrades to an empty-but-valid analysis flagged in the rationale.
 */
export async function analyzeBdCall(input: AnalyzeInput): Promise<BdCallAnalysis> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const who = [
    input.contactName && `Contact: ${input.contactName}`,
    input.contactTitle && `Title: ${input.contactTitle}`,
    input.companyName && `Company: ${input.companyName}`,
  ].filter(Boolean).join("\n") || "Contact: unknown (no CRM match)";

  const notes = (input.userNotes ?? "").trim();
  const userContent =
    `Business development call, ${input.direction}, on ${input.callDate.slice(0, 10)}` +
    `${input.durationSec ? `, ${Math.round(input.durationSec / 60)} min` : ""}.\n` +
    `${who}\n\n` +
    `Rep's live notes (high-trust context, may be empty):\n"""\n${notes.slice(0, 4000) || "(none)"}\n"""\n\n` +
    `Call transcript ("USER" is our rep, "CONTACT" is the prospect):\n"""\n` +
    transcriptText(input.transcript).slice(0, 24000) +
    `\n"""\n\nReturn the structured BD notes JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2400,
    // Repeatability: the same call must produce the same notes.
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

const APPROACHES = new Set([
  "internal_recruiting", "contingent_search", "retained_search",
  "staffing_agency", "other_search_firm", "none", "unknown",
]);
const SENTIMENTS: CallSentiment[] = ["very_positive", "positive", "neutral", "resistant", "negative"];
const OPPORTUNITIES: OpportunityScore[] = ["hot", "warm", "nurture", "cold", "disqualified"];

function str(v: unknown, max = 600): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function strList(v: unknown, maxItems = 20, maxLen = 300): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
}

function normalize(raw: string, previousVersion: number): BdCallAnalysis {
  let o: any = {};
  try {
    o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    o = {};
  }
  const parsed = Object.keys(o).length > 0;

  const roles: HiringRole[] = (Array.isArray(o.roles) ? o.roles : [])
    .map((r: any): HiringRole => ({
      title: str(r?.title, 160),
      openings: Number.isFinite(Number(r?.openings)) && Number(r?.openings) > 0
        ? Math.round(Number(r.openings)) : undefined,
      department: str(r?.department, 120) || undefined,
      location: str(r?.location, 160) || undefined,
      workModel: /^(remote|hybrid|onsite)$/i.test(str(r?.workModel, 20))
        ? str(r?.workModel, 20).toLowerCase() : undefined,
      seniority: str(r?.seniority, 120) || undefined,
    }))
    .filter((r: HiringRole) => r.title)
    .slice(0, 12);

  const people: CallPerson[] = (Array.isArray(o.people) ? o.people : [])
    .map((p: any): CallPerson => ({
      name: str(p?.name, 120),
      title: str(p?.title, 120) || undefined,
      role: /^(decision_maker|influencer|referral)$/.test(str(p?.role, 30))
        ? str(p?.role, 30) : "influencer",
      note: str(p?.note, 240) || undefined,
    }))
    .filter((p: CallPerson) => p.name)
    .slice(0, 12);

  const actionItems: CallActionItem[] = (Array.isArray(o.actionItems) ? o.actionItems : [])
    .map((a: any): CallActionItem => ({
      id: rid("act"),
      text: str(a?.text, 300),
      dueDate: isoDateOrEmpty(a?.dueDate) || undefined,
      done: false,
    }))
    .filter((a: CallActionItem) => a.text)
    .slice(0, 15);

  const sentiment = SENTIMENTS.includes(o.sentiment) ? o.sentiment : "neutral";
  const opportunity = OPPORTUNITIES.includes(o.opportunity) ? o.opportunity : "nurture";

  return {
    kind: "bd",
    summary: str(o.summary, 1200) || (parsed ? "No summary produced." : "Analysis failed to parse; regenerate to retry."),
    callReason: str(o.callReason, 400),
    businessNeed: str(o.businessNeed, 600),
    currentSituation: str(o.currentSituation, 600),
    currentApproach: strList(o.currentApproach, 7, 40).filter((a) => APPROACHES.has(a)),
    hiringActive: Boolean(o.hiringActive),
    roles,
    hiringUrgency: str(o.hiringUrgency, 300),
    hiringTimeline: str(o.hiringTimeline, 300),
    painPoints: strList(o.painPoints),
    vendors: strList(o.vendors, 12, 160),
    people,
    objections: strList(o.objections, 12),
    buyingSignals: strList(o.buyingSignals, 12),
    nextSteps: strList(o.nextSteps, 12),
    followUpDate: str(o.followUpDate, 60) || undefined,
    actionItems,
    sentiment,
    opportunity,
    opportunityRationale: str(o.opportunityRationale, 600),
    generatedAt: nowIso(),
    model: MODEL,
    version: previousVersion + 1,
  };
}

/** Keep real ISO dates as-is; keep short descriptive phrases; drop junk. */
function isoDateOrEmpty(v: unknown): string {
  const s = str(v, 60);
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}
