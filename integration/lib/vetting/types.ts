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

/**
 * Conversation-feel knobs for the live call engine (interruption handling,
 * idle behavior, backchannels). These live on the Telnyx assistant surface,
 * which is the documented operator-verify seam: we send them shape-tolerantly
 * (assistant.ts) and the engine applies what it supports. The backchannel word
 * list also feeds the PROMPT so the agent uses those exact acknowledgment
 * sounds even on engines with no native backchannel feature.
 */
export interface TurnTuning {
  /** Let the caller barge in over the agent (the strongest realism signal). */
  interruptions: boolean;
  /**
   * 0-1. How readily caller speech cuts the agent off. High = a syllable stops
   * the agent (can false-trigger on "mm-hm"); low = the agent finishes clauses.
   */
  interruptionSensitivity: number;
  /**
   * 0-800. Extra milliseconds the agent holds AFTER the caller finishes before
   * it starts speaking. A small beat (150-400ms) reads as "thinking" and is one
   * of the cheapest human tells; 0 keeps the engine's fastest turn-taking.
   */
  pauseBeforeSpeakingMs: number;
  /** Seconds of caller silence before the agent gently re-engages. */
  idleTimeoutSec: number;
  /** What the agent says to re-engage after that silence. */
  idleReminder: string;
  /** Short listening sounds the agent may use while the caller talks. */
  backchannelWords: string[];
}

/**
 * One thing the agent is allowed to KNOW and answer about the role/company:
 * comp band, remote policy, benefits, interview process, who the client is.
 * Deflecting these questions is the #1 "this is a bot" tell, so desks carry a
 * small FAQ the agent answers from — and ONLY from (never invented).
 */
export interface KnowledgeItem {
  id: string;
  /** The candidate question this answers, e.g. "Is the role remote?". */
  question: string;
  /** The answer the agent may give, in speakable plain language. */
  answer: string;
}

/* ---------------- question intelligence (self-learning candidate Q&A) ----------------
   Every call, the questions the CANDIDATE asked are harvested from the transcript
   and rolled up per desk into topic clusters. Clusters the agent had to defer
   ("I'll flag it for the recruiter") become the desk's learning queue: an answer
   is drafted from the JD when the JD supports one, the recruiter approves or
   writes the real answer, the fact joins the desk FAQ, the live agent is
   re-provisioned, and (the promise-keeping move) the candidates who asked get
   the answer texted back from the desk's own number. */

/** How the agent handled one candidate question on a call. */
export type QAOutcome =
  | "answered"  // answered on the spot from its role facts
  | "partial"   // gave something, but hedged or was incomplete
  | "deferred"; // didn't know: flagged it for the recruiter

/** One question the candidate asked on one call (harvested post-call). */
export interface CallQuestion {
  /** The question as asked, lightly cleaned ("what's the 401k match?"). */
  question: string;
  /** Short canonical topic label the question rolls up under ("401k match"). */
  topic: string;
  outcome: QAOutcome;
  /** What the agent actually said back, one line. */
  answerGiven?: string;
}

/** One ask of a cluster's question: who asked it, on which call, when. */
export interface QAAsk {
  callId: string;
  candidateId?: string;
  /** Caller's number at ask time, kept so the answer can be texted back. */
  phone?: string;
  at: string;
  /** The phrasing THIS caller used. */
  question: string;
  /** Stamped when the approved answer was texted back to this asker. */
  answerTextedAt?: string;
}

export type QAClusterStatus =
  | "open"      // live: still collecting asks / awaiting an approved answer
  | "approved"  // answer approved and taught to the agent (in desk.knowledge)
  | "dismissed"; // recruiter decided this doesn't need teaching

