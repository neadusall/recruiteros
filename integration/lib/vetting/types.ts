/**
 * RecruitersOS · AI Vetting · Domain types
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
 * default). Everything that is RecruitersOS's value — the JD<->number binding,
 * the candidate context/LinkedIn enrichment, the human-likeness instructions,
 * and the scoring — lives here.
 *
 * Recruiting-motion feature, but the model carries `motion` like Voice Drops so
 * a BD variant can reuse the same engine later.
 */

import type { Motion } from "../core/types";

/**
 * Voice delivery tuning for the desk's cloned ElevenLabs voice. These are the
 * knobs that decide whether the SAME voice reads as a person or a screen reader.
 * Bounds are enforced on save; the defaults are the phone-realism sweet spot
 * (see DEFAULT_VOICE_TUNING and lib/vetting/optimizer.ts for the rationale).
 */
export interface VoiceTuning {
  /** 0-1. Lower = more expressive/varied intonation; higher = flat and consistent. */
  stability: number;
  /** 0-1. How hard to hold to the cloned voice's timbre. */
  similarityBoost: number;
  /** 0-1. Style exaggeration; >0.3 costs latency and can sound performative. */
  style: number;
  /** 0.7-1.2. Playback speed; slightly under 1.0 reads as calm and senior. */
  speed: number;
  /** Boosts likeness on clones; slight latency cost, worth it on 8kHz calls. */
  speakerBoost: boolean;
}

/** Where a prompt revision came from. */
export type RevisionSource = "optimizer" | "auto_learn" | "manual";

/**
 * One versioned output of the prompt optimizer: a coaching addendum the agent
 * prompt absorbs, optional voice-tuning nudges, and the changelog explaining
 * WHAT changed and WHY (grounded in real call evidence). Revisions are kept so
 * every change is inspectable and revertible - the learning loop is never a
 * black box the operator can't unwind.
 */
export interface PromptRevision {
  id: string;
  /** Monotonic per desk: v1, v2, ... */
  version: number;
  source: RevisionSource;
  status: "proposed" | "applied" | "reverted";
  /**
   * The learned style addendum injected into the agent's instructions (the
   * "# WHAT YOU'VE LEARNED" section). Operative coaching lines, not analysis.
   */
  styleNotes: string;
  /** Voice-tuning values recommended alongside the notes (already clamped). */
  voiceTuning?: VoiceTuning;
  /** Human-readable "changed X because Y (call evidence)" lines. */
  changelog: string[];
  /** One-paragraph diagnosis of how the agent is performing overall. */
  diagnosis?: string;
  /** How many scored calls informed this revision. */
  basedOnCalls: number;
  /** Mean agent-realism score across those calls, when available. */
  avgRealismBefore?: number;
  createdAt: string;
  appliedAt?: string;
}

/**
 * One synthetic candidate persona the simulator plays against the desk's real
 * agent prompt - the same idea as GoHighLevel's Prompt Optimizer scenarios:
 * stress the agent BEFORE (or between) real candidates do.
 */
export interface SimScenario {
  id: string;
  /** Short label, e.g. "Skeptical: asks if this is an AI". */
  label: string;
  /** How the simulated candidate behaves (persona + backstory + goals). */
  persona: string;
  /** What a passing agent performance looks like in THIS scenario. */
  expected: string;
  priority: "critical" | "high" | "medium" | "low";
}

/** The judged outcome of one simulated conversation. */
export interface SimResult {
  scenarioId: string;
  label: string;
  priority: SimScenario["priority"];
  passed: boolean;
  /** 0-100, same human-likeness bar the real-call scorer uses. */
  realism: number;
  /** What broke (or what carried it), grounded in the sim transcript. */
  notes: string;
  transcript: TranscriptTurn[];
}

/** One full simulation run over a desk (a few scenarios, judged). */
export interface SimRun {
  id: string;
  at: string;
  results: SimResult[];
  passed: number;
  failed: number;
  avgRealism: number | null;
}

/**
 * The desk's self-improvement state. When autoLearn is on, every
 * `minCallsBetweenRuns` newly-scored calls trigger an optimizer pass whose
 * revision is auto-applied and pushed to the live agent - the desk literally
 * gets better at sounding human the more calls it takes.
 */
export interface DeskLearning {
  autoLearn: boolean;
  /** Scored calls to accumulate before an auto-learn pass re-runs (default 3). */
  minCallsBetweenRuns: number;
  /** The CURRENTLY applied style addendum (mirrors the applied revision). */
  learnedNotes: string;
  /** Version counter for the next revision. */
  nextVersion: number;
  revisions: PromptRevision[];
  lastRunAt?: string;
  /** Scored calls since the last optimizer pass (auto-learn trigger counter). */
  callsSinceLastRun: number;
  /** Most recent simulation run (kept singly; history lives in revisions). */
  lastSimulation?: SimRun;
}

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
  /** Delivery tuning for that voice (stability/style/speed...). Defaulted on read. */
  voiceTuning?: VoiceTuning;
  /** Self-improvement state: applied learnings + revision history + auto-learn. */
  learning?: DeskLearning;

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

  /** Latest resume text the candidate submitted to the coaching loop, if any. */
  resumeText?: string;
  resumeUpdatedAt?: string;

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

