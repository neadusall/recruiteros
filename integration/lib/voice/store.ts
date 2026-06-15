/**
 * RecruitersOS · Voice Drops · Store
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
import { toE164 } from "./phone";
import type { Motion } from "../core/types";
import {
  type VoiceCampaign, type VoiceCampaignInput, type VoiceLead,
  type VoiceConsent, type VoiceScript, type DropOutcome, type VoiceSettings,
  DEFAULT_PERSONA, DEFAULT_WINDOW,
} from "./types";
import { DEFAULT_VOICE_SCRIPTS } from "./seedScripts";
import type { VoiceProvider } from "./provider";

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
  /** Library script this drop was built from, carried through to the terminal
   *  outcome so per-script performance can be tallied (see scriptStats). */
  scriptId?: string;
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
  /** Per-workspace settings (the chosen active voice/engine). */
  settings: {} as Record<string, VoiceSettings>,
  /** Workspaces whose default scripts have been seeded (so a deleted seed
   *  is not resurrected on the next read). */
  seeded: {} as Record<string, boolean>,
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
  store.settings = s.settings ?? {};
  store.seeded = s.seeded ?? {};
  // One-time backfill: any lead persisted before E.164 normalization existed
  // (stored as "479-274-0716" etc.) is coerced in place so it dials cleanly.
  // toE164("") on a junk number returns "", so guard: keep the original if
  // normalization can't produce a real number, rather than blanking it.
  for (const arr of Object.values(store.leads)) {
    for (const lead of arr) {
      const e164 = toE164(lead.phone);
      if (e164 && e164 !== lead.phone) lead.phone = e164;
    }
  }
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
    // An explicit "" detaches attribution (the script was hand-edited away from the
    // named library script); absent keeps the existing link; an id (re)sets it.
    scriptId: input.scriptId === "" ? undefined : (input.scriptId ?? existing?.scriptId),
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
  // Normalize at this ingestion path too (signal->lead feeds, dedup, etc.) so a
  // lead added outside importLeads is still stored as "+14792740716".
  const e164 = toE164(lead.phone);
  if (e164) lead.phone = e164;
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
  // Pin the very first voice a workspace adds as its active engine, so there is
  // always a defined voice + provider for tests/sends the moment one exists (the
  // operator can switch either later). Only auto-pins when nothing is set yet.
  const settings = store.settings[workspaceId] ?? (store.settings[workspaceId] = {});
  if (rec.voiceId) {
    if (!settings.activeVoiceId) settings.activeVoiceId = rec.id;
    if (!settings.activeProvider) settings.activeProvider = rec.provider ?? "elevenlabs";
  }
  persist();
  return existing ?? rec;
}

/** Remove a saved voice (consent record) from a workspace. Returns true if one was removed. */
export function deleteConsent(workspaceId: string, id: string): boolean {
  const idx = store.consent.findIndex((c) => c.id === id && c.workspaceId === workspaceId);
  if (idx === -1) return false;
  store.consent.splice(idx, 1);
  // If the deleted voice was the active engine, re-point to another saved voice
  // (most recent) so "active" never dangles at a voice that no longer exists.
  const settings = store.settings[workspaceId];
  if (settings && settings.activeVoiceId === id) {
    const remaining = store.consent.filter((c) => c.workspaceId === workspaceId && c.voiceId);
    settings.activeVoiceId = remaining.length ? remaining[remaining.length - 1].id : undefined;
  }
  persist();
  return true;
}

/* ---------------- per-workspace voice settings (active engine) ---------------- */

/** The workspace's Voice Drops settings (chosen active voice/engine). */
export function getVoiceSettings(workspaceId: string): VoiceSettings {
  return store.settings[workspaceId] ?? {};
}

/**
 * The active voice for a workspace — the one explicitly chosen for tests AND
 * sends. Resolves the stored consent id to its record; returns undefined if none
 * is set or the referenced voice was removed.
 */
export function getActiveVoice(workspaceId: string): VoiceConsent | undefined {
  const id = store.settings[workspaceId]?.activeVoiceId;
  if (!id) return undefined;
  return store.consent.find((c) => c.id === id && c.workspaceId === workspaceId);
}

/**
 * Set (or clear) the active voice for a workspace by consent id. Pass undefined
 * to clear. Picking a specific voice also flips the active PROVIDER to that
 * voice's vendor, so the prominent engine selector always reflects reality.
 * Returns the resolved active voice, or undefined when cleared/unknown.
 */
export function setActiveVoice(workspaceId: string, id: string | undefined): VoiceConsent | undefined {
  const settings = store.settings[workspaceId] ?? (store.settings[workspaceId] = {});
  if (!id) { settings.activeVoiceId = undefined; persist(); return undefined; }
  const voice = store.consent.find((c) => c.id === id && c.workspaceId === workspaceId);
  if (!voice) return undefined; // ignore unknown id — never pin a voice that isn't there
  settings.activeVoiceId = id;
  settings.activeProvider = voice.provider ?? "elevenlabs";
  persist();
  return voice;
}

/**
 * Pick the active TTS engine (provider) for a workspace — the prominent choice.
 * Re-points the pinned voice to one belonging to that provider (most recent), or
 * clears it so the resolver falls back to that provider's most-recent/env voice.
 * Pass undefined to clear the engine choice entirely.
 */
