/**
 * RecruitersOS · Senders · Email ID health guard (auto turn-down + bounce-back)
 *
 * The supervisor over the per-portal Email ID pools. Warm-up runs EXTERNALLY and
 * is never touched here; this guard only governs OUR cold sends, so a struggling
 * inbox keeps warming (and regaining strength) while it is held out of rotation.
 *
 * TURN-DOWN (auto-hold cold sends) when any of:
 *   - the sending domain answers on a public spam blocklist (Spamhaus DBL/ZEN)
 *   - warm-up is blocked upstream (blockedReason)
 *   - warm-up reputation collapses (< floor at any age, or < mature threshold
 *     once the inbox has warmed 7+ days; young inboxes at 50-80% are NORMAL and
 *     never held for reputation alone)
 *   - our own bounce rate for the inbox crosses the ceiling (windowed from the
 *     last revive, min sample so one bounce never trips it)
 *
 * BOUNCE-BACK (auto-revive) only for inboxes THIS guard held (autoHold flag;
 *   operator pauses are never touched): after a minimum 24h rest AND two
 *   consecutive healthy checks (reputation recovered, domain clean, bounces
 *   quiet), the inbox returns as "warming", i.e. the REDUCED ramp cap, never
 *   straight back to full volume. Its bounce window resets so old incidents
 *   don't haunt the fresh start.
 *
 * Runs from the sending cron tick + the in-process clock + the panel's
 * "Run safety check" button. Idempotent; every action is journaled per
 * workspace for the Mailbox Ops attention list.
 */

import { listInboxes, saveInbox, listSenderWorkspaceIds } from "./store";
import type { SenderInbox } from "./types";
import { listSmartleadAccounts, smartleadConfigured } from "../sending/smartlead";
import type { SmartleadAccount } from "../sending/smartlead";
import { probeDnsMany } from "../sending/dnsProbe";
import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

// Thresholds (env-tunable). Hold conservatively, revive with hysteresis.
const repFloor = () => envNum("SENDER_GUARD_REP_FLOOR", 45);        // hold at ANY age below this
const repHoldMature = () => envNum("SENDER_GUARD_REP_HOLD", 60);    // hold below this once warmed 7+ days
const repRecover = () => envNum("SENDER_GUARD_REP_RECOVER", 85);    // healthy again at/above this
const bounceHoldRate = () => envNum("SENDER_GUARD_BOUNCE_RATE", 0.08);
const BOUNCE_MIN_SAMPLE = 25;      // sends in the window before the bounce rule can trip
const RECOVER_STREAK = 2;          // consecutive healthy checks required to revive
const MIN_HOLD_MS = 24 * 60 * 60 * 1000; // minimum rest before a revive

export interface GuardAction {
  workspaceId: string;
  email: string;
  action: "held" | "revived";
  reason: string;
  at: string;
}

export interface GuardReport {
  at: string;
  checked: number;
  held: GuardAction[];
  revived: GuardAction[];
  /** Inboxes currently sitting in auto-hold after this run (fleet-wide). */
  holding: number;
  smartleadData: boolean;
}

interface GuardState {
  lastReport?: GuardReport;
  /** Rolling journal of the most recent actions (newest first, capped). */
  journal: GuardAction[];
}

const KEY = "sender_health_guard_v1";
let state: GuardState = { journal: [] };
let hydrated = false;
const save = debouncedSaver(KEY, () => state);
async function hydrate(): Promise<void> {
  if (hydrated) return;
  const snap = await loadSnapshot<GuardState>(KEY);
  if (snap) state = { journal: [], ...snap };
  hydrated = true;
}