/**
 * One-line, transcript-grounded justification per rubric category. The scorer
 * fills these BEFORE the numbers so each score is anchored to real evidence
 * (not a cold guess), and the recruiter can see WHY a category landed where it did.
 */
export type RubricEvidence = Partial<Record<keyof RubricScores, string>>;

/**
 * How much to trust this scorecard. Driven by how much the CANDIDATE actually
 * said: a 20-second hang-up can't support a confident "qualified", so a thin
 * transcript is forced to "low" + needsReview regardless of the headline number.
 */
export type ScoringConfidence = "high" | "medium" | "low";

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
  /** One-line grounded justification per rubric category (the "why" behind each score). */
  evidence?: RubricEvidence;
  /** How much to trust this scorecard, given how much the candidate actually said. */
  scoringConfidence?: ScoringConfidence;
  /** True when the transcript was too thin to score confidently — surface for human review. */
  needsReview?: boolean;
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

/**
 * One job must-have measured against a candidate's resume — SEMANTICALLY, not by
 * keyword. The whole point: a candidate may genuinely have a requirement but
 * phrase it in different words (or not surface it at all), so we judge the
 * substance and then coach them to make it legible — never to fabricate it.
 */
export interface MustHaveCoverage {
  /** Ties back to the desk qualifier this came from (when derived from one). */
  questionId?: string;
  /** The requirement in plain language (e.g. "Owned an individual $5M+ quota"). */
  requirement: string;
  /** True if this is a hard must-have (vs. a nice-to-show qualifier). */
  mustHave: boolean;
  /**
   * Does the resume SHOW this, allowing for different wording?
   *  - "shown":   clearly evidenced (even if phrased differently)
   *  - "partial": the substance is hinted at but a screener could miss it
   *  - "missing": nothing in the resume speaks to it
   */
  status: "shown" | "partial" | "missing";
  /** Where/how the resume evidences it (quote or paraphrase), "" when missing. */
  evidence: string;
  /**
   * Tactful, concrete guidance to make the requirement legible IF the candidate
   * genuinely has it — reframe in the role's language, add the metric, move it
   * up. Never instructs them to claim something untrue.
   */
  coaching: string;
}

/** One round of the resume-coaching loop: a submitted resume, scored vs the must-haves. */
export interface ResumeReview {
  id: string;
  workspaceId: string;
  deskId: string;
  candidateId: string;
  /** 1 = first submission, increments each resubmission. */
  round: number;
  /** The resume text reviewed (verbatim, what the candidate submitted). */
  resumeText: string;
  /** Per-requirement semantic coverage. */
  coverage: MustHaveCoverage[];
  /** True when every MUST-HAVE is "shown" — the candidate has surfaced them all. */
  allMet: boolean;
  /** Count of must-haves still "missing" or "partial". */
  gaps: number;
  /** 1-2 sentence plain-English read of where the resume stands. */
  summary: string;
  /** The coaching email composed back to the candidate this round. */
  emailSubject?: string;
  emailBody?: string;
  emailSent?: boolean;
  createdAt: string;
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

/**
 * Phone-realism defaults for a cloned ElevenLabs voice over 8kHz telephony,
 * straight from ElevenLabs' own guidance: stability 0.30-0.50 is the "emotional,
 * dynamic delivery" band (0.60+ goes monotone); similarity ~0.80 holds the
 * clone's timbre without the over-enunciated "news anchor" artifact near 1.0;
 * style stays 0 in real-time (exaggeration adds latency and instability);
 * 0.9-1.1 speed is the documented natural-conversation band.
 */
export const DEFAULT_VOICE_TUNING: VoiceTuning = {
  stability: 0.4,
  similarityBoost: 0.8,
  style: 0,
  speed: 1.0,
  speakerBoost: true,
};

export const DEFAULT_LEARNING: DeskLearning = {
  autoLearn: false,
  minCallsBetweenRuns: 3,
  learnedNotes: "",
  nextVersion: 1,
  revisions: [],
  callsSinceLastRun: 0,
};

/** Clamp arbitrary input into a safe, speakable VoiceTuning. */
export function clampVoiceTuning(t?: Partial<VoiceTuning> | null): VoiceTuning {
  const n = (v: unknown, lo: number, hi: number, dflt: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
  };
  return {
    stability: n(t?.stability, 0, 1, DEFAULT_VOICE_TUNING.stability),
    similarityBoost: n(t?.similarityBoost, 0, 1, DEFAULT_VOICE_TUNING.similarityBoost),
    style: n(t?.style, 0, 0.6, DEFAULT_VOICE_TUNING.style),
    speed: n(t?.speed, 0.7, 1.2, DEFAULT_VOICE_TUNING.speed),
    speakerBoost: t?.speakerBoost === undefined ? DEFAULT_VOICE_TUNING.speakerBoost : Boolean(t.speakerBoost),
  };
}