export function setActiveProvider(workspaceId: string, provider: VoiceProvider | undefined): VoiceSettings {
  const settings = store.settings[workspaceId] ?? (store.settings[workspaceId] = {});
  settings.activeProvider = provider;
  if (provider) {
    const current = settings.activeVoiceId
      ? store.consent.find((c) => c.id === settings.activeVoiceId && c.workspaceId === workspaceId)
      : undefined;
    if (!current || (current.provider ?? "elevenlabs") !== provider) {
      const forProvider = store.consent.filter(
        (c) => c.workspaceId === workspaceId && c.voiceId && (c.provider ?? "elevenlabs") === provider,
      );
      settings.activeVoiceId = forProvider.length ? forProvider[forProvider.length - 1].id : undefined;
    }
  }
  persist();
  return settings;
}

/**
 * The provider + voiceId a drop should synthesize in, honoring the workspace's
 * chosen engine. THE single source of truth shared by the test drop, the
 * "Listen first" preview, and live campaign sends, so they never diverge:
 *   1. chosen active PROVIDER → its pinned voice (if it matches), else that
 *      provider's most-recent saved voice, else the provider with its env voice;
 *   2. no provider chosen → the pinned active voice;
 *   3. else the most recently saved voice;
 *   4. else empty (the env default provider + voice).
 */
export function activeVoiceRef(workspaceId: string): { provider?: VoiceProvider; voiceId?: string } {
  const settings = store.settings[workspaceId] ?? {};
  const consent = store.consent.filter((c) => c.workspaceId === workspaceId && c.voiceId);
  const pinned = settings.activeVoiceId ? consent.find((c) => c.id === settings.activeVoiceId) : undefined;

  if (settings.activeProvider) {
    if (pinned && (pinned.provider ?? "elevenlabs") === settings.activeProvider) {
      return { provider: settings.activeProvider, voiceId: pinned.voiceId };
    }
    const forProvider = consent.filter((c) => (c.provider ?? "elevenlabs") === settings.activeProvider);
    const latest = forProvider[forProvider.length - 1];
    return latest ? { provider: settings.activeProvider, voiceId: latest.voiceId } : { provider: settings.activeProvider };
  }

  if (pinned) return { provider: pinned.provider, voiceId: pinned.voiceId };
  const latest = consent[consent.length - 1];
  if (latest) return { provider: latest.provider, voiceId: latest.voiceId };
  return {};
}

/* ---------------- script library ---------------- */

/**
 * Seed a workspace's script library with the default natural-speech voicemail
 * scripts (see seedScripts.ts) the first time it is read. Idempotent: gated by a
 * per-workspace marker so a default the operator deletes is not resurrected, and
 * an id that already exists is never duplicated. Seeds insert as ordinary rows,
 * so they are editable/deletable/attributable like any hand-written script.
 */
export function ensureSeedScripts(workspaceId: string): void {
  if (store.seeded[workspaceId]) return;
  const now = nowIso();
  for (const seed of DEFAULT_VOICE_SCRIPTS) {
    if (store.scripts.some((s) => s.id === seed.id && s.workspaceId === workspaceId)) continue;
    store.scripts.push({
      id: seed.id, workspaceId, motion: seed.motion, name: seed.name,
      template: seed.template, createdAt: now, updatedAt: now,
    });
  }
  store.seeded[workspaceId] = true;
  persist();
}

export function listScripts(workspaceId: string, motion?: Motion): VoiceScript[] {
  ensureSeedScripts(workspaceId);
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

/** Per-script outcome tally — the "learn from responses" rollup. */
export interface ScriptPerformance {
  /** Real dial attempts that reached a phone (delivered + answered + no-answer). */
  dialed: number;
  voicemail_delivered: number;
  human_answered: number;
  no_answer: number;
  failed: number;
  /** voicemail_delivered / dialed, 0-1 (0 when nothing dialed yet). */
  deliveryRate: number;
  /** (voicemail_delivered + human_answered) / dialed, 0-1 — reached a contact. */
  connectRate: number;
}

/**
 * Tally terminal drop outcomes per library script, across a workspace. Drops are
 * stamped with the script they were built from (meta.scriptId) at dial time, so
 * this answers "which script gets picked up / lands a voicemail most often" —
 * the signal the operator uses to keep the winner and retire the rest. Only
 * terminal, billable-dial outcomes count; "dialing"/"queued" rows are ignored.
 */
export function scriptStats(workspaceId: string): Record<string, ScriptPerformance> {
  const out: Record<string, ScriptPerformance> = {};
  const blank = (): ScriptPerformance => ({
    dialed: 0, voicemail_delivered: 0, human_answered: 0, no_answer: 0,
    failed: 0, deliveryRate: 0, connectRate: 0,
  });
  for (const d of store.drops) {
    if (d.workspaceId !== workspaceId) continue;
    const sid = typeof d.meta?.scriptId === "string" ? d.meta.scriptId : undefined;
    if (!sid) continue;
    const p = (out[sid] ??= blank());
    if (d.outcome === "voicemail_delivered") { p.voicemail_delivered++; p.dialed++; }
    else if (d.outcome === "human_answered") { p.human_answered++; p.dialed++; }
    else if (d.outcome === "no_answer") { p.no_answer++; p.dialed++; }
    else if (d.outcome === "failed") { p.failed++; }
  }
  for (const p of Object.values(out)) {
    p.deliveryRate = p.dialed ? p.voicemail_delivered / p.dialed : 0;
    p.connectRate = p.dialed ? (p.voicemail_delivered + p.human_answered) / p.dialed : 0;
  }
  return out;
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