/** One topic candidates ask about on this desk, with its learning state. */
export interface QACluster {
  id: string;
  /** Canonical topic label, e.g. "401k match", "team size", "travel". */
  topic: string;
  /** Representative phrasing shown in the UI. */
  canonicalQuestion: string;
  /** Distinct phrasings seen (capped), newest last. */
  variants: string[];
  askCount: number;
  /** Times the agent answered it on the spot from its facts. */
  answeredCount: number;
  /** Times the agent had to defer it (the gap signal). */
  deferredCount: number;
  status: QAClusterStatus;
  /** AI-drafted answer, grounded ONLY in the JD + existing desk facts. */
  draftAnswer?: string;
  /** True when the draft is fully supported by the JD/desk facts (teachable). */
  draftGrounded?: boolean;
  draftedAt?: string;
  /** The answer that was actually taught (may be recruiter-edited). */
  approvedAnswer?: string;
  /** The KnowledgeItem this cluster became once taught. */
  approvedKnowledgeId?: string;
  approvedAt?: string;
  dismissedAt?: string;
  /** Who asked (capped, newest first) so answers can be texted back. */
  asks: QAAsk[];
  firstAskedAt: string;
  lastAskedAt: string;
}

/** The desk's question-intelligence state. */
export interface DeskQA {
  clusters: QACluster[];
  /** Auto-teach: grounded drafts are approved + pushed live with no human step. */
  autoTeach: boolean;
  /** Default for "text the answer back to the candidates who asked". */
  textBack: boolean;
  /** Lifetime questions harvested on this desk. */
  totalAsked: number;
  lastHarvestAt?: string;
}

export const DEFAULT_DESK_QA: DeskQA = {
  clusters: [],
  autoTeach: false,
  textBack: true,
  totalAsked: 0,
};

/** One structured field the scorer extracts from every call's transcript. */
export interface ExtractionField {
  id: string;
  /** Machine key, e.g. "current_compensation". */
  key: string;
  /** Label shown in the scorecard, e.g. "Current comp". */
  label: string;
  type: "text" | "number" | "boolean" | "enum";
  /** Allowed values when type is "enum". */
  enumOptions?: string[];
}

/** Extracted values per call, keyed by ExtractionField.key; null = not mentioned. */
export type ExtractedData = Record<string, string | number | boolean | null>;

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
  /**
   * Coaching lens this variant optimized through ("warmth", "brevity",
   * "energy"), set when the revision came from a multi-variant Auto pass so
   * competing proposals are tellable apart in the UI.
   */
  angle?: string;
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
  /** The Job Library record this desk's JD registered as (lib/jobs). */
  jdId?: string;
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
  /** Role/company FAQ the agent may answer candidate questions from. */
  knowledge?: KnowledgeItem[];
  /** Scheduling link (e.g. TidyCal) the agent can text a strong candidate mid-call. */
  bookingUrl?: string;
  /** E.164 number of the desk's recruiter for a live mid-call transfer, if wanted. */
  transferNumber?: string;

  persona: DeskPersona;
  /** Cloned voice id (the recruiter's own consented voice; see Voice Drops). */
  voiceId?: string;
  /** Delivery tuning for that voice (stability/style/speed...). Defaulted on read. */
  voiceTuning?: VoiceTuning;
  /** Conversation-feel knobs (barge-in, idle, backchannels). Defaulted on read. */
  turnTuning?: TurnTuning;
  /** Structured fields the scorer extracts per call. Defaulted on read. */
  extraction?: ExtractionField[];
  /** Self-improvement state: applied learnings + revision history + auto-learn. */
  learning?: DeskLearning;
  /** Question intelligence: what candidates ask + the self-learning FAQ queue. */
  qa?: DeskQA;

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
  jdId?: string;
  roleTitle?: string;
  clientCompany?: string;
  questions?: Array<Partial<QualifyingQuestion> & { prompt: string; passCriteria: string }>;
  nextStepQualified?: string;
  nextStepUnqualified?: string;
  persona?: Partial<DeskPersona>;
  voiceId?: string;
  phoneNumber?: string;
  passThreshold?: number;
  /** Structured fields to extract per call (normalized + capped on save). */
  extraction?: ExtractionField[];
  /** Role/company FAQ items (normalized + capped on save). */
  knowledge?: KnowledgeItem[];
  bookingUrl?: string;
  transferNumber?: string;
}

