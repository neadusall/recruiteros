/**
 * RecruitersOS · Voice Drops · Domain types
 *
 * Voice Drops is the compliant landline/VoIP voicemail-outreach motion: dial a
 * verified BUSINESS direct line, use Telnyx Premium AMD to detect the voicemail,
 * and drop a personalized 15-25s message assembled from a templated script with
 * the recipient's first name and role spliced in. Cell/mobile numbers are NEVER
 * dialed — they are classified out before a campaign runs.
 *
 * Compliance is modeled as first-class state, not an afterthought:
 *  - every campaign carries a consent attestation + the operator's own consented
 *    cloned voice,
 *  - every lead is dialed only inside its OWN local-time window (timezone derived
 *    from the lead's location), bounded by a hard TCPA-safe envelope,
 *  - every attempt records an auditable outcome.
 *
 * Used by both motions (BD + Recruiting); each campaign is tagged with its motion.
 */

import type { Motion } from "../core/types";
import type { LineType } from "../signals/phoneClassify";
import type { VoiceProvider } from "./provider";

/** The auditable result of a single dial attempt. */
export type DropOutcome =
  | "queued"               // imported, awaiting its local compliance window
  | "scheduled"            // in window soon / next eligible window computed
  | "dialing"              // call placed, AMD pending
  | "voicemail_delivered"  // the personalized VM actually played to completion on a machine
  | "human_answered"       // a person picked up; honest identifier played, then ended
  | "no_answer"            // rang out / no voicemail
  | "failed"               // dial/synthesis error
  | "filtered_mobile"      // never dialed: classified mobile/cell (or toll-free)
  | "suppressed";          // DNC / opt-out / frequency cap

/** Outcomes that mean a real, billable voice minute was spent dialing. */
export const DIALED_OUTCOMES: DropOutcome[] = [
  "voicemail_delivered", "human_answered", "no_answer",
];

/**
 * The operator's honest identification — used as the human-answer script and as
 * the identity stated in every voicemail. This is truthful self-identification
 * (real name + real firm); it is NOT caller-ID spoofing or evasion.
 */
export interface VoicePersona {
  /** First name stated on the call, e.g. "Ryan". */
  agentName: string;
  /** Firm stated on the call, e.g. "Executive Search". */
  agentCompany: string;
  /**
   * Closing line played when a human says it's not the target / doesn't engage,
   * e.g. "Sorry, wrong number. Thanks." Honest, brief sign-off, then hang up.
   */
  signoff: string;
}

/**
 * The local-time window a lead may be dialed in, in the LEAD's own timezone.
 * Default 19:00-21:00 (7-9 PM): the late-evening slot where the line rolls
 * straight to voicemail. The engine additionally clamps every window to a hard
 * TCPA-safe envelope (see HARD_WINDOW) so a misconfiguration can't dial at an
 * unlawful hour.
 */
export interface ComplianceWindow {
  /** Local start hour, 0-23 inclusive. Default 19 (7 PM). */
  startHour: number;
  /** Local end hour, 0-23 exclusive. Default 21 (9 PM). */
  endHour: number;
}

/** One person on a Voice Drops list. Only landline/VoIP leads are ever dialed. */
export interface VoiceLead {
  id: string;
  firstName: string;
  fullName?: string;
  /** Job/title spliced into the script's {role} slot. */
  role?: string;
  company?: string;
  /** The number we dial. Must be landline/VoIP — mobiles are filtered out. */
  phone: string;
  /** Telnyx-classified line type (mobile leads are filtered, never dialed). */
  lineType: LineType;
  /** Free-text location (e.g. "Salt Lake City, UT") used to derive timezone. */
  location?: string;
  /** Resolved IANA timezone (e.g. "America/Denver"), or undefined if unknown. */
  timezone?: string;
  outcome: DropOutcome;
  attempts: number;
  lastAttemptAt?: string;
  /** Telnyx call_control_id of the most recent attempt. */
  callControlId?: string;
  /** Link back to a RecruitersOS Prospect when imported from a saved list. */
  prospectId?: string;
  /** Per-lead voicemail script (BD weekly waves set a unique, value-first script
   *  each week). When present it OVERRIDES the campaign's scriptTemplate for this
   *  lead, so each wave's drop is different. Still merge-templated + cloned + gated. */
  customScript?: string;
}

