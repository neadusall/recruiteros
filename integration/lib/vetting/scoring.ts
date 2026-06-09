/**
 * RecruiterOS · AI Vetting · Call scoring
 *
 * After a call ends we have the transcript. One LLM pass turns it into the full
 * recruiter scorecard:
 *   - the 8-category, 100-point rubric (the weighting is the recruiter scorecard)
 *   - a per-qualifier pass/fail against the desk's pass criteria
 *   - a Marketability score (1-10): how likely a CLIENT is to interview them,
 *     independent of personal quality (pedigree, title progression, scope)
 *   - an Agent-Realism score (0-100): how human OUR agent sounded, judged against
 *     the human-likeness spec, so the operator can confirm the agent stayed in
 *     character
 *   - a plain-English summary + a "why / why not they qualify" rationale
 *
 * Uses the same Anthropic client + STRICT-JSON-with-fallback convention as
 * sourcing/parseJobDescription and response/classify. Scoring is reasoning work,
 * so it defaults to a stronger model than the cheap extraction tier.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  VettingDesk, TranscriptTurn, RubricScores, QuestionVerdict, AgentRealismScore,
} from "./types";
import { RUBRIC_MAX } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Scoring is judgment, not extraction — use the reasoning tier; override via env.
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

const SYSTEM = `You are an elite executive recruiter scoring a short phone-screen transcript. You evaluate not just WHAT the candidate says, but HOW they think, communicate, build rapport, handle ambiguity, and present under light pressure.

Score the CANDIDATE on this 100-point rubric. Award whole numbers up to each cap:
- communication (max 20): structured answers (situation/action/result), complete thoughts, examples, easy to follow, no rambling.
- responseLength (max 10): concise yet complete — neither one-word nor endless tangents.
- interpersonalPresence (max 15): warm, engaged, curious, builds rapport; not monotone, defensive, or arrogant.
- selfAwareness (max 15): real strengths/weaknesses, owns their story; penalize "I work too hard" / blames others.
- achievementOrientation (max 15): concrete results, metrics, outcomes ("grew $4M to $11M"); penalize vague "I helped with…".
- problemSolving (max 10): logical reasoning, explains decisions; penalize jumping to conclusions.
- motivation (max 10): genuine interest, thoughtful questions, clear career reasons; penalize disinterest.
- culturalFit (max 5): humility, coachability, accountability, professionalism; penalize blame, entitlement, constant complaints.

Hidden signals to weigh inside the above: ownership language ("I led/implemented" vs "we/the team/my manager"), pace, listening (answers the ACTUAL question), executive presence (calm, doesn't over-explain).

Also produce:
- verdicts: for EACH provided qualifier id, a pass/fail against its passCriteria, the candidate's answer in one line, and a one-line rationale. If the topic never came up, pass=false and say it wasn't covered.
- marketability (1-10 integer): how likely the CLIENT is to grant an interview, based ONLY on pedigree, company background, title progression, scope, and relevance to the role — independent of how personable they were. A strong person can be a weak market fit and vice-versa.
- agentRealism (0-100) + notes: how HUMAN the RECRUITER (the "agent" turns) sounded — natural pacing, acknowledged before asking, didn't interrogate, no robotic/customer-support tells, didn't talk over the candidate. This judges OUR agent, not the candidate.
- summary: 2-4 sentences recapping the conversation.
- qualifyRationale: a short paragraph on WHY or why not they qualify for THIS role, referencing the qualifiers and rubric.

Return STRICT JSON only, no prose, no markdown fences. Shape:
{
  "scores": { "communication": int, "responseLength": int, "interpersonalPresence": int, "selfAwareness": int, "achievementOrientation": int, "problemSolving": int, "motivation": int, "culturalFit": int },
  "verdicts": [ { "questionId": string, "pass": bool, "answer": string, "rationale": string } ],
  "marketability": int,
  "agentRealism": { "score": int, "notes": string },
  "summary": string,
  "qualifyRationale": string,
  "qualified": bool
}`;

export interface CallScore {
  scores: RubricScores;
  totalScore: number;
  marketabilityScore: number;
  agentRealism: AgentRealismScore;
  verdicts: QuestionVerdict[];
  qualified: boolean;
  summary: string;
  qualifyRationale: string;
}

function clamp(n: unknown, max: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(max, v));
}

function normalizeScores(raw: any): RubricScores {
  const s = raw ?? {};
  return {
    communication: clamp(s.communication, RUBRIC_MAX.communication),
    responseLength: clamp(s.responseLength, RUBRIC_MAX.responseLength),
    interpersonalPresence: clamp(s.interpersonalPresence, RUBRIC_MAX.interpersonalPresence),
    selfAwareness: clamp(s.selfAwareness, RUBRIC_MAX.selfAwareness),
    achievementOrientation: clamp(s.achievementOrientation, RUBRIC_MAX.achievementOrientation),
    problemSolving: clamp(s.problemSolving, RUBRIC_MAX.problemSolving),
    motivation: clamp(s.motivation, RUBRIC_MAX.motivation),
    culturalFit: clamp(s.culturalFit, RUBRIC_MAX.culturalFit),
  };
}

function sumScores(s: RubricScores): number {
  return s.communication + s.responseLength + s.interpersonalPresence + s.selfAwareness +
    s.achievementOrientation + s.problemSolving + s.motivation + s.culturalFit;
}

function transcriptText(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => `${t.role === "agent" ? "RECRUITER" : "CANDIDATE"}: ${t.text}`)
    .join("\n");
}

/**
 * Score a finished call's transcript against the desk's qualifiers. Throws only
 * when the LLM client is unconfigured (so the webhook can surface a clean setup
 * hint); a malformed model response degrades to a zeroed, "needs review" result.
 */
