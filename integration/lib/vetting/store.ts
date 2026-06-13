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
  DEFAULT_PERSONA, DEFAULT_PASS_THRESHOLD,
} from "./types";

const store = {
  desks: [] as VettingDesk[],
  candidates: [] as CandidateProfile[],
  calls: [] as VettingCall[],
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
    roleTitle: input.roleTitle ?? existing?.roleTitle ?? "",
    clientCompany: input.clientCompany ?? existing?.clientCompany,
    questions: normalizeQuestions(input.questions, existing?.questions ?? []),
    nextStepQualified: input.nextStepQualified ?? existing?.nextStepQualified ??
      "I think you could be a strong fit. Here's the next step: I'm going to send over the full job description, and I'd love for you to put together an updated resume that focuses on the things we just talked about and tailors it to this role. Once I have that back, I'll walk it through with the hiring team.",
    nextStepUnqualified: input.nextStepUnqualified ?? existing?.nextStepUnqualified ??
      "I really appreciate you walking me through your background. Being straight with you, I don't think this particular role is the right fit overall — but your experience is genuinely strong, and I'd like to keep you in mind for other roles that line up better with what you've built. I'll hold onto your details and reach back out when something that fits comes across my desk.",
    persona,
    voiceId: input.voiceId ?? existing?.voiceId,
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
