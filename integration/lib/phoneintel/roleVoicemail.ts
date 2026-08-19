/**
 * RecruitersOS · Phone Intelligence · Role-voicemail bridge (Pipeline → drop)
 *
 * The automation that closes the loop: after we EMAIL a pipeline prospect about
 * their open role, take that same prospect's CORPORATE phone number, navigate the
 * switchboard to reach the person (Phone Intelligence), and leave a voicemail
 * ABOUT THE SAME ROLE we just emailed them about. Voice runs alongside email, on
 * the same target, with the same message.
 *
 * How it composes what already exists:
 *  - The pipeline is read through the platform repository (getCore().listProspects).
 *  - The role we speak to is the prospect's `discoveryRole` — "the seat this
 *    decision-maker owns", i.e. the open role the outreach email named — falling
 *    back to their title.
 *  - The voicemail is assembled with the CREDIT-SAVER splice engine, so only the
 *    first name + role are ever new clips; everything else is synthesized once.
 *  - The prospect is enqueued into the human-gated Phone Intel queue with that
 *    pre-assembled message attached (voicemailUrl). Nothing dials until an admin
 *    presses Start; the call then navigates to the person and drops the message
 *    (orchestrator Phase 2), inside every existing compliance gate.
 *
 * Two entry points: a batch PULL (enqueue every eligible emailed prospect) and a
 * single-prospect enqueue for the reactive email-sent trigger.
 */

import { getCore } from "../core/repository";
import { withWorkspaceCreds } from "../connected";
import { toE164 } from "../voice/phone";
import {
  activeVoiceRef, spliceSegments, assembleSplicedDrop, DEFAULT_PERSONA,
  type VoicePersona,
} from "../voice";
import { ensureQueueReady, enqueue, hasQueued } from "./queue";
import type { Prospect, Motion } from "../core/types";

/**
 * The default role voicemail. Only {first_name} and {role} vary lead-to-lead, so
 * the splice engine keeps ElevenLabs spend near zero. It references the email we
 * just sent and the specific open role, and identifies the caller honestly.
 * Override per workspace with RECRUITEROS_ROLE_VM_TEMPLATE.
 */
export const DEFAULT_ROLE_VM_TEMPLATE =
  "Hi {first_name}, this is {agent_name} with {agent_company}. I just sent you an email about your {role} opening. We have someone strong who could be a fit. If it's useful, give me a quick call back at this number. Thanks {first_name}.";

function roleVmTemplate(): string {
  return (process.env.RECRUITEROS_ROLE_VM_TEMPLATE || "").trim() || DEFAULT_ROLE_VM_TEMPLATE;
}

function personaFor(): VoicePersona {
  return {
    agentName: (process.env.RECRUITEROS_VOICE_AGENT_NAME || DEFAULT_PERSONA.agentName).trim(),
    agentCompany: (process.env.RECRUITEROS_VOICE_AGENT_COMPANY || DEFAULT_PERSONA.agentCompany).trim(),
    signoff: DEFAULT_PERSONA.signoff,
  };
}

/** The open role we emailed them about: the researched seat, else their title. */
export function roleForProspect(p: Prospect): string {
  return (p.discoveryRole || p.title || "open role").trim();
}

/** Was this prospect actually emailed? (has a live email thread, or a sent drip touch). */
export function wasEmailed(p: Prospect): boolean {
  return Boolean(p.emailThread) || (typeof p.dripStage === "number" && p.dripStage >= 1);
}

/** The corporate/switchboard number to dial — the enriched direct/landline line,
 *  else the primary number. Mobiles are never used here (the switchboard path is
 *  for corporate lines; a mobile would just ring the person and isn't our motion). */
export function corporateNumber(p: Prospect): string {
  return toE164(p.landlinePhone || p.phone || "");
}

/**
 * Assemble the role voicemail for one prospect with the credit-saver splice
 * engine. Returns the single audio URL to play + the role it's about. Dry-run
 * safe: with no voice key it still returns a URL (silent placeholder) so the flow
 * runs end to end. Runs in the workspace's credential scope for the TTS provider.
 */