/** Last run + recent journal, filtered to one workspace (tenant isolation). */
export async function guardStatus(workspaceId: string): Promise<{
  lastRunAt?: string;
  holding: number;
  watched: number;
  healthy: number;
  revivedThisWeek: number;
  repRecoverTarget: number;
  recoverStreakTarget: number;
  /** The set parameters this guard enforces, for the UI's rules card. */
  rules: {
    repFloorPct: number;         // hold below this at any age
    repHoldMaturePct: number;    // hold below this after 7+ warm-up days
    bounceHoldPct: number;       // hold above this windowed bounce rate
    minHoldHours: number;        // minimum rest before a revive
  };
  /** Every Email ID currently resting in auto-hold, with its recovery progress. */
  held: Array<{
    email: string;
    reason: string;
    heldAt?: string;
    repNow?: number;
    streak: number;
  }>;
  recent: GuardAction[];
}> {
  await hydrate();
  const inboxes = await listInboxes(workspaceId);
  const holding = inboxes.filter((m) => m.autoHold && m.status === "paused");
  const weekAgo = Date.now() - 7 * 86_400_000;
  return {
    lastRunAt: state.lastReport?.at,
    holding: holding.length,
    watched: inboxes.length,
    healthy: inboxes.filter((m) => m.status === "active" || m.status === "warming").length,
    revivedThisWeek: state.journal.filter((a) =>
      a.workspaceId === workspaceId && a.action === "revived" && Date.parse(a.at) >= weekAgo).length,
    repRecoverTarget: repRecover(),
    recoverStreakTarget: RECOVER_STREAK,
    rules: {
      repFloorPct: repFloor(),
      repHoldMaturePct: repHoldMature(),
      bounceHoldPct: Math.round(bounceHoldRate() * 1000) / 10,
      minHoldHours: Math.round(MIN_HOLD_MS / 3_600_000),
    },
    held: holding
      .sort((a, b) => Date.parse(b.autoHoldAt || "") - Date.parse(a.autoHoldAt || ""))
      .slice(0, 50)
      .map((m) => ({
        email: m.email,
        reason: m.autoHoldReason || m.pausedReason || "health",
        heldAt: m.autoHoldAt,
        repNow: m.warmupRepPct,
        streak: m.recoverStreak || 0,
      })),
    recent: state.journal.filter((a) => a.workspaceId === workspaceId).slice(0, 12),
  };
}

function domainOf(email: string): string {
  return (email.split("@")[1] || "").toLowerCase();
}

function ageDays(m: SenderInbox, acct?: SmartleadAccount): number {
  const start = acct?.warmupStartedAt || acct?.createdAt || m.createdAt;
  const t = start ? Date.parse(start) : NaN;
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 86_400_000) : 0;
}

/** Windowed bounce rate since the last revive (or lifetime before the first). */
function windowBounce(m: SenderInbox): { rate: number; sample: number } {
  const sent = Math.max(0, (m.sent || 0) - (m.guardBaseSent || 0));
  const bounced = Math.max(0, (m.bounced || 0) - (m.guardBaseBounced || 0));
  return { rate: sent > 0 ? bounced / sent : 0, sample: sent };
}

/** The hold reason for an inbox right now, or null when healthy. */
function holdReason(
  m: SenderInbox,
  acct: SmartleadAccount | undefined,
  domainListed: Map<string, string[]>,
): string | null {
  const lists = domainListed.get(domainOf(m.email));
  if (lists && lists.length) return `domain on spam blocklist (${lists.join(", ")})`;
  if (acct?.blockedReason) return `warm-up blocked upstream: ${acct.blockedReason}`;
  const rep = acct?.reputationPct;
  if (typeof rep === "number") {
    if (rep < repFloor()) return `warm-up reputation ${rep}%`;
    if (rep < repHoldMature() && ageDays(m, acct) >= 7) return `warm-up reputation ${rep}% after 7+ days`;
  }
  const wb = windowBounce(m);
  if (wb.sample >= BOUNCE_MIN_SAMPLE && wb.rate > bounceHoldRate()) {
    return `bounce rate ${(wb.rate * 100).toFixed(1)}% over ${wb.sample} sends`;
  }
  return null;
}

/** Healthy enough to count toward the revive streak. */
function recovered(m: SenderInbox, acct: SmartleadAccount | undefined, domainListed: Map<string, string[]>): boolean {
  if (holdReason(m, acct, domainListed)) return false;
  const rep = acct?.reputationPct;
  // When we have reputation data, demand real recovery, not just "above floor".
  if (typeof rep === "number") return rep >= repRecover();
  return true;
}

/**
 * Run the guard across every portal's pool. Never throws; every inbox decision
 * is independent. Warm-up (external) is untouched by design.
 */