/**
 * A candidate who opted in via the form. Keyed (for the inbound lookup) by their
 * normalized phone number within a desk — when they call, we match the caller ID
 * to this record so the agent already knows who they are.
 */
/* ---------------- self-scheduling (the availability loop) ---------------- */

export type ScreenScheduleStatus =
  | "awaiting_reply" // availability ask sent; waiting for the candidate
  | "clarify"        // reply came in but we needed to ask a follow-up
  | "booked"         // a call is on the books (engine fires it at the time)
  | "completed"      // the scheduled call happened (or the window passed)
  | "declined"       // the candidate said no / not interested
  | "canceled"       // the recruiter called it off by hand
  | "expired";       // no reply after the ladder; gone quiet

export type ScheduleStepKind =
  | "ask_sms" | "ask_email"    // the availability ask
  | "reply"                    // what the candidate wrote back (note = their text)
  | "clarify_sms" | "clarify_email"
  | "confirm_sms" | "confirm_email"
  | "booked" | "rebooked" | "canceled"
  | "reminder_sms" | "missed_sms"
  | "error";

/** One event in a candidate's scheduling conversation (sends + replies). */
export interface ScheduleStep {
  at: string;
  kind: ScheduleStepKind;
  ok?: boolean;
  note?: string;
}

/**
 * The state of one candidate's screen-call scheduling loop. Created when the
 * resume lands and the availability ask goes out; the candidate replies in
 * their own words ("today at 4pm EST", "tomorrow morning"), we parse it, and
 * the voice engine calls them at that moment.
 */
export interface ScreenSchedule {
  status: ScreenScheduleStatus;
  askedAt: string;
  askChannel: "sms" | "email";
  /** How many clarifying follow-ups we've sent (capped; then a human takes over). */
  clarifyCount: number;
  remindedAt?: string;
  lastReplyAt?: string;
  /** The candidate's latest scheduling reply, verbatim (capped for storage). */
  lastReply?: string;
  /** When the AI will call them (UTC instant). */
  scheduledFor?: string;
  /** The candidate's timezone the time was parsed in (IANA). */
  timezone?: string;
  /** Where the timezone came from: they said it, their area code, or the default. */
  tzSource?: "stated" | "area_code" | "default";
  /** The engine's scheduled-event id (cancel/reschedule handle). */
  eventId?: string;
  bookedAt?: string;
  note?: string;
  /** Conversation log, oldest first (capped). */
  steps: ScheduleStep[];
}

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
  /** Where the latest resume came from: the coaching page or the resume inbox. */
  resumeSource?: "page" | "email";
  /** Original attachment filename when the resume arrived by email. */
  resumeFileName?: string;
  /** When the "your resume is in, here's the screening call" invite went out. */
  screenInviteSentAt?: string;
  /** The self-scheduling loop: availability ask -> parsed reply -> booked call. */
  screen?: ScreenSchedule;

  createdAt: string;
  updatedAt: string;
}

/** One processed (or skipped) message from the resume inbox sweep. */
export interface InboxLogEntry {
  at: string;
  /** Sender address the message came from. */
  from: string;
  /** Attachment filename we acted on (or ""). */
  file: string;
  /** What happened to it. */
  outcome: "saved" | "unmatched" | "no_attachment" | "unsupported" | "error" | "schedule_reply";
  candidateId?: string;
  deskId?: string;
  /** Short human note ("filed to Jane Doe on VP Sales", "no opted-in candidate"). */
  note: string;
}

