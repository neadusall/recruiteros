/**
 * RecruitersOS · Job Blasts (candidate marketing)
 *
 * A Job Blast = one job, one recruiter, one audience of candidates, one bank of
 * 50+ spintax email variants (lib/recruiting/jobMail). Sending rides the SAME
 * hardened path as every other email in the app - sendTouch, which enforces
 * suppression, the ATS no-double-contact guard, list hygiene, the white-label
 * brand wall, and routes through the recruiter's own warmed inbox pool where
 * their signature + the compliance footer are appended per send.
 *
 * Pacing: sends only inside the business-hours send window, capped per day per
 * blast, jittered between sends, and naturally throttled by the pool's own
 * per-inbox caps + 20-minute rest. Clock = the hourly /api/sending/cron tick,
 * plus a self-heal tick when the Job Blasts panel is opened, plus an explicit
 * "send a wave now" action. NOTHING sends until the operator starts the blast.
 *
 * Store: hydrate-once + snapshot, same pattern as prospect-lists
 * (/data/snap_job_blasts_v1.json in prod).
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, saveSnapshot } from "../db";
import { getCore } from "../core/repository";
import type { Prospect } from "../core/types";
import { type JobFacts, type JobMailTemplate, renderJobMail, spinCombos } from "./jobMail";

export interface BlastRecipient {
  prospectId: string;
  status: "queued" | "sent" | "failed" | "held";
  at?: string;
  /** Stable reason code on failed/held (suppressed, bounced, missing first name, ...). */
  reason?: string;
}

export interface JobBlast {
  id: string;
  workspaceId: string;
  name: string;
  /** The routing campaign: its recruiterId is what sends through that recruiter's pool. */
  campaignId: string;
  recruiterId: string;
  recruiterName: string;
  facts: JobFacts;
  templates: JobMailTemplate[];
  distinctEmails: number;
  status: "sending" | "paused" | "done";
  dailyCap: number;
  dayClock?: { day: string; count: number };
  recipients: BlastRecipient[];
  createdAt: string;
  updatedAt: string;
  lastSendAt?: string;
  lastError?: string;
}

const KEY = "job_blasts_v1";
/** Per-tick ceiling so one cron pass never runs for many minutes. */
const MAX_PER_TICK = 25;
const DEFAULT_DAILY_CAP = 150;

let store: JobBlast[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<JobBlast[]>(KEY);
      if (Array.isArray(snap)) store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

async function save(): Promise<void> {
  await saveSnapshot(KEY, store);
}

export interface BlastPublic extends Omit<JobBlast, "recipients" | "templates"> {
  templates: number;
  counts: { queued: number; sent: number; failed: number; held: number; total: number };
}

function toPublic(b: JobBlast): BlastPublic {
  const counts = { queued: 0, sent: 0, failed: 0, held: 0, total: b.recipients.length };
  for (const r of b.recipients) counts[r.status]++;
  const { recipients: _r, templates, ...rest } = b;
  return { ...rest, templates: templates.length, counts };
}

export async function listJobBlasts(workspaceId: string): Promise<BlastPublic[]> {
  await hydrate();
  return store
    .filter((b) => b.workspaceId === workspaceId)
    .sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))
    .map(toPublic);
}

export async function getJobBlast(workspaceId: string, id: string): Promise<JobBlast | undefined> {
  await hydrate();
  return store.find((b) => b.id === id && b.workspaceId === workspaceId);
}

export interface CreateBlastInput {
  workspaceId: string;
  name: string;
  recruiterId: string;
  recruiterName: string;
  facts: JobFacts;
  templates: JobMailTemplate[];
  dailyCap?: number;
  prospectIds: string[];
  dataIds: string[];
  /** True = the operator's click arms sending immediately (window permitting). */
  start: boolean;
}

/**
 * Create the blast + its routing campaign and enroll the audience. Warehouse
 * rows are promoted into prospects on the routing campaign; existing pipeline
 * prospects are NEVER moved off their campaign - the send path overrides the
 * routing campaign per send instead.
 */
