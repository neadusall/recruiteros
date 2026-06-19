/**
 * RecruitersOS · AI Vetting · Resume coaching loop
 *
 * The screen call is NOT an exact science. A candidate can genuinely have a
 * must-have but phrase it in different words on the call, or never get it onto
 * their resume in a way a hiring screener will see. This module closes that gap:
 *
 *   1. buildPostCallEmail(desk, call, candidate)
 *        Right after the call, email the candidate the role's must-haves in plain
 *        language — leaning on what they ALREADY demonstrated on the call — and
 *        invite them to update their resume so each must-have is clearly shown.
 *
 *   2. reviewResume(desk, resumeText, candidate?)
 *        When they resubmit, judge the resume against each must-have SEMANTICALLY
 *        (substance, not keywords): shown / partial / missing, with the evidence
 *        we found and tactful coaching for anything still missing. Returns a warm
 *        follow-up email so the loop can continue until every must-have lands.
 *
 * Hard rule baked into every prompt: we help a candidate SURFACE what is true —
 * reframe it in the role's language, add the metric, move it up the page — we
 * NEVER coach them to claim experience they don't have. Same honesty guardrail
 * as the rest of RecruitersOS (no hollow reasons / no fabricated proof).
 *
 * Same Anthropic client + STRICT-JSON-with-fallback + temperature:0 convention as
 * scoring.ts. Degrades to a safe, honest fallback when the model is unconfigured.
 */

import Anthropic from "@anthropic-ai/sdk";
import { rid } from "../core/ids";
import type {
  VettingDesk, VettingCall, CandidateProfile, MustHaveCoverage, QuestionVerdict,
} from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/** The candidate-facing page where they paste an updated resume and resubmit. */
function resumePageUrl(deskId: string, candidateId: string): string {
  const base = (process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co").replace(/\/$/, "");
  return `${base}/vetting-resume.html?desk=${encodeURIComponent(deskId)}&cid=${encodeURIComponent(candidateId)}`;
}

/**
 * The requirements to surface, in the shape both prompts consume. We pull the
 * desk's qualifiers (the must-haves the screen was built on); if the desk never
 * had qualifiers generated, the model is told to infer them from the JD instead.
 */
function requirementList(desk: VettingDesk) {
  return desk.questions.map((q) => ({
    questionId: q.id,
    requirement: q.prompt,
    passCriteria: q.passCriteria,
    mustHave: q.mustHave,
  }));
}

const HONESTY = `ABSOLUTE RULE — you help the candidate make TRUE things legible, never invent experience:
- Only ever coach them to SURFACE, RE-WORD, RE-ORDER, or QUANTIFY things they genuinely did. Reframing "ran the West region's pipeline" as "owned a $5M+ individual quota" is fine ONLY if it's actually true; never tell them to claim a number, title, scope, or tool they don't have.
- Match on SUBSTANCE, not keywords. The same requirement can appear in completely different words — credit it when the underlying experience is clearly there, even if the JD's exact phrase is absent.
- When something genuinely isn't in their background, say so honestly and kindly. Do NOT manufacture a way to fake it.`;

/* ====================================================================== */
/* 1. Post-call coaching email                                            */
/* ====================================================================== */

const POST_CALL_SYSTEM = `You are an executive recruiter writing a short, warm, genuinely helpful email to a candidate right after a phone screen. The goal: help them update their resume so the role's MUST-HAVES are clearly visible to the hiring team — phrased however is true to their real experience.

${HONESTY}

You are given: the role, the must-have requirements, and (when available) what the candidate already DEMONSTRATED on the call vs. what didn't clearly come through. Use that:
- Acknowledge the must-haves they already showed ("you clearly have X").
- For the ones that didn't land, gently flag them as things to make sure their resume speaks to — IF they have that experience — and give one concrete, tactful tip each (reframe in the role's language, add the metric, move it up).
- Make clear this is about making true experience legible, not embellishing. Keep the tone collegial and on their side, never bureaucratic.

Email rules: plain text (no markdown, no subject line inside the body), 120-180 words, warm and concrete, no corporate filler, no em-dashes. Address them by first name. Close by inviting them to send back an updated resume via the link the system will append (do NOT invent a URL yourself; end the body right before where a link would go).

Return STRICT JSON only, no prose, no fences:
{
  "worthInviting": bool,   // false ONLY if they're a clear, unfixable mismatch (lacks the core must-haves with no path); true if updating the resume could realistically help
  "emailSubject": string,  // short, specific, e.g. "Quick follow-up on the VP Sales conversation"
  "emailBody": string      // the plain-text email, ending right before the link
}`;

export interface PostCallEmail {
  worthInviting: boolean;
  subject: string;
  body: string;
  /** The must-haves echoed in plain language (for storage / UI). */
  mustHaves: string[];
}

function verdictLines(verdicts: QuestionVerdict[] | undefined, desk: VettingDesk): string {
  if (!verdicts?.length) return "(No per-qualifier call results available — work from the requirements alone.)";
  return verdicts
    .map((v) => {
      const q = desk.questions.find((x) => x.id === v.questionId);
      const label = q?.prompt ?? v.questionId;
      return `- ${label}: ${v.pass ? "DEMONSTRATED on the call" : "did NOT clearly come through"} — ${v.answer}`;
    })
    .join("\n");
}

/**
 * Compose the first coaching email after a scored call. Never throws — falls back
 * to a plain, honest deterministic email when the model is unconfigured, so the
 * webhook can always send something useful.
 */
export async function buildPostCallEmail(
  desk: VettingDesk,
  call: VettingCall,
  candidate: CandidateProfile,
): Promise<PostCallEmail> {
  const reqs = requirementList(desk);
  const mustHaves = reqs.map((r) => r.requirement);
  const link = resumePageUrl(desk.id, candidate.id);

  if (!process.env.ANTHROPIC_API_KEY) {
    return { ...fallbackPostCall(desk, candidate, mustHaves, link), mustHaves };
  }

  const userContent =
    `Candidate first name: ${candidate.firstName}\n` +
    `Role: ${desk.roleTitle || "(see description)"}${desk.clientCompany ? ` at ${desk.clientCompany}` : ""}\n\n` +
    `Must-have requirements for this role:\n${JSON.stringify(reqs, null, 2)}\n\n` +
    `What came through on the screening call:\n${verdictLines(call.verdicts, desk)}\n\n` +
    `Write the follow-up email JSON.`;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1100,
      temperature: 0,
      system: [{ type: "text", text: POST_CALL_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [{ role: "user", content: userContent }],
    });
    const block = res.content.find((b) => b.type === "text");
    const o = parseJson(block && block.type === "text" ? block.text : "{}");
    const body = String(o.emailBody ?? "").trim();
    if (!body) return { ...fallbackPostCall(desk, candidate, mustHaves, link), mustHaves };
    return {
      worthInviting: o.worthInviting !== false,
      subject: String(o.emailSubject ?? `Following up on our conversation about the ${desk.roleTitle || "role"}`).slice(0, 160),
      body: appendLink(body, link),
      mustHaves,
    };
  } catch {
    return { ...fallbackPostCall(desk, candidate, mustHaves, link), mustHaves };
  }
}

