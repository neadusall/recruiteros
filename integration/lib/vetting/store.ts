/**
 * RecruitersOS · AI Vetting · Store
 *
 * In-memory reference store + debounced snapshot (SNAP_KEY "ai_vetting"), the
 * same durability contract as Voice Drops and the billing ledger: survives
 * restarts when DATABASE_URL / a file volume is set, runs purely in-memory
 * otherwise.
 *
 * Holds desks (JD<->number bindings), opted-in candidate profiles, and the
 * inbound call log with its scored analysis. Two lookups are load-bearing for
 * the live phone path and MUST stay O(1)-ish:
 *   - findDeskByNumber(e164)         -> which desk is being called
 *   - findCandidate(deskId, phone)   -> who is calling (matched by caller ID)
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { Motion } from "../core/types";
import {
  type VettingDesk, type VettingDeskInput, type CandidateProfile,
  type CandidateEnrichment, type VettingCall, type QualifyingQuestion,
  type ResumeReview, type DeskLearning, type PromptRevision, type VoiceTuning, type SimRun,
  type TurnTuning, type ExtractionField, type InboxState, type InboxLogEntry,
  type DeskQA, type QACluster, type CallQuestion, type KnowledgeItem,
  type ResumeChase, type ChaseStep, type ClientReport,
  type ScreenSchedule, type ScheduleStep, type DeskMsgTemplate,
  MSG_TEMPLATE_CAP,
  DEFAULT_PERSONA, DEFAULT_PASS_THRESHOLD, DEFAULT_LEARNING, DEFAULT_DESK_QA, KNOWLEDGE_CAP,
  clampVoiceTuning, clampTurnTuning,
  normalizeExtraction, normalizeKnowledge,
} from "./types";

const store = {
  desks: [] as VettingDesk[],
  candidates: [] as CandidateProfile[],
  calls: [] as VettingCall[],
  resumeReviews: [] as ResumeReview[],
  /** Resume-inbox sweep state, keyed by workspace id. */
  inbox: {} as Record<string, InboxState>,
  /** Saved next-step messages for the desk form's dropdowns. */
  msgTemplates: [] as DeskMsgTemplate[],
};

