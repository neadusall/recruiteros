/**
 * RecruiterOS · Voice Drops · Store
 *
 * In-memory reference store + debounced snapshot (SNAP_KEY "voice_drops"),
 * exactly like the billing ledger: survives restarts when DATABASE_URL / a file
 * volume is set, runs purely in-memory otherwise.
 *
 * Holds everything the feature needs: campaigns, their leads, the consented
 * cloned voices, the reusable script library, an append-only drop audit log, and
 * the transient per-call playback plan the voice webhook consults (keyed by
 * Telnyx call_control_id).
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { Motion } from "../core/types";
import {
  type VoiceCampaign, type VoiceCampaignInput, type VoiceLead,
  type VoiceConsent, type VoiceScript, type DropOutcome,
  DEFAULT_PERSONA, DEFAULT_WINDOW,
} from "./types";

/** One queued/active call's playback plan, consulted by the voice webhook. */
export interface PendingDrop {
  callControlId: string;
  campaignId: string;
  leadId: string;
  workspaceId: string;
  motion: Motion;
  /** Ordered segment audio URLs to play onto the voicemail. */
  playlist: string[];
  /** Next segment index to play. */
  idx: number;
  /** Honest sign-off text for the human-answer branch. */
  signoff: string;
  /** Honest identifier text for the human-answer branch. */
  identifier: string;
  /** Count of TTS lines spoken so far on the human-answer branch. */
  spoken?: number;
  createdAt: string;
}

/** One auditable drop attempt. */
export interface DropLog {
  id: string;
  workspaceId: string;
  campaignId: string;
  leadId: string;
  outcome: DropOutcome;
  callControlId?: string;
  at: string;
  meta?: Record<string, unknown>;
}

const store = {
  campaigns: [] as VoiceCampaign[],
  leads: {} as Record<string, VoiceLead[]>,
  consent: [] as VoiceConsent[],
  scripts: [] as VoiceScript[],
  drops: [] as DropLog[],
  pending: {} as Record<string, PendingDrop>,
};

