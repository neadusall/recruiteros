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
import { classifyLine } from "../signals/phoneClassify";
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
  // companyPhone LAST, as the fallback: an enriched direct line always beats the front
  // desk, because it reaches the person without an IVR to navigate. But when there is no
  // direct line — the common case, since direct dials are paid and switchboards are free —
  // the employer's published main line is exactly what this engine is built to work with:
  // call the switchboard once, learn the route, reuse it for every prospect there.
  return toE164(p.landlinePhone || p.phone || p.companyPhone || "");
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
  reason?: "not_emailed" | "no_number" | "already_queued" | "no_role" | "not_business_line" | "no_voice";
  role?: string;
  itemId?: string;
}

/**
 * Confirm `phone` is an ACTUAL business landline/VoIP line before we ever dial it
 * (operator rule: business lines only, never a personal or residential number).
 * Uses the cached verdict when we've checked before; otherwise runs the line-type
 * + caller-name lookup once and persists the result onto the prospect so we never
 * re-pay. Returns true only for a confirmed business landline/VoIP.
 */
interface ClassifyOutcome { businessLine: boolean; lineType?: string; looked: boolean; cached: boolean; costUsd: number; }

/**
 * Determine + PERSIST whether a prospect's number is an actual business line, once.
 * Uses the cached verdict if present; otherwise runs the Telnyx line-type +
 * caller-name (CNAM) lookup, routes the number into landline/mobile, and stores
 * phoneLineType + phoneBusinessLine on the prospect so we never re-pay.
 */
async function classifyAndPersist(workspaceId: string, p: Prospect, motion?: Motion): Promise<ClassifyOutcome> {
  if (typeof p.phoneBusinessLine === "boolean") {
    return { businessLine: p.phoneBusinessLine, lineType: p.phoneLineType, looked: false, cached: true, costUsd: 0 };
  }
  const cls = await classifyLine(corporateNumber(p) || p.phone || "", {
    workspaceId, motion: motion ?? p.motion, business: true,
  });
  // Dry-run (Telnyx not configured) leaves it unknown — don't guess, don't dial.
  const business = cls.businessLine === true;
  try {
    const fresh = await getCore().getProspect(p.id);
    if (fresh) {
      fresh.phoneLineType = cls.looked ? cls.lineType : fresh.phoneLineType;
      fresh.phoneBusinessLine = cls.looked ? business : undefined;
      if (cls.landlinePhone && !fresh.landlinePhone) fresh.landlinePhone = cls.landlinePhone;
      if (cls.mobilePhone && !fresh.mobilePhone) fresh.mobilePhone = cls.mobilePhone;
      await getCore().saveProspect(fresh);
      p.phoneBusinessLine = fresh.phoneBusinessLine;
      p.phoneLineType = fresh.phoneLineType;
    }
  } catch { /* best-effort persist */ }
  return { businessLine: business, lineType: cls.lineType, looked: cls.looked, cached: false, costUsd: cls.costUsd };
}

async function ensureBusinessLine(workspaceId: string, p: Prospect, motion?: Motion): Promise<boolean> {
  return (await classifyAndPersist(workspaceId, p, motion)).businessLine;
}

const validNum = (n?: string) => /^\+?[1-9]\d{7,14}$/.test(toE164(n || ""));

/* --------------------------- reachability monitor --------------------------- */

export interface PhoneReachabilityStats {
  totalProspects: number;
  withNumber: number;
  withRole: number;
  emailed: number;
  /** Numbers we've run the line-type + business check on. */
  classified: number;
  /** Confirmed ACTUAL business landline/VoIP lines — the droppable universe. */
  businessLines: number;
  /** Classified but a mobile/cell (never dialed). */
  mobiles: number;
  /** Classified landline/VoIP but consumer/residential (never dialed). */
  personalOrResidential: number;
  /** Has a number but not line-checked yet. */
  unclassifiedWithNumber: number;
  /** READY TO DROP NOW: emailed + confirmed business line + a role. */
  droppableNow: number;
  /** Confirmed business line + a role, not yet emailed (needs the email first). */
  businessNotYetEmailed: number;
}

/** Live phone-reachability rollup for a motion's pipeline, read from the cached
 *  per-prospect classification. Fast (no lookups); the "Classify" action fills it. */
export async function phoneReachabilityStats(workspaceId: string, motion?: Motion): Promise<PhoneReachabilityStats> {
  const all = await getCore().listProspects(workspaceId);
  const prospects = motion ? all.filter((p) => (p.motion ?? "bd") === motion) : all;
  const s: PhoneReachabilityStats = {
    totalProspects: prospects.length, withNumber: 0, withRole: 0, emailed: 0,
    classified: 0, businessLines: 0, mobiles: 0, personalOrResidential: 0,
    unclassifiedWithNumber: 0, droppableNow: 0, businessNotYetEmailed: 0,
  };
  for (const p of prospects) {
    const hasNum = validNum(p.landlinePhone) || validNum(p.phone);
    if (hasNum) s.withNumber++;
    if (roleForProspect(p) && roleForProspect(p) !== "open role") s.withRole++;
    const em = wasEmailed(p);
    if (em) s.emailed++;
    const done = typeof p.phoneBusinessLine === "boolean";
    if (done) {
      s.classified++;
      if (p.phoneBusinessLine === true) {
        s.businessLines++;
        if (em) s.droppableNow++; else s.businessNotYetEmailed++;
      } else if (p.phoneLineType === "mobile" || p.phoneLineType === "toll_free") s.mobiles++;
      else s.personalOrResidential++;
    } else if (hasNum) s.unclassifiedWithNumber++;
  }
  return s;
}