export async function runSenderHealthGuard(): Promise<GuardReport> {
  await hydrate();
  const at = nowIso();
  const held: GuardAction[] = [];
  const revived: GuardAction[] = [];
  let checked = 0;
  let holding = 0;

  // One upstream fleet pull serves every workspace (same account list).
  let byEmail = new Map<string, SmartleadAccount>();
  let haveSmartlead = false;
  try {
    if (smartleadConfigured()) {
      const accounts = await listSmartleadAccounts();
      haveSmartlead = accounts.length > 0;
      byEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a]));
    }
  } catch { /* upstream down: rep rules skip, bounce/blocklist rules still run */ }

  for (const ws of await listSenderWorkspaceIds()) {
    let inboxes: SenderInbox[] = [];
    try { inboxes = await listInboxes(ws); } catch { continue; }
    if (!inboxes.length) continue;

    // Blocklist posture per distinct sending domain (cached 6h inside the probe).
    const domainListed = new Map<string, string[]>();
    try {
      const domains = [...new Set(inboxes.map((m) => domainOf(m.email)).filter(Boolean))];
      const postures = await probeDnsMany(domains);
      for (const [dom, p] of postures) if (p.dnsbl?.listed) domainListed.set(dom, p.dnsbl.lists);
    } catch { /* posture unavailable: skip the blocklist rule this round */ }

    for (const m of inboxes) {
      checked++;
      const acct = byEmail.get(m.email.toLowerCase());
      let dirty = false;

      // Mirror the latest warm-up vitals onto the row (shown in the pool tables).
      const rep = acct?.reputationPct;
      if (typeof rep === "number" && m.warmupRepPct !== rep) { m.warmupRepPct = rep; dirty = true; }
      if (acct && m.warmupStatus !== acct.warmupStatus) { m.warmupStatus = acct.warmupStatus; dirty = true; }
      m.healthCheckedAt = at;

      const reason = holdReason(m, acct, domainListed);

      if (reason && m.status !== "paused" && m.status !== "error") {
        // TURN DOWN: cold sends off, warm-up keeps running upstream.
        m.status = "paused";
        m.autoHold = true;
        m.autoHoldAt = at;
        m.autoHoldReason = reason;
        m.pausedReason = `auto-hold: ${reason}`;
        m.recoverStreak = 0;
        dirty = true;
        held.push({ workspaceId: ws, email: m.email, action: "held", reason, at });
      } else if (m.autoHold && m.status === "paused") {
        if (reason) {
          if (m.autoHoldReason !== reason) { m.autoHoldReason = reason; m.pausedReason = `auto-hold: ${reason}`; dirty = true; }
          if (m.recoverStreak) { m.recoverStreak = 0; dirty = true; }
        } else if (recovered(m, acct, domainListed)) {
          const streak = (m.recoverStreak || 0) + 1;
          const heldLongEnough = m.autoHoldAt ? Date.now() - Date.parse(m.autoHoldAt) >= MIN_HOLD_MS : true;
          if (streak >= RECOVER_STREAK && heldLongEnough) {
            // BOUNCE BACK: return on the reduced warming ramp, clean bounce window.
            m.status = "warming";
            m.autoHold = false;
            m.autoHoldReason = undefined;
            m.pausedReason = undefined;
            m.recoverStreak = 0;
            m.guardBaseSent = m.sent || 0;
            m.guardBaseBounced = m.bounced || 0;
            revived.push({ workspaceId: ws, email: m.email, action: "revived", reason: "health recovered, back on the warm-up ramp", at });
          } else {
            m.recoverStreak = streak;
          }
          dirty = true;
        } else if (m.recoverStreak) {
          m.recoverStreak = 0;
          dirty = true;
        }
      }

      if (m.autoHold && m.status === "paused") holding++;
      if (dirty) { try { await saveInbox(m); } catch { /* one row */ } }
    }
  }

  const report: GuardReport = { at, checked, held, revived, holding, smartleadData: haveSmartlead };
  state.lastReport = report;
  state.journal = [...held, ...revived, ...state.journal].slice(0, 200);
  save();
  return report;
}
