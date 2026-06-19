/**
 * RecruitersOS · AI Vetting · Call scoring
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
  VettingDesk, TranscriptTurn, RubricScores, RubricEvidence, ScoringConfidence,
  QuestionVerdict, AgentRealismScore, CandidateEnrichment,
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

CALIBRATION — score on an ABSOLUTE scale, not relative to other candidates, and resist the urge to cluster everyone at 70-80:
- Full marks in a category require unambiguous, specific, repeated evidence in the transcript. Reserve the top ~15% of each cap for genuinely standout performance.
- A category that is PRESENT but uneven or generic lands around 55-70% of its cap.
- Award below half ONLY when evidence is weak, vague, or absent — and below a quarter when it's actively a red flag.
- A category the transcript gives you no real evidence on must score LOW (you can't observe rapport or problem-solving from three sentences) — do not award benefit-of-the-doubt points.

GROUND BEFORE YOU SCORE: for each category, first write a one-line "evidence" note quoting or paraphrasing the SPECIFIC transcript moment that drives the number. The number must follow from that evidence. If you can't cite a moment, the evidence is "no observable evidence" and the score is low.

Also produce:
- verdicts: for EACH provided qualifier id, decide PASS or FAIL. Each qualifier's passCriteria is derived from the job's MUST-HAVE requirements — treat it as the bar to clear. Judge it by pairing that bar against THREE things together: (a) what the candidate SAID on the call, (b) their LinkedIn experience/background (provided below, when available), and (c) HOW they answered — whether they backed it with specifics, owned it ("I led…"), answered the actual question, and came across credible vs. vague/evasive. Pass only when there's concrete, credible evidence — from the conversation and/or their background — that genuinely meets the bar AND the way they answered supports it. If the content fits on paper but the answer was vague, evasive, or unconvincing, lean FAIL and say why. If the topic never came up and nothing in their background speaks to it, pass=false ("not covered"). In each rationale, note where the evidence came from (call / background / both) and a word on delivery.
- The "way they answer" — delivery, clarity, ownership, confidence under light pressure — is itself a DECIDING factor, not just color. A candidate who can't articulate a must-have convincingly should not pass it on paper credentials alone.
- marketability (1-10 integer): how likely the CLIENT is to grant an interview, based ONLY on pedigree, company background, title progression, scope, and relevance to the role — independent of how personable they were. A strong person can be a weak market fit and vice-versa.
- agentRealism (0-100) + notes: how HUMAN the RECRUITER (the "agent" turns) sounded — natural pacing, acknowledged before asking, didn't interrogate, no robotic/customer-support tells, didn't talk over the candidate. This judges OUR agent, not the candidate.
- transcriptSufficiency ("full" | "partial" | "thin"): was there ENOUGH candidate talk to actually judge them? "full" = a real multi-topic conversation; "partial" = a few exchanges, some categories unobservable; "thin" = a hang-up / one-liner / mostly the recruiter talking. Be honest — a thin call should say "thin".
- confidence ("high" | "medium" | "low"): how much YOU trust this scorecard given the above. A thin transcript can never be "high".
- summary: 2-4 sentences recapping the conversation.
- qualifyRationale: a short paragraph on WHY or why not they qualify for THIS role, referencing the qualifiers and rubric.

Return STRICT JSON only, no prose, no markdown fences. Produce the keys IN THIS ORDER so the evidence is written before each number:
{
  "evidence": { "communication": string, "responseLength": string, "interpersonalPresence": string, "selfAwareness": string, "achievementOrientation": string, "problemSolving": string, "motivation": string, "culturalFit": string },
  "scores": { "communication": int, "responseLength": int, "interpersonalPresence": int, "selfAwareness": int, "achievementOrientation": int, "problemSolving": int, "motivation": int, "culturalFit": int },
  "verdicts": [ { "questionId": string, "pass": bool, "answer": string, "rationale": string } ],
  "marketability": int,
  "agentRealism": { "score": int, "notes": string },
  "transcriptSufficiency": string,
  "confidence": string,
  "summary": string,
  "qualifyRationale": string,
  "qualified": bool
}`;

export interface CallScore {
  scores: RubricScores;
  /** One-line grounded justification per category (why each score landed). */
  evidence: RubricEvidence;
  totalScore: number;
  marketabilityScore: number;
  agentRealism: AgentRealismScore;
  verdicts: QuestionVerdict[];
  qualified: boolean;
  /** How much to trust this scorecard, given how much the candidate said. */
  scoringConfidence: ScoringConfidence;
  /** True when the transcript was too thin to score confidently. */
  needsReview: boolean;
  summary: string;
  qualifyRationale: string;
}

/** Minimum candidate-side signal to score with confidence. Below this is "thin". */
const MIN_CANDIDATE_WORDS = 60;
const MIN_CANDIDATE_TURNS = 3;

/** Deterministic read of how much the CANDIDATE actually said (the scorer's model
 *  read can be over-generous on a hang-up, so we floor it on hard counts). */
