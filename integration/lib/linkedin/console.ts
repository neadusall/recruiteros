/**
 * RecruiterOS · LinkedIn Automation console
 *
 * Bridges the Command Center (cookie-session, browser) to the LinkedIn engine
 * (bearer/server-to-server). The engine's enroll/tick/webhook routes are meant
 * for the backend and the scheduler; this module is the thin, workspace-scoped
 * façade the UI talks to via the session-authed /api/automation route.
 *
 * It maps the core models the rest of RecruiterOS already manages onto the
 * engine's framework-agnostic types:
 *   accounts.LinkedInAccount  -> linkedin/types.LinkedInAccount
 *   core.Prospect             -> linkedin/types.Prospect
 * and seeds a couple of sensible default cadences so a workspace can enroll the
 * moment a LinkedIn account is connected — no Prisma layer required (the engine
 * ships an in-memory store).
 */

import { listLinkedInAccounts, type LinkedInAccount as CoreAccount } from "../accounts";
import { getCore } from "../core/repository";
import type { Prospect as CoreProspect } from "../core/types";
import { getRepository, devStore } from "./repository";
import { SequenceEngine } from "./sequenceEngine";
import type { Enrollment, LinkedInAccount, Prospect, Sequence } from "./types";

/** A typed error the route turns into a JSON failure with the right status. */
class ConsoleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/* ---------------- model mapping ---------------- */

/** Map a connected core LinkedIn account onto the engine's account shape. */
export function toEngineAccount(a: CoreAccount, ownerUserId: string): LinkedInAccount {
  const status: LinkedInAccount["status"] =
    a.warmup === "flagged" ? "restricted" : !a.active ? "disconnected" : a.warmup === "in_warmup" ? "warming" : "ok";
  return {
    id: a.id,
    // When Unipile is the provider, every API call needs the Unipile account id
    // (the connected LinkedIn seat), not our internal account id.
    providerAccountId: process.env.UNIPILE_ACCOUNT_ID || a.id,
    ownerUserId,
    displayName: a.handle,
    status,
    premium: false,
    salesNavigator: false,
    limits: {
      invitesPerDay: a.quotas.connects,
      messagesPerDay: a.quotas.dms,
      inmailsPerDay: 0,
      profileViewsPerDay: a.quotas.profileViews,
      workingHours: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5] },
    },
    timezone: "UTC",
  };
}

