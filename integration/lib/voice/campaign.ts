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
import { withWorkspaceCreds } from "../connected";
import { classifyLine } from "../signals/phoneClassify";
import { recordUsage } from "../billing/ledger";
import { rateCost } from "../billing/rates";
import type { Motion } from "../core/types";

import { segmentScript, renderScript, checkScript, identifierLine, type MergeVars } from "./script";
import { assembleDrop } from "./clones";
import { getVoiceClient } from "./provider";
import { checkWindow, resolveTimezone } from "./compliance";
import {
  getCampaign, getLeads, setLeads, updateLead, recordDrop, registerPending,
  getPending, clearPending,
} from "./store";
import type { VoiceCampaign, VoiceLead, DropOutcome } from "./types";

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
}
function connectionId(): string {
  return process.env.TELNYX_CONNECTION_ID ?? "";
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
    const phone = (r.phone || "").trim();
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

  const client = getVoiceClient();
  const leads = getLeads(campaignId);

  for (const lead of leads) {
    if (lead.outcome === "filtered_mobile") { sum.filtered++; continue; }
    if (!eligible(lead, c.frequencyCapDays, at)) { sum.skipped++; continue; }
    if (sum.dialed >= c.dailyCap) break;

    const win = checkWindow(lead.location, c.window, at);
    lead.timezone = win.timezone ?? lead.timezone;
    if (!win.allowed) {
      updateLead(campaignId, lead.id, { outcome: "scheduled", timezone: lead.timezone });
      if (win.reason === "no_timezone") sum.skipped++; else sum.scheduled++;
      continue;
    }

    // Assemble the personalized voicemail (cache-aware: identical names/roles/
    // static prose are reused at zero cost).
    const vars: MergeVars = { firstName: lead.firstName, role: lead.role, company: lead.company };
    // A per-lead custom script (the weekly wave's unique voicemail) overrides the
    // campaign template, so each wave's drop is different; otherwise use the template.
    const segments = segmentScript(lead.customScript || c.scriptTemplate, vars, c.persona);
    const drop = await assembleDrop(segments, c.voiceId, client);
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
      telnyx.dialWithAmd(lead.phone, connectionId(), `${appUrl()}/api/voice/webhook`, {
        workspaceId, motion: c.motion, campaignId, leadId: lead.id, ref: lead.prospectId,
      }),
    );
    if (res?.dryRun) sum.dryRun = true;
    const ccid = res?.data?.call_control_id ?? `dry_${rid("call")}`;

    registerPending({
      callControlId: ccid, campaignId, leadId: lead.id, workspaceId, motion: c.motion,
      playlist: drop.playlist, idx: 0,
      signoff: c.persona.signoff,
      identifier: identifierLine(c.persona, lead.firstName),
    });
    updateLead(campaignId, lead.id, {
      outcome: "dialing", attempts: lead.attempts + 1, lastAttemptAt: nowIso(), callControlId: ccid,
    });
    recordDrop({ workspaceId, campaignId, leadId: lead.id, outcome: "dialing", callControlId: ccid, meta: { dryRun: Boolean(res?.dryRun) } });
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
}

/**
 * Fire a single personalized drop to a number the operator controls, to verify
 * the whole path end to end. Skips the window check (it's a manual test to your
 * own line) but still classifies, assembles, and dials exactly like production.
 */
export async function testDrop(workspaceId: string, motion: Motion, input: TestDropInput) {
  const client = getVoiceClient();
  const vars: MergeVars = { firstName: input.firstName, role: input.role, company: input.company };
  const rendered = renderScript(input.scriptTemplate, vars, input.persona);
  const chk = checkScript(rendered, input.persona);

  const segments = segmentScript(input.scriptTemplate, vars, input.persona);
  const drop = await assembleDrop(segments, input.voiceId, client);

  const res: any = await withWorkspaceCreds(workspaceId, () =>
    telnyx.dialWithAmd(input.to, connectionId(), `${appUrl()}/api/voice/webhook`, {
      workspaceId, motion, test: true,
    }),
  );
  const ccid = res?.data?.call_control_id ?? `dry_${rid("call")}`;
  registerPending({
    callControlId: ccid, campaignId: "test", leadId: "test", workspaceId, motion,
    playlist: drop.playlist, idx: 0,
    signoff: input.persona.signoff,
    identifier: identifierLine(input.persona, input.firstName),
  });

  return {
    ok: true,
    callControlId: ccid,
    dryRun: Boolean(res?.dryRun) || drop.dryRun,
    rendered,
    estSeconds: chk.seconds,
    withinSweetSpot: chk.withinSweetSpot,
    warnings: chk.warnings,
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
  const { workspaceId, campaignId, leadId, motion } = pending;

  if (campaignId !== "test") {
    updateLead(campaignId, leadId, { outcome });
    recordDrop({ workspaceId, campaignId, leadId, outcome, callControlId, meta });

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
