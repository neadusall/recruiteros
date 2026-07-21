/**
 * RecruitersOS · AI Vetting · Client working summary + intro email draft
 *
 * Every scored screen becomes something the recruiter can put in front of the
 * hiring client: a clean working summary of the conversation (who the person
 * is, what they showed against the qualifiers, motivators, comp, availability,
 * a recommendation) and a ready-to-review INTRO EMAIL draft presenting the
 * candidate.
 *
 * Two hard rules, straight from the operator:
 *   1. The draft is a DRAFT. It is never sent automatically; sending is always
 *      a human action from the UI.
 *   2. It is gated on the updated resume: status stays "awaiting_resume" until
 *      the candidate's resume lands after the call (the chase ladder's job),
 *      and only a "ready" draft can be sent. No resume, no client intro.
 *
 * Same Anthropic client + strict-JSON + deterministic-fallback convention as
 * scoring.ts / resumeCoach.ts, so a missing LLM key still produces a usable
 * (if plainer) summary and draft.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VettingDesk, VettingCall, CandidateProfile, ClientReport, RubricScores } from "./types";
import { RUBRIC_MAX, scoreBand } from "./types";
import {
  getDeskById, getCandidateById, getCallById, setClientReport, ensureVettingReady,
} from "./store";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/* ---------------- prompt ---------------- */

const REPORT_SYSTEM = `You are a senior executive recruiter turning a completed phone screen into two client-facing artifacts. The reader is the HIRING CLIENT: busy, commercially minded, allergic to fluff.

1. "summary": a working summary of the screen, plain text, structured with short UPPERCASE section headers on their own lines (CANDIDATE, HIGHLIGHTS, FIT AGAINST YOUR REQUIREMENTS, MOTIVATION, COMPENSATION AND AVAILABILITY, RECRUITER READ). Under each, tight lines or short dash bullets. Ground EVERYTHING in the transcript and scorecard given; never invent facts, numbers, or credentials. Where something wasn't covered on the call, leave it out rather than guessing. 150-280 words.

2. "emailSubject" + "emailBody": an intro email presenting this candidate to the client. Warm, confident, specific: one line on who they are, two or three of the strongest evidence points from the screen mapped to what the client cares about, one honest line on anything to probe further (credibility beats hype), and a clear next step (their updated resume is attached / you propose interview times). 90-150 words, plain text, no markdown, no bullet symbols other than a simple dash, address the client generically ("Hi there," or with the company name), sign off with the recruiter's first name only.

Style rules for BOTH: no em-dashes anywhere. No "I hope this finds you well". No inflated adjectives without evidence. Numbers stay as the candidate said them.

Return STRICT JSON only, no prose, no fences:
{ "summary": string, "emailSubject": string, "emailBody": string }`;

/* ---------------- helpers ---------------- */

function parseJson(raw: string): any {
  try {
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    return a >= 0 && b > a ? JSON.parse(raw.slice(a, b + 1)) : {};
  } catch {
    return {};
  }
}

function scoreLines(scores?: RubricScores): string {
  if (!scores) return "(not scored)";
  return (Object.keys(RUBRIC_MAX) as Array<keyof RubricScores>)
    .map((k) => `${k}: ${scores[k] ?? 0}/${RUBRIC_MAX[k]}`)
    .join(", ");
}

function transcriptText(call: VettingCall): string {
  return call.transcript
    .map((t) => `${t.role === "agent" ? "Recruiter" : "Candidate"}: ${t.text}`)
    .join("\n")
    .slice(0, 12000);
}

/** Has the candidate's resume landed since this call started? */
function resumeFresh(call: VettingCall, cand?: CandidateProfile): boolean {
  if (!cand?.resumeText || !cand.resumeUpdatedAt) return false;
  return Date.parse(cand.resumeUpdatedAt) >= Date.parse(call.startedAt);
}

/* ---------------- deterministic fallback (no LLM key) ---------------- */