function candidateSignal(turns: TranscriptTurn[]): { words: number; turns: number; thin: boolean } {
  const cand = turns.filter((t) => t.role === "candidate");
  const words = cand.reduce((n, t) => n + t.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const thin = words < MIN_CANDIDATE_WORDS || cand.length < MIN_CANDIDATE_TURNS;
  return { words, turns: cand.length, thin };
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
export async function scoreCall(
  desk: VettingDesk,
  transcript: TranscriptTurn[],
  enrichment?: CandidateEnrichment,
): Promise<CallScore> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }

  const qualifiers = desk.questions.map((q) => ({
    questionId: q.id,
    prompt: q.prompt,
    passCriteria: q.passCriteria,
    mustHave: q.mustHave,
  }));

  const background =
    enrichment && (enrichment.experience.length || enrichment.summary || enrichment.currentTitle)
      ? "Candidate LinkedIn background (corroborating evidence for the qualifiers):\n" +
        [
          enrichment.currentTitle && `Current: ${enrichment.currentTitle}${enrichment.currentCompany ? ` at ${enrichment.currentCompany}` : ""}`,
          enrichment.experience.length && `Experience: ${enrichment.experience.join("; ")}`,
          enrichment.summary && `Summary: ${enrichment.summary}`,
        ].filter(Boolean).join("\n")
      : "Candidate LinkedIn background: (none on file — judge on the call alone).";

  const userContent =
    `Role: ${desk.roleTitle || "(see JD)"}${desk.clientCompany ? ` at ${desk.clientCompany}` : ""}\n\n` +
    `Pass threshold (0-100): ${desk.passThreshold}\n\n` +
    `Qualifiers to judge (their passCriteria come from the job's must-haves):\n${JSON.stringify(qualifiers, null, 2)}\n\n` +
    `Job description (the source of the must-have requirements):\n"""\n${(desk.jobDescription || "").slice(0, 4000)}\n"""\n\n` +
    `${background}\n\n` +
    `Call transcript:\n"""\n${transcriptText(transcript).slice(0, 16000)}\n"""\n\n` +
    `For each qualifier, pair the job's requirement against what they SAID, their BACKGROUND above, and HOW they answered. Return the scorecard JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    // Scoring must be repeatable: the SAME transcript should score the same way
    // every time, so we pin temperature to 0 and remove sampling variance.
    temperature: 0,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [{ role: "user", content: userContent }],
  });

  const block = response.content.find((b) => b.type === "text");
  return normalize(block && block.type === "text" ? block.text : "{}", desk, qualifiers, candidateSignal(transcript));
}

function normalize(
  raw: string,
  desk: VettingDesk,
  qualifiers: Array<{ questionId: string; mustHave: boolean }>,
  signal: { words: number; turns: number; thin: boolean },
): CallScore {
  let o: any = {};
  try {
    o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    o = {};
  }

  const scores = normalizeScores(o.scores);
  const totalScore = sumScores(scores);
  const evidence = normalizeEvidence(o.evidence);

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

  // Confidence: take the WORSE of the model's self-read and our deterministic
  // candidate-signal floor. A hang-up can't be scored confidently no matter how
  // generously the model reads it.
  const modelConfidence = parseConfidence(o.confidence, o.transcriptSufficiency);
  const scoringConfidence: ScoringConfidence = signal.thin ? "low" : modelConfidence;
  const needsReview = scoringConfidence === "low";

  // A must-have miss disqualifies regardless of the headline score; otherwise we
  // trust the model's call but require the score to clear the desk threshold.
  // A thin/low-confidence transcript can never auto-qualify — there isn't enough
  // signal to advance someone on; it routes to human review instead.
  const mustHaveMiss = verdicts.some((v) => {
    const q = qualifiers.find((x) => x.questionId === v.questionId);
    return q?.mustHave && !v.pass;
  });
  const modelQualified = Boolean(o.qualified);
  const qualified =
    !mustHaveMiss && modelQualified && totalScore >= desk.passThreshold && scoringConfidence !== "low";

  return {
    scores,
    evidence,
    totalScore,
    marketabilityScore,
    agentRealism,
    verdicts,
    qualified,
    scoringConfidence,
    needsReview,
    summary: String(o.summary ?? "No summary produced.").slice(0, 1200),
    qualifyRationale: String(o.qualifyRationale ?? "Insufficient transcript to assess fit.").slice(0, 2000),
  };
}

const RUBRIC_KEYS = Object.keys(RUBRIC_MAX) as (keyof RubricScores)[];

/** Keep only known categories; trim each note. Missing notes are simply absent. */
function normalizeEvidence(raw: any): RubricEvidence {
  const out: RubricEvidence = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of RUBRIC_KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 300);
  }
  return out;
}

/** Map the model's confidence/sufficiency words onto our enum, tolerant of shape. */
function parseConfidence(confidence: unknown, sufficiency: unknown): ScoringConfidence {
  const c = String(confidence ?? "").toLowerCase();
  if (c.includes("high")) return "high";
  if (c.includes("low")) return "low";
  if (c.includes("med")) return "medium";
  // Fall back to the sufficiency read when confidence is missing/garbled.
  const s = String(sufficiency ?? "").toLowerCase();
  if (s.includes("thin")) return "low";
  if (s.includes("partial")) return "medium";
  if (s.includes("full")) return "high";
  return "medium";
}