export async function assembleRoleVoicemail(
  workspaceId: string, p: Prospect,
): Promise<{ url?: string; role: string; dryRun: boolean }> {
  const role = roleForProspect(p);
  const persona = personaFor();
  const vars = { firstName: p.firstName || p.fullName?.split(/\s+/)[0] || "", role, company: p.company };
  const voice = activeVoiceRef(workspaceId);
  const segments = spliceSegments(roleVmTemplate(), vars, persona);
  const drop = await withWorkspaceCreds(workspaceId, () => assembleSplicedDrop(segments, voice));
  return { url: drop.playlist[0], role, dryRun: drop.dryRun };
}

export interface EnqueueResult {
  queued: boolean;
  reason?: "not_emailed" | "no_number" | "already_queued" | "no_role";
  role?: string;
  itemId?: string;
}

/**
 * Enqueue ONE emailed prospect for a role voicemail via Phone Intel. Never throws
 * (the email path fires-and-forgets). Idempotent per prospect/number.
 */
export async function enqueueRoleVoicemail(workspaceId: string, p: Prospect): Promise<EnqueueResult> {
  await ensureQueueReady();
  if (!wasEmailed(p)) return { queued: false, reason: "not_emailed" };
  const mainPhone = corporateNumber(p);
  if (!/^\+[1-9]\d{7,14}$/.test(mainPhone)) return { queued: false, reason: "no_number" };
  if (hasQueued(workspaceId, { prospectId: p.id, contactId: p.id, phone: mainPhone })) {
    return { queued: false, reason: "already_queued" };
  }
  const { url, role } = await assembleRoleVoicemail(workspaceId, p);
  const full = (p.fullName || p.firstName || "").trim();
  const toks = full.split(/\s+/).filter(Boolean);
  const item = enqueue(workspaceId, {
    companyName: p.company || "Unknown company",
    domain: p.companyDomain,
    mainPhone,
    first: p.firstName || toks[0],
    last: toks.length > 1 ? toks[toks.length - 1] : undefined,
    full: full || (p.firstName || "Unknown"),
    title: p.title,
    contactId: p.id,
    prospectId: p.id,
    location: p.location,
    voicemailUrl: url,
    voicemailRole: role,
  });
  return { queued: true, role, itemId: item.id };
}

export interface PullSummary {
  scanned: number;
  queued: number;
  skipped: { notEmailed: number; noNumber: number; alreadyQueued: number };
  /** A few example rows for the UI ("queued Hector Alvarez re: VP of Sales"). */
  examples: Array<{ name: string; company?: string; role: string }>;
}

/**
 * PULL: scan the pipeline and enqueue every eligible emailed prospect (has a
 * corporate number + was emailed + not already staged) for a role voicemail.
 * `motion` scopes to a pipeline bucket; `limit` caps a single pull.
 */
export async function pullRoleVoicemailsFromPipeline(
  workspaceId: string, opts: { motion?: Motion; limit?: number } = {},
): Promise<PullSummary> {
  await ensureQueueReady();
  const all = await getCore().listProspects(workspaceId);
  const prospects = opts.motion ? all.filter((p) => (p.motion ?? "bd") === opts.motion) : all;
  const cap = Math.max(1, opts.limit ?? 200);

  const sum: PullSummary = { scanned: 0, queued: 0, skipped: { notEmailed: 0, noNumber: 0, alreadyQueued: 0 }, examples: [] };
  for (const p of prospects) {
    if (sum.queued >= cap) break;
    sum.scanned++;
    const res = await enqueueRoleVoicemail(workspaceId, p);
    if (res.queued) {
      sum.queued++;
      if (sum.examples.length < 8) sum.examples.push({ name: p.fullName || p.firstName || "Unknown", company: p.company, role: res.role || roleForProspect(p) });
    } else if (res.reason === "not_emailed") sum.skipped.notEmailed++;
    else if (res.reason === "no_number") sum.skipped.noNumber++;
    else if (res.reason === "already_queued") sum.skipped.alreadyQueued++;
  }
  return sum;
}

/** True when the reactive email-sent → role-voicemail bridge is switched on. */
export function roleVoicemailOnSendEnabled(): boolean {
  const v = (process.env.RECRUITEROS_ROLE_VM_ON_SEND || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
