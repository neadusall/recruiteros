/**
 * RecruiterOS · Voice Drops · Orchestration
 *
 * The engine that ties the pieces together:
 *  - import:  classify every number via Telnyx, FILTER OUT mobiles/toll-free
 *             (never dialed), resolve each lead's timezone.
 *  - launch:  enforce the compliance gates (consent attestation, caller-ID,
 *             consented voice, identifying script) before a campaign can run.
 *  - run:     for each eligible lead, only when it's inside THAT lead's local
 *             window, assemble the personalized voicemail (cache-aware) and dial
 *             with Premium AMD. The webhook decides human vs machine.
 *  - record:  turn a webhook outcome into an auditable drop + an ATS person_event.
 *
 * Dry-run safe end to end: with no Telnyx / clone keys nothing is dialed or
 * billed, but every step runs so the UI and flow are verifiable.
 */

import { nowIso, rid } from "../core/ids";
import { getCore } from "../core/repository";
import { telnyx } from "../providers";
import { cred } from "../providers/http";
import { withWorkspaceCreds } from "../connected";
import { classifyLine } from "../signals/phoneClassify";
import { recordUsage } from "../billing/ledger";
import { rateCost } from "../billing/rates";
import type { Motion } from "../core/types";

import { segmentScript, renderScript, checkScript, identifierLine, type MergeVars } from "./script";
import { draftVoiceScript } from "./draft";
import { assembleDrop, type VoiceRef } from "./clones";
import { getVoiceClientFor } from "./provider";
import { checkWindow, resolveTimezone, type WindowCheck } from "./compliance";
import { toE164 } from "./phone";
import {
  getCampaign, getLeads, setLeads, updateLead, recordDrop, registerPending,
  getPending, clearPending, listConsent,
} from "./store";

/**
 * Pick which voice (provider + id) to synthesize a campaign/test in: an explicit
 * voiceId wins; otherwise fall back to the workspace's most recently saved voice
 * (bring-your-own ElevenLabs/Cartesia id); otherwise empty, so the provider's
 * env default voice is used. Provider routing happens inside assembleDrop.
 */
function resolveVoiceRef(workspaceId: string, voiceId?: string, voiceProvider?: VoiceRef["provider"]): VoiceRef {
  if (voiceId) return { provider: voiceProvider, voiceId };
  const saved = listConsent(workspaceId).filter((v) => v.voiceId);
  const latest = saved[saved.length - 1];
  if (latest) return { provider: latest.provider, voiceId: latest.voiceId };
  return {};
}
import type { VoiceCampaign, VoiceLead, DropOutcome } from "./types";

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
}
function connectionId(): string {
  // Resolved inside the per-lead withWorkspaceCreds() wrap below, so a customer
  // dials on their own Telnyx connection, not the house env one.
  return cred("TELNYX_CONNECTION_ID");
}

/* ---------------- import + mobile strip ---------------- */

export interface RawLead {
  firstName?: string;
  fullName?: string;
  role?: string;
  company?: string;
  phone: string;
  location?: string;
  prospectId?: string;
}

export interface ImportSummary {
  imported: number;
  dialable: number;       // landline / voip
  filteredMobile: number; // mobiles + toll-free (never dialed)
  unknownLine: number;
  noTimezone: number;     // dialable but location unresolved (won't dial until fixed)
}

/**
 * Import leads into a campaign, classifying each number and stripping mobiles.
 * Mobiles/toll-free are KEPT in the list (for transparency) but flagged
 * `filtered_mobile` so they can never be dialed.
 */
export async function importLeads(
  workspaceId: string, motion: Motion, campaignId: string, raw: RawLead[],
): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, dialable: 0, filteredMobile: 0, unknownLine: 0, noTimezone: 0 };
  const leads: VoiceLead[] = [];

  for (const r of raw) {
    // Coerce to E.164 at the boundary so everything stored/classified/dialed
    // downstream is "+14792740716"-shaped and Telnyx never rejects it.
    const phone = toE164(r.phone || "");
    if (!phone) continue;
    const cls = await classifyLine(phone, { workspaceId, motion });
    const lineType = cls.lineType;
    const isDialable = lineType === "landline" || lineType === "voip";
    const tz = resolveTimezone(r.location);

    const lead: VoiceLead = {
      id: rid("vled"),
      firstName: (r.firstName || r.fullName?.split(/\s+/)[0] || "").trim(),
      fullName: r.fullName,
      role: r.role,
      company: r.company,
      phone,
      lineType,
      location: r.location,
      timezone: tz,
      outcome: isDialable ? "queued" : "filtered_mobile",
      attempts: 0,
      prospectId: r.prospectId,
    };
    leads.push(lead);

    summary.imported++;
    if (lineType === "mobile" || lineType === "toll_free") summary.filteredMobile++;
    else if (isDialable) { summary.dialable++; if (!tz) summary.noTimezone++; }
    else summary.unknownLine++;
  }

  setLeads(workspaceId, campaignId, leads);
  return summary;
}