/* ====================================================================== */
/* 2. Resume review (semantic must-have coverage)                         */
/* ====================================================================== */

const REVIEW_SYSTEM = `You are an executive recruiter reviewing a candidate's updated resume against a role's MUST-HAVE requirements, to help them get past a hiring screen. You judge SUBSTANCE, not keywords.

${HONESTY}

For EACH requirement, decide status by reading the whole resume for the underlying experience, in WHATEVER words it appears:
- "shown": the resume clearly evidences this. A screener would credit it. (Different phrasing is fine.)
- "partial": the substance is hinted at but easy to miss — buried, vague, unquantified, or under a title that hides it. It needs to be made legible.
- "missing": nothing in the resume genuinely speaks to this.

For each: "evidence" = the exact line/phrase from the resume that supports it (quote or tight paraphrase), or "" if missing. "coaching" = one concrete, tactful next step IF they have it — reframe in the role's language, surface the metric, move it up, give it its own bullet. For "missing", if their background plausibly contains it, say how to check; if it genuinely isn't there, say so kindly. NEVER tell them to invent.

Then write a short, warm follow-up email (plain text, no markdown, no subject inside body, 110-170 words, no em-dashes, address by first name): celebrate what now lands, walk through the 1-3 things still to surface with the concrete tip for each, and encourage them to send an updated version. End right before where a link will be appended (do not write a URL). If everything is "shown", congratulate them and tell them their resume now clearly reflects the role's must-haves, and that you'll take it from here.

Return STRICT JSON only, no prose, no fences:
{
  "coverage": [ { "questionId": string|null, "requirement": string, "mustHave": bool, "status": "shown"|"partial"|"missing", "evidence": string, "coaching": string } ],
  "summary": string,        // 1-2 sentence read of where the resume stands
  "emailSubject": string,
  "emailBody": string
}`;

export interface ResumeReviewResult {
  coverage: MustHaveCoverage[];
  allMet: boolean;
  gaps: number;
  summary: string;
  emailSubject: string;
  emailBody: string;
}

/**
 * Review a submitted resume against the desk's must-haves. Throws only when the
 * LLM client is unconfigured (so the route can return a clean setup hint). A
 * malformed model reply degrades to a conservative "needs review" coverage.
 */
