/**
 * RecruitersOS · Warm-up engagement engine (the always-running loop)
 * Replaces the old one-way stub with a real, bidirectional warm-up:
 *
 *   SEND   — each tick, a jittered handful of warming mailboxes send a tagged
 *            warm-up message (through the owned Postal MTA) to a real-provider
 *            seed inbox (Gmail/Outlook/Yahoo).
 *   DRIVE  — the seed client (IMAP/SMTP) then rescues those messages from spam,
 *            opens them, and replies on a delay — building positive history AT the
 *            provider whose trust we need.
 *
 * Gated behind SENDING_WARMUP_ENGAGE=1 (off by default): it needs live Postal +
 * live seed creds, and synthetic engagement carries a known ToS gray area, so it
 * is opt-in. Drive it by calling runEngagement on a frequent tick
 * (/api/sending/warmup/cron) — "always running" = the tick fires every few minutes.
 *
 * Budgeted + jittered so it stays organic: a small per-mailbox daily warm-up
 * allowance, a per-tick send cap, and randomized selection + reply delays.
 */

import { allMailboxes, getDomain, getServer, listSeeds, addWarmupThread, openWarmupThreads, saveWarmupThread, recordEvent } from "./store";
import { sendMessage, postalConfigured } from "./postal";
import { engageSeed, seedDrivable } from "./seedClient";
import type { Mailbox, SeedAccount, WarmupThread } from "./types";

export function engagementEnabled(): boolean {
  return process.env.SENDING_WARMUP_ENGAGE === "1";
}

const PER_MAILBOX_PER_DAY = Number(process.env.SENDING_WARMUP_PER_MAILBOX || 3);
const SENDS_PER_TICK = Number(process.env.SENDING_WARMUP_SENDS_PER_TICK || 8);

/** Benign, business-flavored warm-up subjects; the tag makes each one findable. */
const SUBJECTS = ["Quick sync", "Following up", "Notes from earlier", "One thing to flag", "Re: this week", "Checking in"];

function pickSubject(tag: string): { subject: string; line: string } {
  let h = 0; for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  const s = SUBJECTS[h % SUBJECTS.length];
  return { subject: `${s} [${tag}]`, line: "Sending this over so it's on your radar — no action needed, just keeping us in sync." };
}

function todayStr(): string { return new Date().toISOString().slice(0, 10); }
function shuffle<T>(arr: T[]): T[] { return arr.map((v) => [Math.random(), v] as [number, T]).sort((a, b) => a[0] - b[0]).map((x) => x[1]); }

export interface EngagementReport {
  skipped: boolean;
  reason?: string;
  sent: number;
  rescued: number;
  opened: number;
  replied: number;
  errors: number;
  seeds: number;
}

/**
 * Run one engagement tick for a workspace. Idempotent + best-effort: failures on
 * one mailbox/seed never abort the round.
 */
export async function runEngagement(workspaceId: string): Promise<EngagementReport> {
  const report: EngagementReport = { skipped: false, sent: 0, rescued: 0, opened: 0, replied: 0, errors: 0, seeds: 0 };
  if (!engagementEnabled()) return { ...report, skipped: true, reason: "SENDING_WARMUP_ENGAGE not set" };

  const seeds = (await listSeeds()).filter(seedDrivable);
  report.seeds = seeds.length;
  if (seeds.length === 0) return { ...report, skipped: true, reason: "no drivable seed inboxes" };

  /* ---------- SEND phase: warming mailboxes -> seeds (tagged) ---------- */
  const mailboxes = (await allMailboxes(workspaceId)).filter((m) => m.status !== "paused");
  const existing = await openWarmupThreads(workspaceId); // for today's per-mailbox budget
  const sentTodayByMailbox = new Map<string, number>();
  for (const t of existing) {
    if (t.createdAt.slice(0, 10) === todayStr()) sentTodayByMailbox.set(t.mailboxId, (sentTodayByMailbox.get(t.mailboxId) || 0) + 1);
  }

  const eligible = shuffle(mailboxes.filter((m) => (sentTodayByMailbox.get(m.id) || 0) < PER_MAILBOX_PER_DAY)).slice(0, SENDS_PER_TICK);
  for (const m of eligible) {
    const sent = await sendWarmup(workspaceId, m, seeds[Math.floor(Math.random() * seeds.length)]);
    if (sent === true) report.sent++;
    else if (sent === "error") report.errors++;
    // `false` (Postal not ready) just means warm-up can't send yet — not an error.
  }

  /* ---------- DRIVE phase: act at the seeds over IMAP/SMTP ---------- */
  const open = await openWarmupThreads(workspaceId);
  const bySeed = new Map<string, WarmupThread[]>();
  for (const t of open) { const a = bySeed.get(t.seedId) || []; a.push(t); bySeed.set(t.seedId, a); }
  for (const seed of seeds) {
    const threads = bySeed.get(seed.id);
    if (!threads || !threads.length) continue;
    const r = await engageSeed(seed, threads);
    report.rescued += r.rescued; report.opened += r.opened; report.replied += r.replied; report.errors += r.errors;
    for (const t of threads) await saveWarmupThread(t); // persist status/flag/schedule changes
  }

  return report;
}

/** Send one warm-up message from a mailbox to a seed. Returns true/false/"error". */
async function sendWarmup(workspaceId: string, mailbox: Mailbox, seed: SeedAccount): Promise<true | false | "error"> {
  const domain = await getDomain(workspaceId, mailbox.domainId);
  if (!domain || domain.status === "paused") return false;
  const server = domain.serverId ? await getServer(workspaceId, domain.serverId) : undefined;
  if (!server || !postalConfigured(server)) return false; // no live MTA yet

  const tag = "rw" + Math.random().toString(36).slice(2, 10);
  const messageId = `<${tag}@${domain.domain}>`;
  const { subject, line } = pickSubject(tag);
  const from = mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address;

  try {
    await sendMessage(server, {
      from,
      to: seed.address,
      subject,
      plainBody: line,
      headers: { "Message-ID": messageId, "X-ROS-Warmup": tag },
    });
    await addWarmupThread({
      workspaceId,
      mailboxId: mailbox.id, mailboxAddress: mailbox.address,
      seedId: seed.id, seedAddress: seed.address, seedProvider: seed.provider,
      subject, tag, messageId, status: "sent",
    });
    await recordEvent({ type: "sent", domainId: domain.id, mailboxId: mailbox.id, to: seed.address, detail: "warmup:" + tag });
    return true;
  } catch {
    return "error";
  }
}

/** UI roll-up of recent engagement (last 24h) for the dashboard. */
export function engagementSummary(threads: WarmupThread[]): { active: number; sent: number; opened: number; replied: number; rescued: number } {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recent = threads.filter((t) => t.updatedAt >= since);
  return {
    active: recent.length,
    sent: recent.length,
    opened: recent.filter((t) => t.opened).length,
    replied: recent.filter((t) => t.replied).length,
    rescued: recent.filter((t) => t.rescuedFromSpam).length,
  };
}