/* ---------------- launch gating ---------------- */

export interface LaunchCheck {
  ok: boolean;
  errors: string[];
}

/** All compliance gates that must pass before a campaign can dial. */
export function checkLaunch(c: VoiceCampaign): LaunchCheck {
  const errors: string[] = [];
  if (!c.consentAttested) errors.push("Consent attestation required before launch.");
  if (!c.callerId) errors.push("Select an approved 10DLC caller-ID number.");
  if (!c.scriptTemplate.trim()) errors.push("Write a voicemail script.");
  else {
    const rendered = renderScript(c.scriptTemplate, { firstName: "there", role: "leader" }, c.persona);
    const chk = checkScript(rendered, c.persona);
    if (!chk.identifies) errors.push("Script must identify you or your firm by name.");
  }
  if (!(c.voiceId || process.env.VOICE_CLONE_VOICE_ID)) {
    errors.push("Select a consented cloned voice (or set a default voice).");
  }
  const dialable = getLeads(c.id).filter((l) => l.outcome !== "filtered_mobile").length;
  if (dialable === 0) errors.push("No dialable landline/VoIP leads imported.");
  return { ok: errors.length === 0, errors };
}

/* ---------------- the dial tick ---------------- */

export interface RunSummary {
  dialed: number;
  scheduled: number;     // eligible but outside the local window right now
  skipped: number;       // frequency-capped / no timezone
  filtered: number;      // mobiles, never dialed
  synthesized: number;   // billable cache-miss renders this run
  cached: number;        // free cache hits
  dryRun: boolean;
}

function eligible(lead: VoiceLead, freqDays: number, now: Date): boolean {
  if (lead.outcome === "filtered_mobile" || lead.outcome === "suppressed") return false;
  if (lead.outcome === "voicemail_delivered" || lead.outcome === "human_answered") return false;
  if (lead.outcome === "dialing") return false;
  if (lead.lastAttemptAt) {
    const days = (now.getTime() - Date.parse(lead.lastAttemptAt)) / 86_400_000;
    if (days < freqDays) return false; // frequency cap: no rapid re-dial
  }
  return true;
}

/**
 * Run one tick of a campaign: dial every eligible lead that is CURRENTLY inside
 * its own local window, up to the daily cap. Leads outside their window are
 * marked `scheduled` (they'll dial on a later tick). Idempotent and safe to call
 * repeatedly (e.g. from a cron every 15 min during the evening window).
 */