/** Consent for one cloned voice — the operator's OWN voice, captured on record. */
export interface VoiceConsent {
  id: string;
  workspaceId: string;
  /** Whose voice this is (must match the persona agentName for a campaign). */
  agentName: string;
  /** Which TTS vendor this voice id belongs to (default elevenlabs). */
  provider?: VoiceProvider;
  /** Provider voice id — pasted by the user, or minted by the Voice Studio. */
  voiceId?: string;
  /**
   * WHOSE voice this is, as a lowercased email. This is the join key that makes
   * Voice Drops per-recruiter: a drop sent on Sam's behalf resolves Sam's voice,
   * not "whatever the workspace pinned last". Absent on legacy rows (pre-2026-08-21
   * paste-an-id voices), which stay available as the shared workspace fallback.
   */
  ownerEmail?: string;
  /** Workspace user id for the same person, when known. */
  userId?: string;
  /** Set when the voice was minted by the in-app enrollment wizard (not pasted). */
  enrollmentId?: string;
  /** Where the recorded consent clip is stored. */
  consentClipUrl?: string;
  /** The exact consent statement the operator recorded. */
  statement: string;
  /** Signed-in user who attested, and when. */
  attestedBy: string;
  attestedAt: string;
}

/**
 * Per-workspace Voice Drops settings — the operator's explicit, deterministic
 * choice of which cloned voice (and therefore which TTS engine) is used. Pins a
 * specific saved consent voice so BOTH the test drop / "Listen first" preview AND
 * live campaign sends synthesize in the same engine — never "whichever voice was
 * saved last". A campaign may still override with its own voiceId.
 */
export interface VoiceSettings {
  /**
   * When true (the default once any recruiter has enrolled), a drop speaks in the
   * voice of the RECRUITER it is sent on behalf of, falling back to the workspace
   * voice below only for people who have not enrolled. Set false to force every
   * drop through the single pinned workspace voice.
   */
  perRecruiterVoice?: boolean;
  /**
   * The TTS engine the operator picked — the prominent, provider-level choice.
   * When set, every drop synthesizes on this vendor (using the voice pinned in
   * activeVoiceId if it belongs to this provider, else the most recent saved
   * voice for it, else the provider's env default voice).
   */
  activeProvider?: VoiceProvider;
  /** Consent record id of the active voice. Resolves to its provider + voiceId. */
  activeVoiceId?: string;
}

/**
 * A reusable, templated voicemail script. The body uses {first_name}, {role},
 * and {company} merge slots, exactly like an email merge. Surfaces in the
 * Campaign Sequences Library as a reusable voice asset.
 */
