/**
 * RecruiterOS · AI Vetting · Domain types
 *
 * AI Vetting is the INBOUND counterpart to Voice Drops. Instead of dialing out
 * and dropping a one-way voicemail, the recruiter stands up a "vetting desk":
 *
 *   one Job Description  +  one phone number  +  the recruiter's cloned voice
 *
 * A candidate opts in (a short form: LinkedIn URL, name, phone, email), then
 * calls the desk's number. A conversational AI agent — speaking in the
 * recruiter's OWN cloned voice — greets them by name, references their real
 * LinkedIn experience as talking points, asks the top 3-4 qualifying questions
 * for THAT job, and tells them the next step. The whole call is recorded,
 * transcribed, summarized, and scored against a 100-point recruiter rubric.
 *
 * The hard real-time part (STT -> LLM -> cloned-voice TTS, barge-in, turn
 * detection) is delegated to a managed Voice-AI engine (Telnyx AI Assistant by
 * default). Everything that is RecruiterOS's value — the JD<->number binding,
 * the candidate context/LinkedIn enrichment, the human-likeness instructions,
 * and the scoring — lives here.
 *
 * Recruiting-motion feature, but the model carries `motion` like Voice Drops so
 * a BD variant can reuse the same engine later.
 */

import type { Motion } from "../core/types";

/** Lifecycle of a vetting desk (a JD bound to a callable number). */
export type DeskStatus =
  | "draft"        // JD written, no number provisioned / assistant not synced yet
  | "provisioning" // assistant being created/attached at the engine
  | "live"         // number is answering calls
  | "paused";      // number kept, but the agent won't take calls

/** One qualifying question the agent must work into the conversation. */
export interface QualifyingQuestion {
  id: string;
  /** The thing being probed, e.g. "Years owning a quota over $5M". */
  prompt: string;
  /**
   * What a PASS looks like, in plain language — fed to the agent so it knows
   * what it's listening for, and to the scorer so it can judge the answer.
   * e.g. "3+ years carrying an individual quota of $5M or more."
   */
  passCriteria: string;
  /** True if failing this one alone should disqualify (a hard gate). */
  mustHave: boolean;
}

/**
 * The recruiter's honest on-call identity. This is truthful self-identification
 * (the agent IS the recruiter's cloned voice, acting as them) — never a claim
 * that the agent is a different human, and never caller-ID spoofing.
 */
export interface DeskPersona {
  /** First name the agent introduces itself as, e.g. "Ryan". */
  agentName: string;
  /** Firm stated on the call, e.g. "Executive Search". */
  agentCompany: string;
  /** How warm/direct the voice should run; tunes the system prompt. */
  warmth?: "warm" | "neutral" | "direct";
}

/**
 * A vetting desk: the unit of work. One JD, one inbound number, one cloned
 * voice, one set of qualifiers. Calls to `phoneNumber` are answered by an agent
 * configured entirely from this record.
 */
export interface VettingDesk {
  id: string;
  workspaceId: string;
  motion: Motion;
  /** Internal label, e.g. "VP Sales — East". */
  name: string;
  status: DeskStatus;

  /** The full job description, verbatim. The agent's source of truth. */
  jobDescription: string;
  /** Short role title shown in the UI + spoken by the agent ("the VP Sales role"). */
  roleTitle: string;
  /** Company the role is for (the hiring client), spoken naturally on the call. */
  clientCompany?: string;

  /** Top 3-4 qualifiers. The agent asks ONLY these, conversationally. */
  questions: QualifyingQuestion[];
  /** Plain-language description of the next step a QUALIFIED candidate is told. */
  nextStepQualified: string;
  /** What an UNQUALIFIED candidate is told (kind, honest, no false promises). */
  nextStepUnqualified: string;

  persona: DeskPersona;
  /** Cloned voice id (the recruiter's own consented voice; see Voice Drops). */
  voiceId?: string;

  /* ---- engine binding (Telnyx AI Assistant by default) ---- */
  /** E.164 inbound number this desk answers on, e.g. "+13855551234". */
  phoneNumber?: string;
  /** The provisioned assistant id at the voice engine (null until synced). */
  assistantId?: string;
  /** When the assistant config was last pushed to the engine. */
  syncedAt?: string;

  /** Minimum 0-100 score to mark a call "qualified" when criteria are mixed. */
  passThreshold: number;

  createdAt: string;
  updatedAt: string;
}

/** Accepted by upsertDesk (server fills workspace/timestamps/ids). */
export interface VettingDeskInput {
  id?: string;
  motion?: Motion;
  name?: string;
  jobDescription?: string;
  roleTitle?: string;
  clientCompany?: string;
  questions?: Array<Partial<QualifyingQuestion> & { prompt: string; passCriteria: string }>;
  nextStepQualified?: string;
  nextStepUnqualified?: string;
  persona?: Partial<DeskPersona>;
  voiceId?: string;
  phoneNumber?: string;
  passThreshold?: number;
}

/**
 * A candidate who opted in via the form. Keyed (for the inbound lookup) by their
 * normalized phone number within a desk — when they call, we match the caller ID
 * to this record so the agent already knows who they are.
 */
export interface CandidateProfile {
  id: string;
  workspaceId: string;
  deskId: string;
  firstName: string;
  lastName: string;
  /** Normalized to digits for matching; original kept for display. */
  phone: string;
  phoneDigits: string;
  email: string;
  linkedinUrl?: string;