export async function runDueDrops(
  workspaceId: string, campaignId: string, at: Date = new Date(),
): Promise<RunSummary> {
  const c = getCampaign(workspaceId, campaignId);
  const sum: RunSummary = { dialed: 0, scheduled: 0, skipped: 0, filtered: 0, synthesized: 0, cached: 0, dryRun: false };
  if (!c || c.status === "paused") return sum;

  const voice = resolveVoiceRef(workspaceId, c.voiceId, c.voiceProvider);
  const client = getVoiceClientFor(voice.provider);
  const leads = getLeads(campaignId);

  for (const lead of leads) {
    if (lead.outcome === "filtered_mobile") { sum.filtered++; continue; }
    if (!eligible(lead, c.frequencyCapDays, at)) { sum.skipped++; continue; }
    if (sum.dialed >= c.dailyCap) break;

    // Test mode dials regardless of the clock (and regardless of an unresolved
    // timezone) so the queue can be drained on demand while testing. Every other
    // gate above/below still applies. Real campaigns leave this off.
    const win: WindowCheck = c.testMode
      ? { allowed: true, timezone: lead.timezone, localHour: -1 }
      : checkWindow(lead.location, c.window, at);
    lead.timezone = win.timezone ?? lead.timezone;
    if (!win.allowed) {
      updateLead(campaignId, lead.id, { outcome: "scheduled", timezone: lead.timezone });
      if (win.reason === "no_timezone") sum.skipped++; else sum.scheduled++;
      continue;
    }

    // Assemble the personalized voicemail (cache-aware: identical names/roles/
    // static prose are reused at zero cost).
    const vars: MergeVars = { firstName: lead.firstName, role: lead.role, company: lead.company };
    // Script selection, in priority order:
    //  1) a per-lead custom script (a weekly wave's unique voicemail), else
    //  2) an AI-customized per-lead script when the campaign opts in — draft.ts
    //     enforces the 15-25s AMD window + the speech/compliance rules, seeded by
    //     the campaign template. Identification is re-checked; a failure (or any
    //     LLM error) falls back to the template, so it can never block a drop, else
    //  3) the shared campaign template.
    let scriptText = lead.customScript || c.scriptTemplate;
    if (!lead.customScript && c.aiCustomize) {
      try {
        const ai = await withWorkspaceCreds(workspaceId, () =>
          draftVoiceScript({
            channel: "amd", persona: c.persona, vars, templated: false, seed: c.scriptTemplate,
            context: [lead.role ? `role: ${lead.role}` : "", lead.company ? `company: ${lead.company}` : ""].filter(Boolean).join(", ") || undefined,
          }),
        );
        if (ai.text && ai.identifies) scriptText = ai.text; // keep honest identification
      } catch { /* fall back to the template */ }
    }
    const segments = segmentScript(scriptText, vars, c.persona);
    const drop = await assembleDrop(segments, voice);
    sum.synthesized += drop.synthesized;
    sum.cached += drop.cached;
    if (drop.dryRun) sum.dryRun = true;

    // Meter only the billable cache-miss synthesis (cache hits cost $0).
    if (drop.synthesized > 0) {
      recordUsage({
        workspaceId, motion: c.motion, category: "ai", type: "voice_clone_synthesis",
        source: client.id, quantity: drop.synthesized, unitCostUsd: rateCost("voice_clone_synthesis"),
        meta: { campaignId, leadId: lead.id },
      });
    }

    // Dial with Premium AMD; the webhook plays the playlist onto the voicemail.
    // Isolation: a customer's drops dial through their own Telnyx, not the house env.
    const res: any = await withWorkspaceCreds(workspaceId, () =>
      telnyx.dialWithAmd(toE164(lead.phone), connectionId(), `${appUrl()}/api/voice/webhook`, {
        workspaceId, motion: c.motion, campaignId, leadId: lead.id, ref: lead.prospectId,
      }),
    );
    if (res?.dryRun) sum.dryRun = true;
    const ccid = res?.data?.call_control_id ?? `dry_${rid("call")}`;

    // Attribute this drop to the library script it was built from, so per-script
    // performance can be tallied once the outcome lands. A per-lead customScript
    // or an AI rewrite is not one of the named library scripts, so it carries no
    // scriptId — only the shared campaign template does.
    const dropScriptId = (!lead.customScript && !c.aiCustomize) ? c.scriptId : undefined;

    registerPending({
      callControlId: ccid, campaignId, leadId: lead.id, workspaceId, motion: c.motion,
      playlist: drop.playlist, idx: 0,
      signoff: c.persona.signoff,
      identifier: identifierLine(c.persona, lead.firstName),
      scriptId: dropScriptId,
    });
    updateLead(campaignId, lead.id, {
      outcome: "dialing", attempts: lead.attempts + 1, lastAttemptAt: nowIso(), callControlId: ccid,
    });
    recordDrop({ workspaceId, campaignId, leadId: lead.id, outcome: "dialing", callControlId: ccid, meta: { dryRun: Boolean(res?.dryRun), scriptId: dropScriptId } });
    sum.dialed++;
  }

  if (c.status === "draft" || c.status === "scheduled") c.status = "running";
  return sum;
}

/* ---------------- single test drop ---------------- */

export interface TestDropInput {
  to: string;
  firstName?: string;
  role?: string;
  company?: string;
  scriptTemplate: string;
  persona: VoiceCampaign["persona"];
  voiceId?: string;
  voiceProvider?: VoiceRef["provider"];
}

/**
 * Fire a single personalized drop to a number the operator controls, to verify
 * the whole path end to end. Skips the window check (it's a manual test to your
 * own line) but still classifies, assembles, and dials exactly like production.
 */