/** Pull a provider profile identifier out of a stored LinkedIn URL, if any. */
function providerProfileId(url?: string): string | undefined {
  if (!url) return undefined;
  // OAuth sign-in stores the stable member id as "linkedin:<sub>".
  if (url.startsWith("linkedin:")) return url.slice("linkedin:".length);
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** Map a core prospect onto the engine's prospect snapshot. */
function toEngineProspect(p: CoreProspect): Prospect {
  return {
    id: p.id,
    campaignId: p.campaignId,
    fullName: p.fullName,
    firstName: p.firstName,
    providerProfileId: providerProfileId(p.linkedinUrl),
    publicProfileUrl: p.linkedinUrl,
    headline: p.title,
    company: p.company,
    context: { role: p.title ? { title: p.title } : undefined },
  };
}

/* ---------------- default cadences ---------------- */

/**
 * Default sequences seeded per workspace. These mirror the canonical, account-
 * safe LinkedIn cadence (warm up, connect, then rapport-first follow-ups gated
 * on the invite being accepted). campaignId is set to the workspace id so the
 * console can scope sequences without a separate store.
 */
function defaultSequences(ws: string): Sequence[] {
  return [
    {
      id: `seq_${ws}_standard`,
      campaignId: ws,
      name: "Standard LinkedIn cadence",
      steps: [
        { id: "s1", order: 1, action: "profile_view", delayHours: 0, rung: "warmup" },
        { id: "s2", order: 2, action: "connect", delayHours: 48, rung: "recognize" },
        { id: "s3", order: 3, action: "message", delayHours: 24, rung: "relate", requiresConnection: true },
        { id: "s4", order: 4, action: "message", delayHours: 120, rung: "invite", requiresConnection: true },
        { id: "s5", order: 5, action: "message", delayHours: 168, rung: "pitch", requiresConnection: true },
      ],
    },
    {
      id: `seq_${ws}_light`,
      campaignId: ws,
      name: "Light touch (connect + 1 note)",
      steps: [
        { id: "l1", order: 1, action: "connect", delayHours: 0, rung: "recognize" },
        { id: "l2", order: 2, action: "message", delayHours: 48, rung: "invite", requiresConnection: true },
      ],
    },
  ];
}

/** Mirror this workspace's accounts + default cadences into the engine store. */
function syncWorkspace(ws: string, ownerUserId: string): void {
  const store = devStore();
  for (const a of listLinkedInAccounts(ws)) store.upsertAccount(toEngineAccount(a, ownerUserId));
  for (const s of defaultSequences(ws)) if (!store.sequences.has(s.id)) store.upsertSequence(s);
}

/* ---------------- console operations ---------------- */

export interface ConsoleEnrollment extends Enrollment {
  prospectName?: string;
  company?: string;
  sequenceName?: string;
  totalSteps?: number;
}

export interface ConsoleProspect {
  id: string;
  fullName: string;
  company?: string;
  title?: string;
  status: string;
  hasLinkedin: boolean;
  enrolled: boolean;
}

/** Everything the LinkedIn Automation view needs in one read. */
export async function loadConsole(ws: string, ownerUserId: string) {
  syncWorkspace(ws, ownerUserId);
  const store = devStore();
  const accountIds = new Set(listLinkedInAccounts(ws).map((a) => a.id));

  const accounts = [...store.accounts.values()].filter((a) => accountIds.has(a.id));
  const sequences = [...store.sequences.values()].filter((s) => s.id.startsWith(`seq_${ws}_`));
  const enrollments: ConsoleEnrollment[] = [...store.enrollments.values()]
    .filter((e) => accountIds.has(e.accountId))
    .map((e) => {
      const p = store.prospects.get(e.prospectId);
      const seq = store.sequences.get(e.sequenceId);
      return {
        ...e,
        prospectName: p?.fullName,
        company: p?.company,
        sequenceName: seq?.name,
        totalSteps: seq?.steps.length,
      };
    })
    .sort((a, b) => Date.parse(b.lastEventAt ?? "") - Date.parse(a.lastEventAt ?? ""));

  const events = store.events
    .filter((ev) => accountIds.has(ev.accountId))
    .slice(-60)
    .reverse();

  const enrolledIds = new Set(enrollments.map((e) => e.prospectId));
  const prospects: ConsoleProspect[] = (await getCore().listProspects(ws)).map((p) => ({
    id: p.id,
    fullName: p.fullName,
    company: p.company,
    title: p.title,
    status: p.status,
    hasLinkedin: Boolean(p.linkedinUrl),
    enrolled: enrolledIds.has(p.id),
  }));

  const stats = {
    accounts: accounts.length,
    active: enrollments.filter((e) => e.status === "active").length,
    replied: enrollments.filter((e) => e.status === "paused_replied").length,
    completed: enrollments.filter((e) => e.status === "completed").length,
    invitesPerDay: accounts.reduce(
      (sum, a) => sum + (a.status === "ok" || a.status === "warming" ? a.limits.invitesPerDay : 0),
      0,
    ),
  };

  return { accounts, sequences, enrollments, events, prospects, stats };
}

/** Enroll a workspace prospect into a sequence on one of its accounts. */
export async function enrollProspect(
  ws: string,
  ownerUserId: string,
  prospectId: string,
  sequenceId: string,
  accountId: string,
): Promise<Enrollment> {
  syncWorkspace(ws, ownerUserId);
  const store = devStore();

  const core = await getCore().getProspect(prospectId);
  if (!core || core.workspaceId !== ws) throw new ConsoleError("prospect_not_found", 404);

  if (!sequenceId.startsWith(`seq_${ws}_`)) throw new ConsoleError("sequence_not_found", 404);
  const sequence = store.sequences.get(sequenceId);
  if (!sequence) throw new ConsoleError("sequence_not_found", 404);

  const ownsAccount = listLinkedInAccounts(ws).some((a) => a.id === accountId);
  const account = store.accounts.get(accountId);
  if (!account || !ownsAccount) throw new ConsoleError("account_not_found", 404);
  if (account.status === "restricted" || account.status === "disconnected") {
    throw new ConsoleError("account_unavailable", 409);
  }

  const prospect = toEngineProspect(core);
  const repo = getRepository();
  await repo.saveProspect(prospect);
  return new SequenceEngine(repo).enroll(prospect, sequence, account);
}

/** Cron tick on demand ("Run cadence now"). Processes a batch of due steps. */
export async function runTick(): Promise<{ processed: number }> {
  return new SequenceEngine(getRepository()).tick(new Date(), 50);
}

/** Stop or resume an enrollment from the console. */
export async function setEnrollmentStatus(
  ws: string,
  enrollmentId: string,
  action: "stop" | "resume",
): Promise<Enrollment> {
  const store = devStore();
  const accountIds = new Set(listLinkedInAccounts(ws).map((a) => a.id));
  const e = store.enrollments.get(enrollmentId);
  if (!e || !accountIds.has(e.accountId)) throw new ConsoleError("enrollment_not_found", 404);

  if (action === "stop") {
    e.status = "stopped";
    e.nextRunAt = null;
  } else {
    e.status = "active";
    e.nextRunAt = new Date().toISOString();
  }
  e.lastEventAt = new Date().toISOString();
  await getRepository().saveEnrollment(e);
  return e;
}