  /** Enrichment pulled from LinkedIn at opt-in (best-effort; may be empty). */
  enrichment?: CandidateEnrichment;

  createdAt: string;
  updatedAt: string;
}

/**
 * The slice of a candidate's LinkedIn the agent uses as talking points. Kept
 * small and human-readable so it drops straight into the prompt as context.
 */
export interface CandidateEnrichment {
  headline?: string;
  currentTitle?: string;
  currentCompany?: string;
  location?: string;
  /** Recent roles, most-recent first, as short "Title at Company (years)" lines. */
  experience: string[];
  /** A 1-2 sentence summary the agent can reference ("you spent 6 years at...""). */
  summary?: string;
  /** True if enrichment actually ran against a provider (vs empty/dry-run). */
  source: "fresh_linkedin" | "none";
  fetchedAt: string;
}

/** Per-category scores making up the 100-point recruiter rubric. */
export interface RubricScores {
  /** Communication Quality — structure, clarity, no rambling (max 20). */
  communication: number;
  /** Response Quality & Length — concise yet complete (max 10). */
  responseLength: number;
  /** Interpersonal Presence — warmth, engagement, rapport (max 15). */
  interpersonalPresence: number;
  /** Self-Awareness — real strengths/weaknesses, owns the story (max 15). */
  selfAwareness: number;
  /** Achievement Orientation — metrics, outcomes, results (max 15). */
  achievementOrientation: number;
  /** Problem-Solving — reasoning, decision quality (max 10). */
  problemSolving: number;
  /** Energy & Motivation — genuine interest in the opportunity (max 10). */
  motivation: number;
  /** Cultural & Behavioral Fit — humility, accountability, no red flags (max 5). */
  culturalFit: number;
}

/** Max points per rubric category — the weighting from the recruiter scorecard. */
export const RUBRIC_MAX: RubricScores = {
  communication: 20,
  responseLength: 10,
  interpersonalPresence: 15,
  selfAwareness: 15,
  achievementOrientation: 15,
  problemSolving: 10,
  motivation: 10,
  culturalFit: 5,
};

/** Per-qualifier verdict the scorer extracts from the transcript. */
export interface QuestionVerdict {
  questionId: string;
  /** Did they meet the pass criteria? */
  pass: boolean;
  /** The candidate's actual answer, paraphrased in one line. */
  answer: string;
  /** Why it passed / failed, one line. */
  rationale: string;
}

/**
 * How human the AGENT itself sounded on the call (0-100). Scored against the
 * human-likeness spec — pacing, acknowledgments, no robotic tells, barge-in
 * respected — so the operator can confirm the agent is staying in character.
 */
export interface AgentRealismScore {
  score: number;
  notes: string;
}

/** Lifecycle of a single inbound vetting call. */
export type CallStatus =
  | "ringing"     // inbound leg up, agent engaging
  | "in_progress" // conversation underway
  | "completed"   // call ended, scoring pending
  | "scored"      // transcript scored, result ready
  | "failed";     // engine/setup error

/** One inbound vetting call and its full analysis. */
export interface VettingCall {
  id: string;
  workspaceId: string;
  deskId: string;
  /** Linked candidate (matched by caller ID), if they opted in first. */
  candidateId?: string;
  /** Snapshot of who called, even if no profile matched. */
  callerName?: string;
  callerPhone: string;

  status: CallStatus;
  /** Engine call id (Telnyx call_control_id / conversation id). */
  engineCallId?: string;
  /** URL to the call recording at the engine, if available. */
  recordingUrl?: string;
  /** Full transcript as ordered turns. */
  transcript: TranscriptTurn[];
  durationSec?: number;

  /* ---- analysis (filled once scored) ---- */
  scores?: RubricScores;
  /** Sum of `scores` — the headline 0-100. */
  totalScore?: number;
  /** 1-10 client-interview likelihood, independent of personal quality. */
  marketabilityScore?: number;
  agentRealism?: AgentRealismScore;
  /** Per-qualifier pass/fail. */
  verdicts?: QuestionVerdict[];
  /** Did they qualify overall? Drives the next-step message. */
  qualified?: boolean;
  /** 2-4 sentence human-readable recap of the conversation. */
  summary?: string;
  /** The "why / why not they qualify" paragraph the recruiter reads. */
  qualifyRationale?: string;
  /** The next step the candidate was told at the end of the call. */
  nextStepGiven?: string;

  startedAt: string;
  endedAt?: string;
  scoredAt?: string;
}

/** One turn in a call transcript. */
export interface TranscriptTurn {
  /** Who spoke. "agent" = our cloned-voice recruiter; "candidate" = the caller. */
  role: "agent" | "candidate";
  text: string;
  /** Seconds into the call this turn started, when the engine provides it. */
  atSec?: number;
}

/** Overall-score interpretation bands, from the recruiter scorecard. */
export function scoreBand(total: number): string {
  if (total >= 90) return "Exceptional candidate";
  if (total >= 80) return "Strong hire";
  if (total >= 70) return "Worth advancing";
  if (total >= 60) return "Borderline";
  return "Do not advance";
}

export const DEFAULT_PERSONA: DeskPersona = {
  agentName: "Ryan",
  agentCompany: "Executive Search",
  warmth: "warm",
};

export const DEFAULT_PASS_THRESHOLD = 70;