export async function scoreCall(desk: VettingDesk, transcript: TranscriptTurn[]): Promise<CallScore> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }

  const qualifiers = desk.questions.map((q) => ({
    questionId: q.id,
    prompt: q.prompt,
    passCriteria: q.passCriteria,
    mustHave: q.mustHave,
  }));

  const userContent =
    `Role: ${desk.roleTitle || "(see JD)"}${desk.clientCompany ? ` at ${desk.clientCompany}` : ""}\n\n` +
    `Pass threshold (0-100): ${desk.passThreshold}\n\n` +
    `Qualifiers to judge:\n${JSON.stringify(qualifiers, null, 2)}\n\n` +
    `Job description (context):\n"""\n${(desk.jobDescription || "").slice(0, 4000)}\n"""\n\n` +
    `Call transcript:\n"""\n${transcriptText(transcript).slice(0, 16000)}\n"""\n\n` +
    `Return the scorecard JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{ role: "user", content: userContent }],
  });

  const block = response.content.find((b) => b.type === "text");
  return normalize(block && block.type === "text" ? block.text : "{}", desk, qualifiers);
}

function normalize(
  raw: string,
  desk: VettingDesk,
  qualifiers: Array<{ questionId: string; mustHave: boolean }>,
): CallScore {
  let o: any = {};
  try {
    o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    o = {};
  }

  const scores = normalizeScores(o.scores);
  const totalScore = sumScores(scores);

  const verdicts: QuestionVerdict[] = qualifiers.map((q) => {
    const v = Array.isArray(o.verdicts) ? o.verdicts.find((x: any) => x?.questionId === q.questionId) : undefined;
    return {
      questionId: q.questionId,
      pass: Boolean(v?.pass),
      answer: String(v?.answer ?? "Not covered").slice(0, 300),
      rationale: String(v?.rationale ?? "Topic did not come up on the call.").slice(0, 300),
    };
  });

  const marketabilityScore = Math.max(1, Math.min(10, Math.round(Number(o.marketability)) || 1));
  const agentRealism: AgentRealismScore = {
    score: clamp(o.agentRealism?.score, 100),
    notes: String(o.agentRealism?.notes ?? "").slice(0, 600),
  };

  // A must-have miss disqualifies regardless of the headline score; otherwise we
  // trust the model's call but require the score to clear the desk threshold.
  const mustHaveMiss = verdicts.some((v) => {
    const q = qualifiers.find((x) => x.questionId === v.questionId);
    return q?.mustHave && !v.pass;
  });
  const modelQualified = Boolean(o.qualified);
  const qualified = !mustHaveMiss && modelQualified && totalScore >= desk.passThreshold;

  return {
    scores,
    totalScore,
    marketabilityScore,
    agentRealism,
    verdicts,
    qualified,
    summary: String(o.summary ?? "No summary produced.").slice(0, 1200),
    qualifyRationale: String(o.qualifyRationale ?? "Insufficient transcript to assess fit.").slice(0, 2000),
  };
}