/* ---------------- durability ---------------- */
const SNAP_KEY = "ai_vetting";
function serialize() {
  return store;
}
function hydrate(s: any) {
  if (!s) return;
  store.desks = s.desks ?? [];
  store.candidates = s.candidates ?? [];
  store.calls = s.calls ?? [];
  store.resumeReviews = s.resumeReviews ?? [];
  store.inbox = s.inbox ?? {};
  store.msgTemplates = s.msgTemplates ?? [];
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensureVettingReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureVettingReady();

/* ---------------- helpers ---------------- */

/** Strip a phone to digits (keep a leading country code) for stable matching. */
export function phoneDigits(p?: string): string {
  return (p ?? "").replace(/\D/g, "");
}

/** Compare two numbers by their last 10 digits (tolerates +1 / 1 prefixes). */
function sameNumber(a?: string, b?: string): boolean {
  const da = phoneDigits(a), db = phoneDigits(b);
  if (!da || !db) return false;
  return da === db || da.slice(-10) === db.slice(-10);
}

function normalizeQuestions(
  input: Array<Partial<QualifyingQuestion> & { prompt: string; passCriteria: string }> | undefined,
  existing: QualifyingQuestion[],
): QualifyingQuestion[] {
  if (!input) return existing;
  // Top 3-4 only: the agent must stay conversational, not interrogate.
  return input.slice(0, 4).map((q) => ({
    id: q.id ?? rid("vq"),
    prompt: String(q.prompt).trim(),
    passCriteria: String(q.passCriteria).trim(),
    mustHave: Boolean(q.mustHave),
  }));
}

/* ---------------- desks ---------------- */

export function listDesks(workspaceId: string, motion?: Motion): VettingDesk[] {
  return store.desks
    .filter((d) => d.workspaceId === workspaceId && (!motion || d.motion === motion))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function getDesk(workspaceId: string, id: string): VettingDesk | undefined {
  return store.desks.find((d) => d.workspaceId === workspaceId && d.id === id);
}

/** Resolve which desk an inbound call is FOR, by the dialed number. */
export function findDeskByNumber(e164: string): VettingDesk | undefined {
  return store.desks.find((d) => d.phoneNumber && sameNumber(d.phoneNumber, e164));
}

export function getDeskById(id: string): VettingDesk | undefined {
  return store.desks.find((d) => d.id === id);
}

/** Every workspace that has at least one vetting desk (the inbox tick's fan-out). */
export function listVettingWorkspaceIds(): string[] {
  return Array.from(new Set(store.desks.map((d) => d.workspaceId)));
}

export function upsertDesk(workspaceId: string, input: VettingDeskInput): VettingDesk {
  const existing = input.id ? getDesk(workspaceId, input.id) : undefined;
  const now = nowIso();
  const persona = { ...DEFAULT_PERSONA, ...(existing?.persona ?? {}), ...(input.persona ?? {}) };

  const merged: VettingDesk = {
    id: existing?.id ?? rid("vdesk"),
    workspaceId,
    motion: input.motion ?? existing?.motion ?? "recruiting",
    name: input.name ?? existing?.name ?? "Untitled vetting desk",
    status: existing?.status ?? "draft",
    jobDescription: input.jobDescription ?? existing?.jobDescription ?? "",
    jdId: input.jdId ?? existing?.jdId,
    roleTitle: input.roleTitle ?? existing?.roleTitle ?? "",
    clientCompany: input.clientCompany ?? existing?.clientCompany,
    questions: normalizeQuestions(input.questions, existing?.questions ?? []),
    nextStepQualified: input.nextStepQualified ?? existing?.nextStepQualified ??
      "I think you could be a strong fit, and here's exactly what happens next: everything we covered goes to the recruiter today, and the one thing I need from you is your updated resume, tailored to what we just talked about. You'll get a text and an email from me right after this call with where to send it. The moment it's in, I walk it through with the hiring side.",
    nextStepUnqualified: input.nextStepUnqualified ?? existing?.nextStepUnqualified ??
      "I really appreciate you walking me through your background. Being straight with you, I don't think this particular role is the right overall fit, but your experience is genuinely strong. Send me your updated resume anyway: I'd like to have it in hand so when the right role crosses my desk, and it will, you're the first call I make. You'll get a text and an email from me with where to send it.",
    persona,
    voiceId: input.voiceId ?? existing?.voiceId,
    extraction: input.extraction ? normalizeExtraction(input.extraction) : existing?.extraction,
    knowledge: input.knowledge ? normalizeKnowledge(input.knowledge) : existing?.knowledge,
    bookingUrl: input.bookingUrl !== undefined ? input.bookingUrl.trim() : existing?.bookingUrl,
    transferNumber: input.transferNumber !== undefined ? input.transferNumber.trim() : existing?.transferNumber,
    phoneNumber: input.phoneNumber ?? existing?.phoneNumber,
    assistantId: existing?.assistantId,
    syncedAt: existing?.syncedAt,
    passThreshold: input.passThreshold ?? existing?.passThreshold ?? DEFAULT_PASS_THRESHOLD,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, merged);
  else store.desks.push(merged);
  persist();
  return existing ?? merged;
}

/** Record the engine binding after a successful (or dry-run) provisioning. */
export function markDeskSynced(workspaceId: string, id: string, patch: { assistantId?: string; phoneNumber?: string; status?: VettingDesk["status"] }): VettingDesk | undefined {
  const d = getDesk(workspaceId, id);
  if (!d) return undefined;
  if (patch.assistantId !== undefined) d.assistantId = patch.assistantId;
  if (patch.phoneNumber !== undefined) d.phoneNumber = patch.phoneNumber;
  if (patch.status) d.status = patch.status;
  d.syncedAt = nowIso();
  d.updatedAt = nowIso();
  persist();
  return d;
}

export function setDeskStatus(workspaceId: string, id: string, status: VettingDesk["status"]): VettingDesk | undefined {
  const d = getDesk(workspaceId, id);
  if (!d) return undefined;
  d.status = status;
  d.updatedAt = nowIso();
  persist();
  return d;
}

export function deleteDesk(workspaceId: string, id: string): boolean {
  const before = store.desks.length;
  store.desks = store.desks.filter((d) => !(d.workspaceId === workspaceId && d.id === id));
  persist();
  return store.desks.length < before;
}

/* ---------------- learning loop (voice tuning + prompt revisions) ----------------
   The optimizer's durable state lives ON the desk so it snapshots with everything
   else. All mutations funnel through here so version numbers stay monotonic and
   the applied addendum (learnedNotes) always mirrors exactly one revision. */

/** The desk's learning state, defaulted in place so callers never null-check. */
export function deskLearning(d: VettingDesk): DeskLearning {
  if (!d.learning) d.learning = { ...DEFAULT_LEARNING, revisions: [] };
  return d.learning;
}

/** Save voice-delivery tuning (clamped). Caller re-provisions if the desk is live. */
export function setDeskVoiceTuning(workspaceId: string, id: string, tuning: Partial<VoiceTuning>): VettingDesk | undefined {
  const d = getDesk(workspaceId, id);
  if (!d) return undefined;
  d.voiceTuning = clampVoiceTuning({ ...(d.voiceTuning ?? {}), ...tuning });
  d.updatedAt = nowIso();
  persist();
  return d;
}

/** Save conversation-feel tuning (clamped). Caller re-provisions if live. */
export function setDeskTurnTuning(workspaceId: string, id: string, tuning: Partial<TurnTuning>): VettingDesk | undefined {
  const d = getDesk(workspaceId, id);
  if (!d) return undefined;
  d.turnTuning = clampTurnTuning({ ...(d.turnTuning ?? {}), ...tuning });
  d.updatedAt = nowIso();
  persist();
  return d;
}

/** Flip auto-learn / cadence for a desk. */
export function setDeskAutoLearn(workspaceId: string, id: string, autoLearn: boolean, minCallsBetweenRuns?: number): VettingDesk | undefined {
  const d = getDesk(workspaceId, id);
  if (!d) return undefined;
  const l = deskLearning(d);
  l.autoLearn = autoLearn;
  if (minCallsBetweenRuns && minCallsBetweenRuns >= 1) l.minCallsBetweenRuns = Math.min(20, Math.round(minCallsBetweenRuns));
  d.updatedAt = nowIso();
  persist();
  return d;
}

/** Record a new revision (proposed or already applied), stamping its version. */
export function addRevision(
  d: VettingDesk,
  rev: Omit<PromptRevision, "id" | "version" | "createdAt">,
): PromptRevision {
  const l = deskLearning(d);
  const rec: PromptRevision = {
    ...rev,
    id: rid("vrev"),
    version: l.nextVersion,
    createdAt: nowIso(),
  };
  l.nextVersion += 1;
  l.revisions.unshift(rec);
  // Keep the history readable: cap at 20, never dropping the applied one.
  if (l.revisions.length > 20) {
    const applied = l.revisions.find((r) => r.status === "applied");
    l.revisions = l.revisions.slice(0, 20);
    if (applied && !l.revisions.includes(applied)) l.revisions.push(applied);
  }
  l.lastRunAt = rec.createdAt;
  l.callsSinceLastRun = 0;
  d.updatedAt = nowIso();
  persist();
  return rec;
}

/**
 * Make one revision the desk's applied learning: its notes become the prompt
 * addendum, its tuning (if any) becomes the live voice tuning, and whichever
 * revision was applied before is marked reverted.
 */
export function applyRevision(d: VettingDesk, revisionId: string): PromptRevision | undefined {
  const l = deskLearning(d);
  const rev = l.revisions.find((r) => r.id === revisionId);
  if (!rev) return undefined;
  for (const r of l.revisions) if (r.status === "applied" && r.id !== rev.id) r.status = "reverted";
  rev.status = "applied";
  rev.appliedAt = nowIso();
  l.learnedNotes = rev.styleNotes;
  if (rev.voiceTuning) d.voiceTuning = clampVoiceTuning(rev.voiceTuning);
  d.updatedAt = nowIso();
  persist();
  return rev;
}

/** Drop back to factory behavior: no addendum, revision left in history. */
export function clearAppliedRevision(d: VettingDesk): void {
  const l = deskLearning(d);
  for (const r of l.revisions) if (r.status === "applied") r.status = "reverted";
  l.learnedNotes = "";
  d.updatedAt = nowIso();
  persist();
}

/** Persist the most recent simulation run on the desk. */
export function setLastSimulation(d: VettingDesk, run: SimRun): void {
  const l = deskLearning(d);
  // Transcripts are quoted in results; trim each to keep the snapshot lean.
  l.lastSimulation = {
    ...run,
    results: run.results.map((r) => ({ ...r, transcript: r.transcript.slice(0, 20) })),
  };
  d.updatedAt = nowIso();
  persist();
}

/** Count a newly scored call toward the auto-learn trigger. */
export function bumpLearningCounter(d: VettingDesk): number {
  const l = deskLearning(d);
  l.callsSinceLastRun += 1;
  persist();
  return l.callsSinceLastRun;
}

/* ---------------- question intelligence (self-learning candidate Q&A) ----------------
   Candidate questions harvested off each call roll up here into per-desk topic
   clusters. All mutations funnel through these so counts stay honest and an
   approved answer always maps to exactly one KnowledgeItem the agent runs on. */

/** The desk's question-intelligence state, defaulted in place. */
export function deskQA(d: VettingDesk): DeskQA {
  if (!d.qa) d.qa = { ...DEFAULT_DESK_QA, clusters: [] };
  return d.qa;
}

/** Flip the desk's question-learning switches. */
export function setDeskQASettings(
  workspaceId: string, id: string,
  patch: { autoTeach?: boolean; textBack?: boolean },
): VettingDesk | undefined {
  const d = getDesk(workspaceId, id);
  if (!d) return undefined;
  const qa = deskQA(d);
  if (typeof patch.autoTeach === "boolean") qa.autoTeach = patch.autoTeach;
  if (typeof patch.textBack === "boolean") qa.textBack = patch.textBack;
  d.updatedAt = nowIso();
  persist();
  return d;
}

/** Case-insensitive topic match so "401k Match" and "401k match" cluster together. */
function sameTopic(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Merge one call's harvested questions into the desk's clusters. Idempotent per
 * call (a call already recorded in a cluster's asks is never double-counted).
 */
export function recordCallQuestions(d: VettingDesk, call: VettingCall, questions: CallQuestion[]): QACluster[] {
  const qa = deskQA(d);
  const now = nowIso();
  const touched: QACluster[] = [];

  for (const q of questions) {
    const topic = q.topic.trim().slice(0, 80);
    const text = q.question.trim().slice(0, 200);
    if (!topic || !text) continue;

    let cluster = qa.clusters.find((c) => sameTopic(c.topic, topic) && c.status !== "dismissed");
    if (!cluster) {
      cluster = {
        id: rid("vqa"),
        topic,
        canonicalQuestion: text,
        variants: [],
        askCount: 0,
        answeredCount: 0,
        deferredCount: 0,
        status: "open",
        asks: [],
        firstAskedAt: now,
        lastAskedAt: now,
      };
      qa.clusters.push(cluster);
    }

    // Never double-count the same call re-harvested into the same cluster.
    if (cluster.asks.some((a) => a.callId === call.id)) continue;

    cluster.askCount += 1;
    qa.totalAsked += 1;
    if (q.outcome === "answered") cluster.answeredCount += 1;
    else cluster.deferredCount += 1;
    cluster.lastAskedAt = now;
    if (!cluster.variants.some((v) => v.toLowerCase() === text.toLowerCase())) {
      cluster.variants = [...cluster.variants, text].slice(-6);
    }
    cluster.asks.unshift({
      callId: call.id,
      candidateId: call.candidateId,
      phone: call.callerPhone && call.callerPhone !== "unknown" ? call.callerPhone : undefined,
      at: now,
      question: text,
    });
    cluster.asks = cluster.asks.slice(0, 30);
    touched.push(cluster);
  }

  // Keep the board readable: cap clusters, dropping the oldest dismissed first,
  // then the oldest single-ask open ones. Approved clusters are never dropped.
  if (qa.clusters.length > 60) {
    const keep = new Set<QACluster>(qa.clusters.filter((c) => c.status === "approved"));
    const rest = qa.clusters
      .filter((c) => !keep.has(c))
      .sort((a, b) => (b.askCount - a.askCount) || Date.parse(b.lastAskedAt) - Date.parse(a.lastAskedAt));
    qa.clusters = [...keep, ...rest].slice(0, 60);
  }

  qa.lastHarvestAt = now;
  d.updatedAt = now;
  persist();
  return touched;
}

/** Save a drafted answer on a cluster (grounded = safe to auto-teach). */
export function setQADraft(d: VettingDesk, clusterId: string, draftAnswer: string, grounded: boolean): QACluster | undefined {
  const c = deskQA(d).clusters.find((x) => x.id === clusterId);
  if (!c) return undefined;
  c.draftAnswer = draftAnswer.trim().slice(0, 400);
  c.draftGrounded = grounded;
  c.draftedAt = nowIso();
  d.updatedAt = nowIso();
  persist();
  return c;
}

/**
 * Teach the agent: the cluster's answer becomes a desk FAQ fact. Returns the
 * new KnowledgeItem, or undefined when the cluster is missing / the answer is
 * blank / the FAQ is at capacity (caller surfaces that as a clean error).
 */
export function approveQACluster(d: VettingDesk, clusterId: string, answer: string): { cluster: QACluster; item: KnowledgeItem } | undefined {
  const c = deskQA(d).clusters.find((x) => x.id === clusterId);
  const text = (answer || "").trim().slice(0, 400);
  if (!c || !text) return undefined;

  const knowledge = normalizeKnowledge(d.knowledge);
  // Re-approving an already-taught cluster updates its existing fact in place.
  const existing = c.approvedKnowledgeId ? knowledge.find((k) => k.id === c.approvedKnowledgeId) : undefined;
  if (!existing && knowledge.length >= KNOWLEDGE_CAP) return undefined;

  const item: KnowledgeItem = existing ?? { id: rid("kn"), question: c.canonicalQuestion.slice(0, 160), answer: text };
  item.answer = text;
  if (!existing) knowledge.push(item);
  d.knowledge = knowledge;

  c.status = "approved";
  c.approvedAnswer = text;
  c.approvedKnowledgeId = item.id;
  c.approvedAt = nowIso();
  d.updatedAt = nowIso();
  persist();
  return { cluster: c, item };
}

/** Recruiter decided this topic doesn't need teaching. */
export function dismissQACluster(d: VettingDesk, clusterId: string): QACluster | undefined {
  const c = deskQA(d).clusters.find((x) => x.id === clusterId);
  if (!c) return undefined;
  c.status = "dismissed";
  c.dismissedAt = nowIso();
  d.updatedAt = nowIso();
  persist();
  return c;
}

/** Stamp that the approved answer was texted back to one asker. */
export function markQAAnswerTexted(d: VettingDesk, clusterId: string, callId: string): void {
  const c = deskQA(d).clusters.find((x) => x.id === clusterId);
  const ask = c?.asks.find((a) => a.callId === callId);
  if (!ask) return;
  ask.answerTextedAt = nowIso();
  persist();
}

/* ---------------- candidate profiles (opt-in form) ---------------- */

export function listCandidates(workspaceId: string, deskId?: string): CandidateProfile[] {
  return store.candidates
    .filter((c) => c.workspaceId === workspaceId && (!deskId || c.deskId === deskId))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Find the opted-in caller for a desk by their phone (caller-ID match). */
export function findCandidate(deskId: string, phone: string): CandidateProfile | undefined {
  return store.candidates.find((c) => c.deskId === deskId && sameNumber(c.phone, phone));
}

/** Fetch a candidate by id (used by the scorer to pull their LinkedIn background). */
export function getCandidateById(id: string): CandidateProfile | undefined {
  return store.candidates.find((c) => c.id === id);
}

/**
 * Upsert a candidate from an opt-in submission. Dedupes per desk by phone so a
 * candidate who re-submits updates their record instead of creating a twin.
 */
export function upsertCandidate(
  workspaceId: string,
  input: { deskId: string; firstName: string; lastName: string; phone: string; email: string; linkedinUrl?: string },
): CandidateProfile {
  const existing = findCandidate(input.deskId, input.phone);
  const now = nowIso();
  const rec: CandidateProfile = {
    id: existing?.id ?? rid("vcand"),
    workspaceId,
    deskId: input.deskId,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    phone: input.phone.trim(),
    phoneDigits: phoneDigits(input.phone),
    email: input.email.trim(),
    linkedinUrl: input.linkedinUrl?.trim() || existing?.linkedinUrl,
    enrichment: existing?.enrichment,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, rec);
  else store.candidates.push(rec);
  persist();
  return existing ?? rec;
}

export function setCandidateEnrichment(candidateId: string, enrichment: CandidateEnrichment): void {
  const c = store.candidates.find((x) => x.id === candidateId);
  if (!c) return;
  c.enrichment = enrichment;
  c.updatedAt = nowIso();
  persist();
}

/** Stash the latest resume text the candidate submitted (for the coaching loop). */
export function setCandidateResume(
  candidateId: string,
  resumeText: string,
  meta?: { source?: CandidateProfile["resumeSource"]; fileName?: string },
): void {
  const c = store.candidates.find((x) => x.id === candidateId);
  if (!c) return;
  c.resumeText = resumeText;
  c.resumeUpdatedAt = nowIso();
  if (meta?.source) c.resumeSource = meta.source;
  if (meta?.fileName !== undefined) c.resumeFileName = meta.fileName;
  c.updatedAt = nowIso();
  // The resume is THE artifact the chase ladder exists for: the moment it
  // lands, every active chase on this candidate stops and any held client
  // intro draft is cleared for review.
  settleResumeArrival(candidateId);
  persist();
}

/* ---------------- resume chase + client report (per-call state) ---------------- */

/** Attach or replace a call's chase state. */
export function setCallChase(callId: string, chase: ResumeChase): VettingCall | undefined {
  return updateCall(callId, { chase });
}

/** Append one send attempt to a call's chase ladder. */
export function addChaseStep(callId: string, step: ChaseStep): void {
  const c = store.calls.find((x) => x.id === callId);
  if (!c?.chase) return;
  c.chase.steps.push(step);
  persist();
}

/** Every call still actively chasing a resume, across all workspaces (ticker fan-out). */
export function listActiveChaseCalls(): VettingCall[] {
  return store.calls.filter((c) => c.chase?.status === "active");
}

/**
 * The updated resume arrived for this candidate: stop every active chase on
 * their calls and flip any held client draft from "awaiting_resume" to "ready".
 * Pure data pass (no sends), safe to run from any write path; persist() is the
 * caller's job.
 */
function settleResumeArrival(candidateId: string): void {
  const now = nowIso();
  for (const call of store.calls) {
    if (call.candidateId !== candidateId) continue;
    if (call.chase?.status === "active") {
      call.chase.status = "completed";
      call.chase.resumeReceivedAt = now;
    }
    if (call.clientReport?.status === "awaiting_resume") {
      call.clientReport.status = "ready";
    }
  }
}

/** Store (or replace) a call's client working summary + intro draft. */
export function setClientReport(callId: string, report: ClientReport): VettingCall | undefined {
  return updateCall(callId, { clientReport: report });
}

/** Mark the client intro as sent (by us or by hand), stamping who it went to. */
export function markClientReportSent(workspaceId: string, callId: string, sentTo?: string): VettingCall | undefined {
  const c = getCall(workspaceId, callId);
  if (!c?.clientReport) return undefined;
  c.clientReport.status = "sent";
  c.clientReport.sentAt = nowIso();
  if (sentTo) c.clientReport.sentTo = sentTo;
  persist();
  return c;
}

/* ---------------- self-scheduling (the availability loop) ---------------- */

/** Attach or replace a candidate's scheduling state. */
export function setCandidateScreen(candidateId: string, screen: ScreenSchedule): CandidateProfile | undefined {
  const c = store.candidates.find((x) => x.id === candidateId);
  if (!c) return undefined;
  c.screen = screen;
  c.updatedAt = nowIso();
  persist();
  return c;
}

/** Append one event to a candidate's scheduling conversation log (capped). */
export function addScreenStep(candidateId: string, step: ScheduleStep): void {
  const c = store.candidates.find((x) => x.id === candidateId);
  if (!c?.screen) return;
  c.screen.steps.push(step);
  if (c.screen.steps.length > 30) c.screen.steps = c.screen.steps.slice(-30);
  c.updatedAt = nowIso();
  persist();
}

/** Every candidate with a live scheduling loop, across all workspaces (ticker fan-out). */
export function listActiveScheduleCandidates(): CandidateProfile[] {
  return store.candidates.filter((c) =>
    c.screen && ["awaiting_reply", "clarify", "booked"].includes(c.screen.status));
}

/** Workspace-wide phone match (an inbound text may not name a desk's candidate). */
export function findCandidateByPhone(workspaceId: string, phone: string): CandidateProfile | undefined {
  return store.candidates.find((c) => c.workspaceId === workspaceId && sameNumber(c.phone, phone));
}

/** Stamp that the post-resume screening invite went out to this candidate. */
export function markScreenInviteSent(candidateId: string): void {
  const c = store.candidates.find((x) => x.id === candidateId);
  if (!c) return;
  c.screenInviteSentAt = nowIso();
  c.updatedAt = nowIso();
  persist();
}

/* ---------------- resume inbox (email intake) ---------------- */

/** The workspace's resume-inbox sweep state, defaulted in place. */
export function inboxState(workspaceId: string): InboxState {
  if (!store.inbox[workspaceId]) store.inbox[workspaceId] = { savedTotal: 0, log: [] };
  return store.inbox[workspaceId];
}

/** Record one sweep's outcomes (newest first, log capped at 50). */
export function recordInboxSweep(workspaceId: string, entries: InboxLogEntry[], error?: string): InboxState {
  const s = inboxState(workspaceId);
  s.lastSweepAt = nowIso();
  s.lastError = error;
  if (entries.length) {
    s.savedTotal += entries.filter((e) => e.outcome === "saved").length;
    s.log = [...entries, ...s.log].slice(0, 50);
  }
  persist();
  return s;
}

/* ---------------- reusable next-step messages ---------------- */

/** This workspace's saved messages, newest first, optionally one kind only. */
export function listMsgTemplates(
  workspaceId: string,
  kind?: DeskMsgTemplate["kind"],
): DeskMsgTemplate[] {
  return store.msgTemplates
    .filter((t) => t.workspaceId === workspaceId && (!kind || t.kind === kind))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Save a message for reuse. Same-name saves within a kind overwrite (that's
 * how a recruiter edits a template: insert, tweak, save under the same name).
 */
export function addMsgTemplate(
  workspaceId: string,
  input: { kind: DeskMsgTemplate["kind"]; name: string; text: string },
): DeskMsgTemplate {
  const name = input.name.trim().slice(0, 60);
  const existing = store.msgTemplates.find(
    (t) => t.workspaceId === workspaceId && t.kind === input.kind &&
      t.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    existing.text = input.text.trim();
    persist();
    return existing;
  }
  const t: DeskMsgTemplate = {
    id: rid("vmsg"),
    workspaceId,
    kind: input.kind,
    name,
    text: input.text.trim(),
    createdAt: nowIso(),
  };
  store.msgTemplates.push(t);
  // Cap per workspace: drop the oldest beyond the cap so the list stays usable.
  const mine = listMsgTemplates(workspaceId);
  if (mine.length > MSG_TEMPLATE_CAP) {
    const cut = new Set(mine.slice(MSG_TEMPLATE_CAP).map((x) => x.id));
    store.msgTemplates = store.msgTemplates.filter((x) => !cut.has(x.id));
  }
  persist();
  return t;
}

export function deleteMsgTemplate(workspaceId: string, id: string): boolean {
  const before = store.msgTemplates.length;
  store.msgTemplates = store.msgTemplates.filter(
    (t) => !(t.workspaceId === workspaceId && t.id === id),
  );
  const removed = store.msgTemplates.length < before;
  if (removed) persist();
  return removed;
}

/* ---------------- resume coaching loop ---------------- */

/** All coaching rounds for a candidate, newest first. */
export function listResumeReviews(candidateId: string): ResumeReview[] {
  return store.resumeReviews
    .filter((r) => r.candidateId === candidateId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The most recent coaching round for a candidate, if any. */
export function latestResumeReview(candidateId: string): ResumeReview | undefined {
  return listResumeReviews(candidateId)[0];
}

/**
 * Record one coaching round. `round` auto-increments from the candidate's prior
 * submissions so the loop is self-numbering.
 */
export function addResumeReview(
  input: Omit<ResumeReview, "id" | "round" | "createdAt">,
): ResumeReview {
  const priorRounds = store.resumeReviews.filter(
    (r) => r.candidateId === input.candidateId && r.deskId === input.deskId,
  ).length;
  const rec: ResumeReview = {
    ...input,
    id: rid("vrev"),
    round: priorRounds + 1,
    createdAt: nowIso(),
  };
  store.resumeReviews.push(rec);
  persist();
  return rec;
}

/** Mark a review's coaching email as actually delivered. */
export function markReviewEmailSent(reviewId: string): void {
  const r = store.resumeReviews.find((x) => x.id === reviewId);
  if (!r) return;
  r.emailSent = true;
  persist();
}

/* ---------------- calls ---------------- */

export function listCalls(workspaceId: string, deskId?: string, limit = 200): VettingCall[] {
  return store.calls
    .filter((c) => c.workspaceId === workspaceId && (!deskId || c.deskId === deskId))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}

export function getCall(workspaceId: string, id: string): VettingCall | undefined {
  return store.calls.find((c) => c.workspaceId === workspaceId && c.id === id);
}

/** Find a call by the engine's call id (used by the post-call webhook). */
export function findCallByEngineId(engineCallId: string): VettingCall | undefined {
  return store.calls.find((c) => c.engineCallId === engineCallId);
}

/** Fetch a call by id alone (server-side jobs that already know the desk). */
export function getCallById(id: string): VettingCall | undefined {
  return store.calls.find((c) => c.id === id);
}

/** Create the call record when an inbound leg starts (or arrives post-hoc). */
export function createCall(input: {
  workspaceId: string; deskId: string; candidateId?: string;
  callerName?: string; callerPhone: string; engineCallId?: string;
}): VettingCall {
  const rec: VettingCall = {
    id: rid("vcall"),
    workspaceId: input.workspaceId,
    deskId: input.deskId,
    candidateId: input.candidateId,
    callerName: input.callerName,
    callerPhone: input.callerPhone,
    status: "ringing",
    engineCallId: input.engineCallId,
    transcript: [],
    startedAt: nowIso(),
  };
  store.calls.push(rec);
  persist();
  return rec;
}

export function updateCall(id: string, patch: Partial<VettingCall>): VettingCall | undefined {
  const c = store.calls.find((x) => x.id === id);
  if (!c) return undefined;
  Object.assign(c, patch);
  persist();
  return c;
}

/** Dev/tests only. */
export function devVettingStore() {
  return store;
}