export interface ClassifyBatchResult {
  classified: number;
  businessFound: number;
  mobiles: number;
  personalOrResidential: number;
  remaining: number;
  spentUsd: number;
  dryRun: boolean;
}

/**
 * Line-check a batch of the pipeline's numbers (line-type + business CNAM),
 * persisting each verdict. `emailedOnly` (default true) checks only prospects
 * we've emailed — the droppable candidates — to keep spend tight; pass false to
 * classify the whole pool. Bounded by `limit`. Safe to call repeatedly (cached
 * verdicts are skipped, so it never re-pays).
 */
export async function classifyPipelinePhones(
  workspaceId: string, opts: { motion?: Motion; limit?: number; emailedOnly?: boolean } = {},
): Promise<ClassifyBatchResult> {
  const all = await getCore().listProspects(workspaceId);
  const pool = (opts.motion ? all.filter((p) => (p.motion ?? "bd") === opts.motion) : all)
    .filter((p) => (validNum(p.landlinePhone) || validNum(p.phone)) && typeof p.phoneBusinessLine !== "boolean")
    .filter((p) => (opts.emailedOnly === false ? true : wasEmailed(p)));
  const cap = Math.max(1, opts.limit ?? 300);
  const res: ClassifyBatchResult = { classified: 0, businessFound: 0, mobiles: 0, personalOrResidential: 0, remaining: 0, spentUsd: 0, dryRun: false };
  let done = 0;
  for (const p of pool) {
    if (done >= cap) break;
    const out = await classifyAndPersist(workspaceId, p, opts.motion);
    if (!out.looked && !out.cached) { res.dryRun = true; break; } // Telnyx unconfigured — stop, charge nothing
    done++;
    res.classified++;
    res.spentUsd += out.costUsd;
    if (out.businessLine) res.businessFound++;
    else if (out.lineType === "mobile" || out.lineType === "toll_free") res.mobiles++;
    else res.personalOrResidential++;
  }
  res.remaining = Math.max(0, pool.length - done);
  return res;
}

/**
 * Enqueue ONE emailed prospect for a role voicemail via Phone Intel. Never throws
 * (the email path fires-and-forgets). Idempotent per prospect/number. Dials ONLY
 * confirmed business landline/VoIP lines.
 */
export async function enqueueRoleVoicemail(workspaceId: string, p: Prospect): Promise<EnqueueResult> {
  await ensureQueueReady();
  if (!wasEmailed(p)) return { queued: false, reason: "not_emailed" };
  const mainPhone = corporateNumber(p);
  if (!/^\+[1-9]\d{7,14}$/.test(mainPhone)) return { queued: false, reason: "no_number" };
  if (hasQueued(workspaceId, { prospectId: p.id, contactId: p.id, phone: mainPhone })) {
    return { queued: false, reason: "already_queued" };
  }
  // Business-line gate: never dial a personal/residential/mobile number.
  if (!(await ensureBusinessLine(workspaceId, p))) return { queued: false, reason: "not_business_line" };
  const { url, role, dryRun } = await assembleRoleVoicemail(workspaceId, p);
  // SILENCE GATE. assembleSplicedDrop returns dryRun with PLACEHOLDER audio whenever the
  // workspace has no usable voice — no cloned voice on file, or no TTS credential. Queuing that
  // is worse than queuing nothing: Phone Intel would dial the switchboard, navigate the IVR,
  // reach the person's mailbox, and play SILENCE. That burns the contact, spends Telnyx
  // minutes, and reads as a broken robocall to the prospect.
  //
  // This is what makes RECRUITEROS_ROLE_VM_ON_SEND safe to leave ON: with no voice the
  // automation quietly declines instead of shipping dead air, and it starts working by itself
  // the moment a voice is recorded. Nothing to remember to flip back on.
  if (dryRun || !url) return { queued: false, reason: "no_voice" };
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
  skipped: { notEmailed: number; noNumber: number; alreadyQueued: number; notBusinessLine: number; noVoice: number };
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

  const sum: PullSummary = { scanned: 0, queued: 0, skipped: { notEmailed: 0, noNumber: 0, alreadyQueued: 0, notBusinessLine: 0, noVoice: 0 }, examples: [] };
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
    else if (res.reason === "not_business_line") sum.skipped.notBusinessLine++;
    else if (res.reason === "no_voice") sum.skipped.noVoice++;
  }
  return sum;
}

/** True when the reactive email-sent → role-voicemail bridge is switched on. */
export function roleVoicemailOnSendEnabled(): boolean {
  const v = (process.env.RECRUITEROS_ROLE_VM_ON_SEND || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