export async function reviewResume(
  desk: VettingDesk,
  resumeText: string,
  candidate?: CandidateProfile,
): Promise<ResumeReviewResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }

  const reqs = requirementList(desk);
  const link = candidate ? resumePageUrl(desk.id, candidate.id) : "";

  const userContent =
    `Role: ${desk.roleTitle || "(see JD)"}${desk.clientCompany ? ` at ${desk.clientCompany}` : ""}\n` +
    `Candidate first name: ${candidate?.firstName || "there"}\n\n` +
    `Must-have requirements (judge the resume against THESE, by substance):\n${JSON.stringify(reqs, null, 2)}\n\n` +
    (reqs.length
      ? ""
      : `(*No explicit qualifiers on file — infer the role's true must-haves from the job description below.*)\n\n`) +
    `Job description (context for what each requirement really means):\n"""\n${(desk.jobDescription || "").slice(0, 4000)}\n"""\n\n` +
    `Candidate's submitted resume:\n"""\n${resumeText.slice(0, 14000)}\n"""\n\n` +
    `Return the coverage + follow-up email JSON.`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2500,
    temperature: 0,
    system: [{ type: "text", text: REVIEW_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{ role: "user", content: userContent }],
  });

  const block = res.content.find((b) => b.type === "text");
  return normalizeReview(block && block.type === "text" ? block.text : "{}", desk, link);
}

function normalizeReview(raw: string, desk: VettingDesk, link: string): ResumeReviewResult {
  const o = parseJson(raw);
  const reqs = requirementList(desk);

  const rawCov: any[] = Array.isArray(o.coverage) ? o.coverage : [];
  // Anchor coverage to the desk's real requirements when we have them, so the
  // model can't silently drop or invent must-haves; fall back to whatever it
  // returned when the desk had none on file.
  const coverage: MustHaveCoverage[] = (reqs.length ? reqs : rawCov.map((c) => ({
    questionId: undefined, requirement: String(c?.requirement ?? "Requirement"), passCriteria: "", mustHave: Boolean(c?.mustHave),
  }))).map((r: any) => {
    const m = rawCov.find((c) => (r.questionId && c?.questionId === r.questionId) ||
      String(c?.requirement ?? "").toLowerCase().trim() === String(r.requirement).toLowerCase().trim());
    const status = ["shown", "partial", "missing"].includes(m?.status) ? m.status : "missing";
    return {
      questionId: r.questionId,
      requirement: String(r.requirement).slice(0, 240),
      mustHave: Boolean(r.mustHave),
      status,
      evidence: String(m?.evidence ?? "").slice(0, 400),
      coaching: String(m?.coaching ?? "").slice(0, 500),
    } as MustHaveCoverage;
  });

  const mustHaves = coverage.filter((c) => c.mustHave);
  const measured = mustHaves.length ? mustHaves : coverage;
  const gaps = measured.filter((c) => c.status !== "shown").length;
  const allMet = measured.length > 0 && gaps === 0;

  const body = String(o.emailBody ?? "").trim() || fallbackReviewBody(coverage, allMet);

  return {
    coverage,
    allMet,
    gaps,
    summary: String(o.summary ?? (allMet ? "Resume now reflects every must-have." : "Some must-haves still need to be surfaced.")).slice(0, 600),
    emailSubject: String(o.emailSubject ?? "Your updated resume — a couple of quick notes").slice(0, 160),
    emailBody: link ? appendLink(body, link, allMet) : body,
  };
}

/* ====================================================================== */
/* helpers                                                                */
/* ====================================================================== */

function parseJson(raw: string): any {
  try {
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    return a >= 0 && b > a ? JSON.parse(raw.slice(a, b + 1)) : {};
  } catch {
    return {};
  }
}

/** Append the resubmit link as a clean final line (skipped when everything's met). */
function appendLink(body: string, link: string, allMet = false): string {
  if (!link) return body;
  if (allMet) return body;
  return `${body.trim()}\n\nWhen you've updated it, just paste the new version here and I'll take another look:\n${link}`;
}

function fallbackPostCall(
  desk: VettingDesk,
  candidate: CandidateProfile,
  mustHaves: string[],
  link: string,
): { worthInviting: boolean; subject: string; body: string } {
  const role = desk.roleTitle || "the role";
  const bullets = mustHaves.length
    ? mustHaves.map((m) => `  • ${m}`).join("\n")
    : "  • the core requirements we talked through";
  const body =
    `Hi ${candidate.firstName},\n\n` +
    `Thanks again for the conversation about ${role}. To help your resume land well with the hiring team, make sure it clearly reflects these must-haves wherever your real experience speaks to them:\n\n` +
    `${bullets}\n\n` +
    `You may already have these under different wording — the goal is just to make them easy to see, with the specifics and numbers where you have them. Only include what's genuinely true to your background.`;
  return {
    worthInviting: true,
    subject: `Quick follow-up on ${role}`,
    body: appendLink(body, link),
  };
}

function fallbackReviewBody(coverage: MustHaveCoverage[], allMet: boolean): string {
  if (allMet) {
    return `Thanks for the update — your resume now clearly reflects each of the must-haves for this role. I'll take it from here and be in touch with next steps.`;
  }
  const gaps = coverage.filter((c) => c.status !== "shown");
  const lines = gaps.map((c) => `  • ${c.requirement}: ${c.coaching || "make sure your resume shows this if you have it."}`).join("\n");
  return `Thanks for sending that over. A few things still worth surfacing if they're true to your experience:\n\n${lines}\n\nReframe these in your own real terms — the goal is just to make them easy for a screener to see.`;
}