/** Per-workspace resume-inbox sweep state (shown on the Vetting Desks tab). */
export interface InboxState {
  lastSweepAt?: string;
  lastError?: string;
  /** Lifetime count of resumes filed from this inbox. */
  savedTotal: number;
  /** Most recent sweep outcomes, newest first (capped). */
  log: InboxLogEntry[];
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

/* ---------------- resume chase (the updated-resume follow-up ladder) ----------------
   The whole vetting motion converges on ONE artifact: the candidate's updated
   resume. The agent asks for it on the call; the moment the call is scored the
   chase starts: a thank-you email + a thank-you text the same day, a reminder
   email if nothing landed after a day, a reminder text a day after that, then
   quiet. A filed resume stops the ladder instantly wherever it is. */

/** One rung of the chase ladder. */
export type ChaseStepKind = "thanks_email" | "thanks_sms" | "reminder_email" | "reminder_sms";

/** One send attempt on the ladder (kept even when it failed, for the UI). */
export interface ChaseStep {
  kind: ChaseStepKind;
  at: string;
  ok: boolean;
  /** Short human note ("no email on file", "SMS failed: ..."). */
  note?: string;
}

export type ChaseStatus =
  | "active"     // ladder running: waiting on the resume
  | "completed"  // updated resume received: ladder stopped
  | "exhausted"  // every rung sent, no resume: we go quiet
  | "skipped";   // never started (no contact info / thin call)

/** The per-call chase state (lives on the VettingCall). */
export interface ResumeChase {
  status: ChaseStatus;
  startedAt: string;
  steps: ChaseStep[];
  /** When the updated resume landed (what "completed" means). */
  resumeReceivedAt?: string;
  /** Why the chase skipped or stopped early. */
  note?: string;
}

/* ---------------- client working summary + intro draft ----------------
   Every scored call is organized into a client-ready working summary and an
   intro email DRAFT. The draft is deliberately held for human review and is
   gated on the updated resume: "awaiting_resume" until the candidate's resume
   lands after the call, then "ready" - only then can it be sent, and sending
   is always a human action, never automatic. */

export type ClientReportStatus =
  | "awaiting_resume" // draft written, but the updated resume isn't in yet
  | "ready"           // resume received: cleared for the recruiter to review + send
  | "sent";           // recruiter sent (or marked sent) the intro

export interface ClientReport {
  /** The client-facing working summary of the screen, plain text. */
  summary: string;
  /** The intro email draft, ready for the recruiter's review. */
  emailSubject: string;
  emailBody: string;
  status: ClientReportStatus;
  generatedAt: string;
  sentAt?: string;
  sentTo?: string;
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
  /** Estimated engine cost of this call (metered minutes x rate), for the health strip. */
  costUsd?: number;

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
  /** Structured fields pulled from the transcript (desk.extraction schema). */
  extracted?: ExtractedData;
  /** Did they qualify overall? Drives the next-step message. */
  qualified?: boolean;
  /** 2-4 sentence human-readable recap of the conversation. */
  summary?: string;
  /** The "why / why not they qualify" paragraph the recruiter reads. */
  qualifyRationale?: string;
  /** The next step the candidate was told at the end of the call. */
  nextStepGiven?: string;
  /** Questions the CANDIDATE asked on this call (harvested post-call). */
  candidateQuestions?: CallQuestion[];
  /** Stamped once the question-intelligence harvest ran (idempotence guard). */
  questionsHarvestedAt?: string;
  /** The updated-resume follow-up ladder for this call. */
  chase?: ResumeChase;
  /** Client-ready working summary + intro email draft (held for review). */
  clientReport?: ClientReport;

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

/**
 * Conversation-feel defaults: barge-in on at moderate sensitivity (a syllable
 * of real speech interrupts, a stray "mm-hm" does not), a gentle re-engage
 * after 8 seconds of silence, and soft professional backchannels.
 */
export const DEFAULT_TURN_TUNING: TurnTuning = {
  interruptions: true,
  interruptionSensitivity: 0.6,
  pauseBeforeSpeakingMs: 0,
  idleTimeoutSec: 8,
  idleReminder: "No rush at all... take your time.",
  backchannelWords: ["mm-hm", "right", "okay", "yeah"],
};

/** Clamp arbitrary input into safe TurnTuning values. */
export function clampTurnTuning(t?: Partial<TurnTuning> | null): TurnTuning {
  const n = (v: unknown, lo: number, hi: number, dflt: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
  };
  const words = Array.isArray(t?.backchannelWords)
    ? t!.backchannelWords.map((w) => String(w).trim().toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 8)
    : DEFAULT_TURN_TUNING.backchannelWords;
  return {
    interruptions: t?.interruptions === undefined ? DEFAULT_TURN_TUNING.interruptions : Boolean(t.interruptions),
    interruptionSensitivity: n(t?.interruptionSensitivity, 0, 1, DEFAULT_TURN_TUNING.interruptionSensitivity),
    pauseBeforeSpeakingMs: Math.round(n(t?.pauseBeforeSpeakingMs, 0, 800, DEFAULT_TURN_TUNING.pauseBeforeSpeakingMs)),
    idleTimeoutSec: Math.round(n(t?.idleTimeoutSec, 3, 30, DEFAULT_TURN_TUNING.idleTimeoutSec)),
    idleReminder: (typeof t?.idleReminder === "string" && t.idleReminder.trim())
      ? t.idleReminder.trim().slice(0, 160)
      : DEFAULT_TURN_TUNING.idleReminder,
    backchannelWords: words,
  };
}

/**
 * The out-of-the-box extraction schema: the four facts a recruiter wants off
 * every screen regardless of role. Desks can edit/extend the list (max 8).
 */
export const DEFAULT_EXTRACTION: ExtractionField[] = [
  { id: "xf_comp", key: "current_compensation", label: "Current comp", type: "text" },
  { id: "xf_notice", key: "notice_period", label: "Notice period", type: "text" },
  { id: "xf_reloc", key: "willing_to_relocate", label: "Will relocate", type: "boolean" },
  { id: "xf_interest", key: "interest_level", label: "Interest level", type: "enum", enumOptions: ["low", "medium", "high"] },
];

/** Normalize a desk's extraction schema (defaults when unset, capped at 8). */
export function normalizeExtraction(fields?: ExtractionField[] | null): ExtractionField[] {
  if (!fields || !fields.length) return DEFAULT_EXTRACTION;
  return fields
    .filter((f) => f && typeof f.label === "string" && f.label.trim())
    .slice(0, 8)
    .map((f, i) => {
      const label = f.label.trim().slice(0, 60);
      const key = (typeof f.key === "string" && f.key.trim())
        ? f.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)
        : label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
      const type = (["text", "number", "boolean", "enum"] as const).includes(f.type as any) ? f.type : "text";
      return {
        id: f.id || `xf_${i}_${key}`,
        key,
        label,
        type,
        enumOptions: type === "enum"
          ? (Array.isArray(f.enumOptions) ? f.enumOptions.map((o) => String(o).trim()).filter(Boolean).slice(0, 8) : [])
          : undefined,
      };
    });
}

/**
 * Max FAQ facts a desk carries. Was 12; raised so question-intelligence can
 * keep TEACHING approved answers without silently dropping earlier facts. The
 * prompt stays lean because answers are capped at 400 chars each.
 */
export const KNOWLEDGE_CAP = 24;

/**
 * Normalize a desk's role/company FAQ: trimmed, capped at KNOWLEDGE_CAP items,
 * answers kept short enough to stay speakable (and to keep the prompt lean).
 */
export function normalizeKnowledge(items?: KnowledgeItem[] | null): KnowledgeItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((k) => k && typeof k.question === "string" && k.question.trim() && typeof k.answer === "string" && k.answer.trim())
    .slice(0, KNOWLEDGE_CAP)
    .map((k, i) => ({
      id: k.id || `kn_${i}`,
      question: k.question.trim().slice(0, 160),
      answer: k.answer.trim().slice(0, 400),
    }));
}

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