export async function testDrop(workspaceId: string, motion: Motion, input: TestDropInput) {
  const voice = resolveVoiceRef(workspaceId, input.voiceId, input.voiceProvider);
  const vars: MergeVars = { firstName: input.firstName, role: input.role, company: input.company };
  const rendered = renderScript(input.scriptTemplate, vars, input.persona);
  const chk = checkScript(rendered, input.persona);
  const warnings = [...chk.warnings];

  // Assemble the cloned-voice playlist. A synthesis failure (bad voice id, clone
  // quota, provider 4xx) must NOT abort the test — we still want to show the
  // rendered script and dial the honest identifier. Degrade to a dry playlist and
  // tell the operator exactly what failed.
  const segments = segmentScript(input.scriptTemplate, vars, input.persona);
  let drop: Awaited<ReturnType<typeof assembleDrop>>;
  try {
    drop = await assembleDrop(segments, voice);
  } catch (e: any) {
    warnings.push(`Voice synthesis failed (${e?.message || "error"}); dialed without the cloned drop.`);
    drop = { playlist: [], synthesized: 0, cached: 0, dryRun: true };
  }

  // Dial. A Telnyx error here is reported, not thrown, so the operator sees the
  // script rendered fine and knows precisely which leg failed.
  let res: any = { dryRun: true };
  let dialError: string | undefined;
  try {
    res = await withWorkspaceCreds(workspaceId, () =>
      telnyx.dialWithAmd(toE164(input.to), connectionId(), `${appUrl()}/api/voice/webhook`, {
        workspaceId, motion, test: true,
      }),
    );
  } catch (e: any) {
    // Surfaced as the first-class `dialError` field (rendered distinctly by the
    // UI), so it's NOT also pushed into `warnings` — that would double it.
    dialError = e?.message || "dial failed";
  }

  const ccid = res?.data?.call_control_id ?? `dry_${rid("call")}`;
  registerPending({
    callControlId: ccid, campaignId: "test", leadId: "test", workspaceId, motion,
    playlist: drop.playlist, idx: 0,
    signoff: input.persona.signoff,
    identifier: identifierLine(input.persona, input.firstName),
  });

  // Distinguish the three dial outcomes so the UI never says "nothing dialed"
  // about a call it actually attempted and Telnyx rejected:
  //   dialed  = a real call went out (have a call_control_id)
  //   dryRun  = provider unconfigured, nothing was attempted (a clean no-op)
  //   failed  = a real attempt was made and errored (dialError carries why)
  const dialDryRun = Boolean(res?.dryRun) && !dialError;
  const dialed = !dialDryRun && !dialError;

  return {
    ok: true,
    callControlId: ccid,
    dialed,
    // dryRun reflects ONLY the dial now (was the call a genuine no-op?), not the
    // clone-synthesis path — a missing clone key still lets the dial be real.
    dryRun: dialDryRun,
    cloneDryRun: drop.dryRun,
    dialError,
    rendered,
    estSeconds: chk.seconds,
    withinSweetSpot: chk.withinSweetSpot,
    warnings,
    playlistLength: drop.playlist.length,
    synthesized: drop.synthesized,
    cached: drop.cached,
  };
}

/* ---------------- outcome recording (called by the webhook) ---------------- */

/**
 * Record a terminal AMD outcome against the lead + audit log + ATS timeline.
 * `voicemail_delivered` is set ONLY when the personalized playlist actually
 * played to completion on a machine.
 */
export async function recordOutcome(callControlId: string, outcome: DropOutcome, meta?: Record<string, unknown>): Promise<void> {
  const pending = getPending(callControlId);
  if (!pending) return;
  const { workspaceId, campaignId, leadId, motion, scriptId } = pending;

  if (campaignId !== "test") {
    updateLead(campaignId, leadId, { outcome });
    // Carry the script attribution onto the terminal outcome so scriptStats can
    // tally delivery/connect rates per library script.
    recordDrop({ workspaceId, campaignId, leadId, outcome, callControlId, meta: { ...meta, scriptId } });

    // Mirror to the ATS person timeline when the lead links to a Prospect.
    const lead = getLeads(campaignId).find((l) => l.id === leadId);
    if (lead?.prospectId) {
      const summary = outcome === "voicemail_delivered"
        ? `Voice drop delivered to voicemail (${motion})`
        : `Voice drop: ${outcome.replace(/_/g, " ")}`;
      await getCore().recordActivity({
        id: rid("act"), workspaceId, prospectId: lead.prospectId,
        channel: "voice", type: `voice_drop_${outcome}`, summary, at: nowIso(),
      }).catch(() => {});
    }
  }
}