/* ---------------- durability ---------------- */
const SNAP_KEY = "voice_drops";
function serialize() {
  return store;
}
function hydrate(s: any) {
  if (!s) return;
  store.campaigns = s.campaigns ?? [];
  store.leads = s.leads ?? {};
  store.consent = s.consent ?? [];
  store.scripts = s.scripts ?? [];
  store.drops = s.drops ?? [];
  store.pending = s.pending ?? {};
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensureVoiceReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureVoiceReady();

/* ---------------- campaigns ---------------- */

export function listCampaigns(workspaceId: string, motion?: Motion): VoiceCampaign[] {
  return store.campaigns
    .filter((c) => c.workspaceId === workspaceId && (!motion || c.motion === motion))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function getCampaign(workspaceId: string, id: string): VoiceCampaign | undefined {
  return store.campaigns.find((c) => c.workspaceId === workspaceId && c.id === id);
}

/** All running campaigns across every workspace — drives the voice cron tick. */
export function listRunningCampaigns(): VoiceCampaign[] {
  return store.campaigns.filter((c) => c.status === "running");
}

export function upsertCampaign(workspaceId: string, input: VoiceCampaignInput): VoiceCampaign {
  const existing = input.id ? getCampaign(workspaceId, input.id) : undefined;
  const now = nowIso();
  const persona = { ...DEFAULT_PERSONA, ...(existing?.persona ?? {}), ...(input.persona ?? {}) };
  const window = { ...DEFAULT_WINDOW, ...(existing?.window ?? {}), ...(input.window ?? {}) };

  const merged: VoiceCampaign = {
    id: existing?.id ?? rid("vcmp"),
    workspaceId,
    motion: input.motion ?? existing?.motion ?? "recruiting",
    name: input.name ?? existing?.name ?? "Untitled voice campaign",
    status: input.status ?? existing?.status ?? "draft",
    persona,
    scriptTemplate: input.scriptTemplate ?? existing?.scriptTemplate ?? "",
    voiceId: input.voiceId ?? existing?.voiceId,
    voiceProvider: input.voiceProvider ?? existing?.voiceProvider,
    callerId: input.callerId ?? existing?.callerId ?? "",
    window,
    dailyCap: input.dailyCap ?? existing?.dailyCap ?? 100,
    frequencyCapDays: input.frequencyCapDays ?? existing?.frequencyCapDays ?? 30,
    consentAttested: input.consentAttested ?? existing?.consentAttested ?? false,
    testMode: input.testMode ?? existing?.testMode ?? false,
    aiCustomize: input.aiCustomize ?? existing?.aiCustomize ?? false,
    autoPilot: input.autoPilot ?? existing?.autoPilot ?? false,
    consentAttestedBy: existing?.consentAttestedBy,
    consentAttestedAt: existing?.consentAttestedAt,
    leadCount: existing?.leadCount ?? 0,
    filteredMobileCount: existing?.filteredMobileCount ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  // Always-on autopilot: once consent is attested it runs continuously, so a lead
  // fed in is dialed on the next tick without a manual launch.
  if (merged.autoPilot && merged.consentAttested && merged.status !== "paused" && merged.status !== "done") {
    merged.status = "running";
  }
  if (existing) {
    Object.assign(existing, merged);
  } else {
    store.campaigns.push(merged);
  }
  persist();
  return existing ?? merged;
}

/** Record the consent attestation that gates launch. */
export function attestConsent(workspaceId: string, id: string, by: string): VoiceCampaign | undefined {
  const c = getCampaign(workspaceId, id);
  if (!c) return undefined;
  c.consentAttested = true;
  c.consentAttestedBy = by;
  c.consentAttestedAt = nowIso();
  // Autopilot starts sending the moment it has a lawful basis — no manual launch.
  if (c.autoPilot && c.status !== "paused" && c.status !== "done") c.status = "running";
  c.updatedAt = nowIso();
  persist();
  return c;
}

/**
 * The workspace's always-on autopilot campaign for a motion — the reactive
 * target for leads fed in when no campaign is named explicitly. Prefers a
 * consent-attested one (only those can actually dial).
 */
export function findAutoPilot(workspaceId: string, motion?: Motion): VoiceCampaign | undefined {
  const all = store.campaigns.filter(
    (c) => c.workspaceId === workspaceId && c.autoPilot && c.status !== "done" && (!motion || c.motion === motion),
  );
  return all.find((c) => c.consentAttested) ?? all[0];
}

export function deleteCampaign(workspaceId: string, id: string): boolean {
  const before = store.campaigns.length;
  store.campaigns = store.campaigns.filter((c) => !(c.workspaceId === workspaceId && c.id === id));
  delete store.leads[id];
  persist();
  return store.campaigns.length < before;
}

/* ---------------- leads ---------------- */

export function setLeads(workspaceId: string, campaignId: string, leads: VoiceLead[]): void {
  store.leads[campaignId] = leads;
  const c = getCampaign(workspaceId, campaignId);
  if (c) {
    c.leadCount = leads.filter((l) => l.outcome !== "filtered_mobile").length;
    c.filteredMobileCount = leads.filter((l) => l.outcome === "filtered_mobile").length;
    c.updatedAt = nowIso();
  }
  persist();
}

export function getLeads(campaignId: string): VoiceLead[] {
  return store.leads[campaignId] ?? [];
}

export function updateLead(campaignId: string, leadId: string, patch: Partial<VoiceLead>): VoiceLead | undefined {
  const lead = (store.leads[campaignId] ?? []).find((l) => l.id === leadId);
  if (!lead) return undefined;
  Object.assign(lead, patch);
  persist();
  return lead;
}

/**
 * Append a single lead to a campaign and refresh its rollups — used by the
 * reactive email-sent → voice-drop trigger, which adds leads one at a time
 * (importLeads replaces the whole list, which would clobber an active campaign).
 */
export function addLead(workspaceId: string, campaignId: string, lead: VoiceLead): void {
  const arr = store.leads[campaignId] ?? (store.leads[campaignId] = []);
  arr.push(lead);
  const c = getCampaign(workspaceId, campaignId);
  if (c) {
    c.leadCount = arr.filter((l) => l.outcome !== "filtered_mobile").length;
    c.filteredMobileCount = arr.filter((l) => l.outcome === "filtered_mobile").length;
    c.updatedAt = nowIso();
  }
  persist();
}

/** Find an existing lead in a campaign by prospect link or phone (dedup guard). */
export function findLead(campaignId: string, match: { prospectId?: string; phone?: string }): VoiceLead | undefined {
  const digits = (p?: string) => (p ?? "").replace(/\D/g, "");
  const wantPhone = digits(match.phone);
  return (store.leads[campaignId] ?? []).find((l) =>
    (match.prospectId !== undefined && l.prospectId === match.prospectId) ||
    (wantPhone !== "" && digits(l.phone) === wantPhone),
  );
}

/* ---------------- consent (cloned voices) ---------------- */

export function listConsent(workspaceId: string): VoiceConsent[] {
  return store.consent.filter((c) => c.workspaceId === workspaceId);
}

export function upsertConsent(workspaceId: string, input: Partial<VoiceConsent> & { agentName: string; statement: string; attestedBy: string }): VoiceConsent {
  const existing = input.id ? store.consent.find((c) => c.id === input.id && c.workspaceId === workspaceId) : undefined;
  const rec: VoiceConsent = {
    id: existing?.id ?? rid("vcon"),
    workspaceId,
    agentName: input.agentName,
    provider: input.provider ?? existing?.provider,
    voiceId: input.voiceId ?? existing?.voiceId,
    consentClipUrl: input.consentClipUrl ?? existing?.consentClipUrl,
    statement: input.statement,
    attestedBy: input.attestedBy,
    attestedAt: existing?.attestedAt ?? nowIso(),
  };
  if (existing) Object.assign(existing, rec);
  else store.consent.push(rec);
  persist();
  return existing ?? rec;
}

/** Remove a saved voice (consent record) from a workspace. Returns true if one was removed. */
export function deleteConsent(workspaceId: string, id: string): boolean {
  const idx = store.consent.findIndex((c) => c.id === id && c.workspaceId === workspaceId);
  if (idx === -1) return false;
  store.consent.splice(idx, 1);
  persist();
  return true;
}

/* ---------------- script library ---------------- */

export function listScripts(workspaceId: string, motion?: Motion): VoiceScript[] {
  return store.scripts
    .filter((s) => s.workspaceId === workspaceId && (!motion || s.motion === motion))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function upsertScript(workspaceId: string, input: Partial<VoiceScript> & { name: string; template: string }): VoiceScript {
  const existing = input.id ? store.scripts.find((s) => s.id === input.id && s.workspaceId === workspaceId) : undefined;
  const now = nowIso();
  const rec: VoiceScript = {
    id: existing?.id ?? rid("vscr"),
    workspaceId,
    motion: input.motion ?? existing?.motion ?? "recruiting",
    name: input.name,
    template: input.template,
    voiceId: input.voiceId ?? existing?.voiceId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, rec);
  else store.scripts.push(rec);
  persist();
  return existing ?? rec;
}

export function deleteScript(workspaceId: string, id: string): boolean {
  const before = store.scripts.length;
  store.scripts = store.scripts.filter((s) => !(s.workspaceId === workspaceId && s.id === id));
  persist();
  return store.scripts.length < before;
}

/* ---------------- drop audit log ---------------- */

export function recordDrop(log: Omit<DropLog, "id" | "at">): DropLog {
  const rec: DropLog = { id: rid("vdrp"), at: nowIso(), ...log };
  store.drops.push(rec);
  persist();
  return rec;
}

export function listDrops(workspaceId: string, campaignId?: string, limit = 200): DropLog[] {
  return store.drops
    .filter((d) => d.workspaceId === workspaceId && (!campaignId || d.campaignId === campaignId))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

/** Outcome tallies for a campaign (drives the UI rollup + progress). */
export function campaignStats(campaignId: string): Record<DropOutcome, number> {
  const base: Record<DropOutcome, number> = {
    queued: 0, scheduled: 0, dialing: 0, voicemail_delivered: 0,
    human_answered: 0, no_answer: 0, failed: 0, filtered_mobile: 0, suppressed: 0,
  };
  for (const l of getLeads(campaignId)) base[l.outcome] = (base[l.outcome] ?? 0) + 1;
  return base;
}

/* ---------------- pending per-call playback plan ---------------- */

export function registerPending(p: Omit<PendingDrop, "createdAt">): void {
  store.pending[p.callControlId] = { ...p, createdAt: nowIso() };
  persist();
}

export function getPending(callControlId: string): PendingDrop | undefined {
  return store.pending[callControlId];
}

/** Advance to and return the next segment URL, or null when the playlist is done. */
export function advancePending(callControlId: string): string | null {
  const p = store.pending[callControlId];
  if (!p) return null;
  if (p.idx >= p.playlist.length) return null;
  const url = p.playlist[p.idx];
  p.idx += 1;
  persist();
  return url;
}

export function clearPending(callControlId: string): void {
  delete store.pending[callControlId];
  persist();
}

/** Increment and return the count of TTS lines spoken on the human-answer branch. */
export function nextSpoken(callControlId: string): number {
  const p = store.pending[callControlId];
  if (!p) return 0;
  p.spoken = (p.spoken ?? 0) + 1;
  persist();
  return p.spoken;
}

/** Dev/tests only. */
export function devVoiceStore() {
  return store;
}