export interface VoiceScript {
  id: string;
  workspaceId: string;
  motion: Motion;
  name: string;
  /** Templated VM body, e.g. "Hi {first_name}, Ryan with Executive Search...". */
  template: string;
  /** Cloned voice this script renders in (defaults to the campaign's voice). */
  voiceId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A pre-recorded pitch (the operator's OWN voice, uploaded or mic-recorded) that
 * a campaign can drop onto voicemails instead of a synthesized script. The drop
 * plays a short personalized AI intro first ("Hi {first_name}. I know you're the
 * {role} at {company}.") in the operator's cloned voice, then this recording.
 *
 * PERSONAL artifact (CLAUDE.md rule 2): it carries a specific person's voice, so
 * it stamps the owning recruiter's email and portal routes filter to the
 * requester (workspace owner/admin keep the full-workspace view).
 */
export interface VoiceRecording {
  id: string;
  workspaceId: string;
  /** Owning recruiter (lowercased email). Personal: filtered per requester. */
  ownerEmail: string;
  /** Display name, e.g. "Perm placement pitch, Q3". */
  name: string;
  /** Audio file in the voice cache (rec_*.mp3 / rec_*.wav), served publicly via
   *  /api/voice/audio/{file} so Telnyx playback can fetch it. Opaque name. */
  file: string;
  mime: "audio/mpeg" | "audio/wav";
  bytes: number;
  /** Measured client-side on upload; used for cost/length estimates. */
  durationSec?: number;
  /** Operator attested the recording states their real name + firm (honest
   *  identification lives INSIDE the audio, which we cannot machine-check). */
  identifiesAttested: boolean;
  createdAt: string;
  createdBy: string;
}

/* ============================ voice enrollment =============================
   Cloning a recruiter's voice is a PERSON-level act, not a workspace setting.
   An enrollment is that person's file: the guided reads they recorded (the
   consent statement among them), the clone those reads produced, and the state
   in between. One per recruiter per workspace, keyed by lowercased email so a
   drop sent on their behalf can resolve their voice without a lookup table.  */

/** Where a recruiter is in the enrollment flow. */
export type EnrollmentStatus =
  | "not_started"  // no takes recorded yet
  | "recording"    // some takes in, not enough to clone
  | "ready"        // enough good audio + consent recorded; awaiting "Create my voice"
  | "cloned"       // a provider voice id exists and is wired to this person
  | "failed";      // the last clone attempt errored (see `error`)

/**
 * One guided read. Recruiters are prompted with specific passages rather than
 * "say something for a minute": an instant clone fits the delivery it hears, so
 * the passages are written in the register the voice will actually be used in
 * (an unhurried business voicemail), and the consent read doubles as the
 * compliance artifact proving the person authorized their own clone.
 */
export interface EnrollmentPrompt {
  id: string;
  title: string;
  /** What the recruiter reads aloud, verbatim. */
  text: string;
  /** Coaching shown under the prompt. */
  hint: string;
  /** Target length; the quality gate enforces `minSec`. */
  targetSec: number;
  minSec: number;
  /** True for the read that records consent (required before a clone runs). */
  consent?: boolean;
}

/** One recorded take against a prompt. */
export interface EnrollmentTake {
  id: string;
  /** EnrollmentPrompt.id this take answers. */
  promptId: string;
  /** Audio in the voice cache (enr_*.wav / .mp3), served via /api/voice/audio. */
  file: string;
  mime: "audio/mpeg" | "audio/wav";
  bytes: number;
  durationSec: number;
  /** Peak amplitude 0..1 of the RAW take, before normalisation. Above ~0.99 the
   *  take was clipping, which normalising cannot undo and a clone bakes in. */
  peak?: number;
  /** RMS level 0..1 of the RAW take. This, not peak, is what "too quiet" means:
   *  one loud consonant can peak a take that is otherwise mostly room noise. */
  rms?: number;
  /** Capture rate. The engine wants 44.1 kHz or better; below that the clone
   *  loses the high end that makes a specific person recognisable. */
  sampleRate?: number;
  createdAt: string;
}

/** A recruiter's voice file: their reads, and the clone minted from them. */
export interface VoiceEnrollment {
  id: string;
  workspaceId: string;
  /** The recruiter, lowercased email. The join key for per-recruiter voices. */
  email: string;
  /** Workspace user id, when the person is a member (blank for invited-by-email). */
  userId?: string;
  /** Name spoken and shown, e.g. "Sam Wagner". */
  displayName: string;
  status: EnrollmentStatus;
  takes: EnrollmentTake[];
  /** The exact consent wording the recruiter read, stored verbatim. */
  consentStatement?: string;
  /** Take id of the consent read. */
  consentTakeId?: string;
  consentAt?: string;
  /** The minted clone. */
  provider?: VoiceProvider;
  voiceId?: string;
  clonedAt?: string;
  /** The VoiceConsent row this enrollment owns (kept in sync on clone/reset). */
  consentId?: string;
  /** Rendered "hear yourself" line, so the recruiter approves before any dial. */
  previewFile?: string;
  previewAt?: string;
  /** The recruiter listened and approved. Nothing dials in an unapproved voice. */
  approvedAt?: string;
  /** Last clone failure, in plain language. */
  error?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/**
 * The guided script. Roughly 75 seconds total, which is where instant-clone
 * quality plateaus — asking for more is friction that buys nothing, and asking
 * for much less produces the thin, buzzy clone that makes a drop sound synthetic.
 */
export const ENROLLMENT_PROMPTS: EnrollmentPrompt[] = [
  {
    id: "consent",
    title: "1 · Consent",
    text:
      "My name is {name}. I am recording this on {date}. " +
      "I authorize RecruitersOS to create a synthetic copy of my voice, and to use it for business outreach that I authorize, including voicemail messages I approve. " +
      "I confirm this is my own voice and that I am the person speaking.",
    hint:
      "Read it exactly as written, at your normal speaking pace. This take is your consent record and it is kept.",
    targetSec: 20,
    minSec: 10,
    consent: true,
  },
  {
    id: "voicemail",
    title: "2 · A voicemail, the way you leave one",
    text:
      "Hey, it's {first} over at Lume. I saw you're hiring, and I wanted to reach out directly because I came across somebody who honestly made me think of your search. " +
      "I sent you a quick email with a couple of details. If you get a minute to look, let me know what you think and we can go from there. " +
      "Either way, thanks, and I hope the search is going well. Talk soon.",
    hint:
      "This is the one that matters most. Say it like you would to a real person, unhurried, warm. Do not read it like a script.",
    targetSec: 30,
    minSec: 15,
  },
  {
    id: "range",
    title: "3 · Range",
    text:
      "Numbers, names and questions all sit differently in a voice, so this passage covers them. " +
      "We placed a Vice President of Engineering in Charlotte in nineteen days, and two Directors of Finance in Phoenix last quarter. " +
      "Does Thursday at two thirty work, or would sometime early next week be easier? " +
      "Either way, I'll follow up in writing so you have it all in one place.",
    hint:
      "Let the question at the end actually rise. That is what teaches the clone your natural inflection.",
    targetSec: 30,
    minSec: 15,
  },
];

/** Total seconds of audio below which an instant clone reliably sounds thin. */
export const ENROLLMENT_MIN_TOTAL_SEC = 45;
/** Where quality stops improving; the UI stops asking for more past this. */
export const ENROLLMENT_GOOD_TOTAL_SEC = 70;

/** The line a freshly cloned voice speaks back, so the recruiter can approve it. */
export const ENROLLMENT_PREVIEW_LINE =
  "Hey, it's {first}. This is what your voice sounds like on a voicemail drop. " +
  "If this sounds like you, you're ready to go.";

/** How a campaign's voicemail message is built. */
export type VoiceMessageMode = "script" | "recording";

/** Default personalized-intro template for recording-mode drops. */
export const DEFAULT_INTRO =
  "Hi {first_name}. I know you're the {role} at {company}, so I'll keep this quick.";

/** A Voice Drops campaign — the unit of work, in BD or Recruiting. */
export interface VoiceCampaign {
  id: string;
  workspaceId: string;
  motion: Motion;
  name: string;
  /**
   * The recruiter this campaign goes out on behalf of (lowercased email), stamped
   * from the creator. Decides which cloned voice speaks and which recruiter the
   * tracker attributes every outcome to. Absent = the workspace voice.
   */
  ownerEmail?: string;
  status: "draft" | "scheduled" | "running" | "paused" | "done";
  persona: VoicePersona;
  /** Templated VM body ({first_name}/{role}/{company}). */
  scriptTemplate: string;
  /** Library script this template was built from, if any. Stamped onto each drop
   *  so per-script performance can be tallied (see scriptStats). Decoupled from
   *  scriptTemplate so editing the campaign copy doesn't lose the attribution. */
  scriptId?: string;
  /**
   * How the voicemail is built (default "script"):
   *  - script:    the whole message is the cloned-voice TTS of scriptTemplate.
   *  - recording: a short personalized AI intro (introTemplate, cloned voice)
   *               plays first, then the operator's pre-recorded pitch
   *               (recordingId). The intro is cached per unique name/role, so
   *               repeats cost nothing; the recording is never re-synthesized.
   */
  messageMode?: VoiceMessageMode;
  /** The pre-recorded pitch dropped after the intro (messageMode "recording"). */
  recordingId?: string;
  /** Personalized intro template for recording mode ({first_name}/{role}/{company}).
   *  Empty = drop the recording with no intro. */
  introTemplate?: string;
  /**
   * CREDIT-SAVER (default true). Synthesize the fixed prose ONCE and reuse cached
   * name / title / company clips (the archive), stitched into one audio file, so
   * only a NEW first name or job title ever costs ElevenLabs credits. Turn off to
   * render the whole message per lead (needed only when every lead's prose differs
   * — e.g. AI-customize, which bypasses this automatically).
   */
  clipReuse?: boolean;
  /** Cloned voice used to render the drop (operator's consented voice). */
  voiceId?: string;
  /** TTS vendor for voiceId (default elevenlabs). */
  voiceProvider?: VoiceProvider;
  /** Approved 10DLC / Telnyx number dialed FROM (one consistent caller-ID). */
  callerId: string;
  /** Local-time dial window per lead (default 7-9 PM). */
  window: ComplianceWindow;
  /** Max dials per run. */
  dailyCap: number;
  /** Minimum days between attempts to one lead (no rapid re-dialing). */
  frequencyCapDays: number;
  /**
   * TEST MODE: when true, the dial tick ignores the per-lead local-time window
   * (and the unresolved-timezone skip) so a campaign can be exercised end-to-end
   * at any hour. Every OTHER gate still holds — line-type filter, consent
   * attestation, frequency/daily caps, dry-run safety. Off for real campaigns;
   * the loud UI badge exists so it's never left on by accident. */
  testMode?: boolean;
  /**
   * AI CUSTOMIZE: when true, each lead's drop is rewritten per-lead by the LLM
   * drafter (see draft.ts) following the channel window (AMD 15-25s) + the speech
   * and compliance rules, instead of using the one shared scriptTemplate. The
   * script template still seeds the AI's direction. Identification is re-checked
   * on the AI output; if it fails (or the LLM errs) the drop falls back to the
   * templated script, so a missing key never blocks a campaign. Off by default —
   * per-lead scripts are unique, so they synthesize fresh (less cache reuse). */
  aiCustomize?: boolean;
  /**
   * ALWAYS-ON AUTOPILOT: when true this is the workspace's evergreen campaign —
   * leads fed into the system (the email-sent → voice-drop trigger, or an import)
   * are auto-enqueued here and the dial tick keeps sending to due leads with no
   * manual launch. Attesting consent flips it straight to "running" and it stays
   * running. One autopilot campaign per workspace+motion is used as the reactive
   * target; pairs naturally with aiCustomize so each incoming lead gets a fresh,
   * in-window drop. Every compliance gate still applies (consent, window, line
   * filter, caps). */
  autoPilot?: boolean;
  /* ---- compliance gates (all must be satisfied before launch) ---- */
  /** Operator attested a lawful basis (consent / business relationship). */
  consentAttested: boolean;
  consentAttestedBy?: string;
  consentAttestedAt?: string;
  /* ---- rollups ---- */
  leadCount: number;
  filteredMobileCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Input accepted by upsertCampaign (server fills workspace/timestamps/rollups). */
export interface VoiceCampaignInput {
  id?: string;
  motion?: Motion;
  name?: string;
  /** Recruiter this campaign speaks and reports as. Stamped from the creator. */
  ownerEmail?: string;
  status?: VoiceCampaign["status"];
  persona?: Partial<VoicePersona>;
  scriptTemplate?: string;
  scriptId?: string;
  messageMode?: VoiceMessageMode;
  /** "" detaches the recording; absent keeps it; an id (re)sets it. */
  recordingId?: string;
  introTemplate?: string;
  clipReuse?: boolean;
  voiceId?: string;
  voiceProvider?: VoiceProvider;
  callerId?: string;
  window?: Partial<ComplianceWindow>;
  dailyCap?: number;
  frequencyCapDays?: number;
  consentAttested?: boolean;
  testMode?: boolean;
  aiCustomize?: boolean;
  autoPilot?: boolean;
}

/** Defaults applied to a new persona / window when the operator omits them. */
export const DEFAULT_PERSONA: VoicePersona = {
  agentName: "Ryan",
  agentCompany: "Executive Search",
  signoff: "Sorry, wrong number. Thanks.",
};

export const DEFAULT_WINDOW: ComplianceWindow = { startHour: 19, endHour: 21 };