export async function createJobBlast(input: CreateBlastInput): Promise<BlastPublic> {
  await hydrate();
  if (!input.templates.length) throw new Error("empty_template_bank");
  const core = getCore();
  const { createCampaign, activateCampaign } = await import("../campaigns");
  const campaign = await createCampaign({
    workspaceId: input.workspaceId,
    motion: "recruiting",
    name: input.name,
    goal: "Market the " + input.facts.roleTitle + " opening to matched candidates",
    icp: { accountProfile: "", persona: input.facts.roleTitle, disqualifiers: [] },
    signals: [],
    dailyCap: input.dailyCap ?? DEFAULT_DAILY_CAP,
  });
  campaign.recruiterId = input.recruiterId;
  await core.saveCampaign(campaign);
  await activateCampaign(campaign.id);

  const recipients: BlastRecipient[] = [];
  const seenEmails = new Set<string>();
  const push = (p: Prospect | null) => {
    if (!p) return;
    const em = (p.email || "").toLowerCase();
    if (em && seenEmails.has(em)) return;
    if (em) seenEmails.add(em);
    if (recipients.some((r) => r.prospectId === p.id)) return;
    recipients.push({ prospectId: p.id, status: "queued" });
  };

  for (const id of input.prospectIds.slice(0, 5000)) push(await core.getProspect(id));

  if (input.dataIds.length) {
    const { getRecord } = await import("../data");
    const { addProspect } = await import("../prospects");
    for (const id of input.dataIds.slice(0, 5000)) {
      const rec = await getRecord(input.workspaceId, id);
      if (!rec) continue;
      const p = await addProspect({
        workspaceId: input.workspaceId,
        campaignId: campaign.id,
        fullName: rec.fullName,
        email: rec.email,
        phone: rec.phone || rec.directPhone,
        company: rec.company,
        title: rec.title,
        linkedinUrl: rec.linkedinUrl,
        location: [rec.city, rec.state].filter(Boolean).join(", ") || undefined,
        motion: "recruiting",
        category: "Job blast",
      });
      push(p);
    }
  }

  const blast: JobBlast = {
    id: rid("blast"),
    workspaceId: input.workspaceId,
    name: input.name,
    campaignId: campaign.id,
    recruiterId: input.recruiterId,
    recruiterName: input.recruiterName,
    facts: input.facts,
    templates: input.templates,
    distinctEmails: input.templates.reduce((n, t) => n + spinCombos(t.body) * Math.max(1, spinCombos(t.subject)), 0),
    status: input.start ? "sending" : "paused",
    dailyCap: input.dailyCap ?? DEFAULT_DAILY_CAP,
    recipients,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.push(blast);
  await save();
  return toPublic(blast);
}

export async function setBlastStatus(workspaceId: string, id: string, status: "sending" | "paused"): Promise<BlastPublic | null> {
  await hydrate();
  const b = store.find((x) => x.id === id && x.workspaceId === workspaceId);
  if (!b) return null;
  if (b.status !== "done") b.status = status;
  b.updatedAt = nowIso();
  await save();
  return toPublic(b);
}

export async function deleteJobBlast(workspaceId: string, id: string): Promise<boolean> {
  await hydrate();
  const i = store.findIndex((x) => x.id === id && x.workspaceId === workspaceId);
  if (i < 0) return false;
  store.splice(i, 1);
  await save();
  return true;
}

/* ---------------- the send tick ---------------- */

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-workspace tick coalescing: overlapping clocks share one pass. */
const inFlight = new Map<string, Promise<TickReport>>();

export interface TickReport {
  workspaceId: string;
  blasts: number;
  sent: number;
  failed: number;
  held: number;
  skipped?: string;
}

export async function runJobBlastTick(workspaceId: string, opts: { max?: number } = {}): Promise<TickReport> {
  const existing = inFlight.get(workspaceId);
  if (existing) return existing;
  const p = tickInner(workspaceId, opts).finally(() => inFlight.delete(workspaceId));
  inFlight.set(workspaceId, p);
  return p;
}

async function tickInner(workspaceId: string, opts: { max?: number }): Promise<TickReport> {
  await hydrate();
  const report: TickReport = { workspaceId, blasts: 0, sent: 0, failed: 0, held: 0 };
  const active = store.filter((b) => b.workspaceId === workspaceId && b.status === "sending");
  if (!active.length) return report;

  const { emailSendWindow } = await import("../sending/sendWindow");
  const win = emailSendWindow();
  if (!win.open) { report.skipped = win.reason || "send_window_closed"; return report; }

  const { sendTouch } = await import("../channels");
  const core = getCore();
  let dirty = false;

  for (const b of active) {
    report.blasts++;
    const day = todayUtc();
    if (!b.dayClock || b.dayClock.day !== day) b.dayClock = { day, count: 0 };
    let budget = Math.min(opts.max ?? MAX_PER_TICK, Math.max(0, b.dailyCap - b.dayClock.count));

    for (const r of b.recipients) {
      if (budget <= 0) break;
      if (r.status !== "queued") continue;
      const p = await core.getProspect(r.prospectId);
      if (!p) { r.status = "held"; r.reason = "prospect_missing"; report.held++; dirty = true; continue; }
      if (!p.email) { r.status = "held"; r.reason = "no_email"; report.held++; dirty = true; continue; }
      const rendered = renderJobMail(b.templates, { id: p.id, firstName: p.firstName, fullName: p.fullName }, b.recruiterName);
      if (rendered.holds.length) {
        r.status = "held";
        r.reason = rendered.holds[0].slice(0, 120);
        report.held++;
        dirty = true;
        continue;
      }
      // Route through the blast's campaign (its recruiterId -> the recruiter's
      // warmed pool) WITHOUT persisting a campaign move on pipeline prospects:
      // the copy only lives for this send.
      const routed: Prospect = { ...p, campaignId: b.campaignId, motion: "recruiting" };
      const res = await sendTouch(workspaceId, {
        channel: "email",
        prospect: routed,
        text: rendered.body,
        subject: rendered.subject,
        campaignId: b.campaignId,
        touch: "job_blast",
        variant: rendered.templateId,
      });
      budget--;
      dirty = true;
      if (res.ok && !res.dryRun) {
        r.status = "sent";
        r.at = nowIso();
        b.dayClock.count++;
        b.lastSendAt = r.at;
        report.sent++;
      } else {
        const reason = res.error || "send_failed";
        // Transient pool exhaustion is NOT a per-person failure: leave the rest
        // queued and let a later tick retry when inboxes free up.
        if (reason === "no_tenant_inbox" || reason === "email_no_provider") {
          b.lastError = reason;
          break;
        }
        r.status = "failed";
        r.at = nowIso();
        r.reason = reason.slice(0, 120);
        report.failed++;
      }
      b.updatedAt = nowIso();
      // Human pacing between sends; the per-inbox 20-min rest + caps still rule.
      await sleep(800 + Math.floor(Math.random() * 1700));
    }

    if (!b.recipients.some((x) => x.status === "queued")) {
      b.status = "done";
      b.updatedAt = nowIso();
      dirty = true;
    }
  }

  if (dirty) await save();
  return report;
}

/** Cron entry: tick every workspace holding an active blast (hourly clock). */
export async function runJobBlastTickAll(): Promise<TickReport[]> {
  await hydrate();
  const ids = Array.from(new Set(store.filter((b) => b.status === "sending").map((b) => b.workspaceId)));
  const out: TickReport[] = [];
  for (const ws of ids) {
    try { out.push(await runJobBlastTick(ws)); }
    catch (e: any) { out.push({ workspaceId: ws, blasts: 0, sent: 0, failed: 0, held: 0, skipped: e?.message ?? "tick_failed" }); }
  }
  return out;
}