function fallbackReport(desk: VettingDesk, call: VettingCall, cand?: CandidateProfile): { summary: string; emailSubject: string; emailBody: string } {
  const name = cand ? `${cand.firstName} ${cand.lastName}`.trim() : (call.callerName || "The candidate");
  const role = desk.roleTitle || "the role";
  const verdicts = (call.verdicts || [])
    .map((v) => `- ${v.pass ? "MET" : "NOT CLEARLY MET"}: ${v.answer}`)
    .join("\n");
  const extracted = call.extracted
    ? Object.entries(call.extracted)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v === true ? "yes" : v === false ? "no" : v}`)
        .join("\n")
    : "";
  const summary =
    `CANDIDATE\n${name}${cand?.enrichment?.currentTitle ? `, ${cand.enrichment.currentTitle}` : ""}${cand?.enrichment?.currentCompany ? ` at ${cand.enrichment.currentCompany}` : ""}\n\n` +
    `SCREEN RESULT\nScore ${call.totalScore ?? "n/a"}/100 (${call.totalScore != null ? scoreBand(call.totalScore) : "unscored"}). ${call.summary || ""}\n\n` +
    (verdicts ? `FIT AGAINST YOUR REQUIREMENTS\n${verdicts}\n\n` : "") +
    (extracted ? `DETAILS FROM THE CALL\n${extracted}\n\n` : "") +
    `RECRUITER READ\n${call.qualifyRationale || "See the call recording and transcript for the full picture."}`;
  const emailBody =
    `Hi there,\n\n` +
    `I just finished screening ${name} for ${role} and wanted to get them in front of you. ` +
    `${call.summary || "The conversation covered the core requirements and their background in depth."}\n\n` +
    `Their updated resume is attached, along with my working summary of the screen. ` +
    `If you like what you see, send me two or three times that work and I will get the interview locked in.\n\n` +
    `${desk.persona.agentName}`;
  return { summary, emailSubject: `Candidate for ${role}: ${name}`, emailBody };
}

/* ---------------- the builder ---------------- */

/**
 * Compose (or re-compose) the client report for a scored call and store it on
 * the call. Preserves sent status: a report already marked "sent" is never
 * regenerated over. Returns the stored report. Never throws on model trouble;
 * the deterministic fallback always produces something reviewable.
 */
export async function draftClientReport(deskId: string, callId: string, force = false): Promise<ClientReport | undefined> {
  await ensureVettingReady();
  const desk = getDeskById(deskId);
  const call = getCallById(callId);
  if (!desk || !call) return undefined;
  if (call.clientReport && !force) return call.clientReport;
  if (call.clientReport?.status === "sent") return call.clientReport;

  const cand = call.candidateId ? getCandidateById(call.candidateId) : undefined;

  let out = fallbackReport(desk, call, cand);
  if (process.env.ANTHROPIC_API_KEY && call.transcript.length) {
    try {
      const userContent =
        `Role: ${desk.roleTitle || "(see JD)"}${desk.clientCompany ? ` at ${desk.clientCompany}` : " (confidential client)"}\n` +
        `Recruiter first name: ${desk.persona.agentName}\n` +
        `Candidate: ${cand ? `${cand.firstName} ${cand.lastName}` : call.callerName || "unknown caller"}` +
        `${cand?.enrichment?.currentTitle ? `, currently ${cand.enrichment.currentTitle}` : ""}` +
        `${cand?.enrichment?.currentCompany ? ` at ${cand.enrichment.currentCompany}` : ""}\n\n` +
        `Job description (what the client is hiring for):\n"""\n${(desk.jobDescription || "").slice(0, 3000)}\n"""\n\n` +
        `Scorecard: total ${call.totalScore ?? "n/a"}/100${call.totalScore != null ? ` (${scoreBand(call.totalScore)})` : ""}; ` +
        `marketability ${call.marketabilityScore ?? "n/a"}/10; categories: ${scoreLines(call.scores)}\n` +
        `Per-requirement verdicts:\n${(call.verdicts || []).map((v) => `- ${v.pass ? "PASS" : "MISS"}: ${v.answer} (${v.rationale})`).join("\n") || "(none)"}\n` +
        `Structured facts: ${JSON.stringify(call.extracted ?? {})}\n` +
        `Screen summary: ${call.summary || "(none)"}\n` +
        `Qualification read: ${call.qualifyRationale || "(none)"}\n\n` +
        `Call transcript:\n"""\n${transcriptText(call)}\n"""\n\n` +
        `Write the client summary + intro email JSON.`;
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 1600,
        temperature: 0,
        system: [{ type: "text", text: REPORT_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
        messages: [{ role: "user", content: userContent }],
      });
      const block = res.content.find((b) => b.type === "text");
      const o = parseJson(block && block.type === "text" ? block.text : "{}");
      if (String(o.summary ?? "").trim() && String(o.emailBody ?? "").trim()) {
        out = {
          summary: String(o.summary).trim().slice(0, 4000),
          emailSubject: String(o.emailSubject ?? out.emailSubject).trim().slice(0, 160),
          emailBody: String(o.emailBody).trim().slice(0, 4000),
        };
      }
    } catch (e: any) {
      console.error("[vetting] client report LLM pass failed, using fallback:", e?.message || e);
    }
  }

  const report: ClientReport = {
    ...out,
    status: resumeFresh(call, cand) ? "ready" : "awaiting_resume",
    generatedAt: new Date().toISOString(),
  };
  setClientReport(call.id, report);
  return report;
}

/**
 * Post-webhook hook: draft the report for a freshly scored call, fire-and-forget
 * (same idiom as maybeAutoLearn / maybeLearnQuestions). Thin needs-review calls
 * are skipped; the recruiter can still generate one by hand from the UI.
 */
export async function maybeDraftClientReport(deskId: string, callId: string): Promise<void> {
  try {
    await ensureVettingReady();
    const call = getCallById(callId);
    if (!call || call.needsReview || call.clientReport) return;
    await draftClientReport(deskId, callId);
  } catch (e: any) {
    console.error("[vetting] auto client report failed:", e?.message || e);
  }
}
