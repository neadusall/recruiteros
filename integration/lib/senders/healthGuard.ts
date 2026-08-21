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
 *     never held for reputation alone, and a mailbox younger than the grace
 *     window is not judged on reputation at all: 0% there means "not measured
 *     yet", not "bad")
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
import { INBOX_BOUNCE_HOLD_RATE, INBOX_MIN_SAMPLE } from "../sending/policy";

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

// Thresholds (env-tunable). Hold conservatively, revive with hysteresis.
const repFloor = () => envNum("SENDER_GUARD_REP_FLOOR", 45);        // hold at ANY age below this
const repHoldMature = () => envNum("SENDER_GUARD_REP_HOLD", 60);    // hold below this once warmed 7+ days
const repRecover = () => envNum("SENDER_GUARD_REP_RECOVER", 85);    // healthy again at/above this
const repGraceDays = () => envNum("SENDER_GUARD_REP_GRACE_DAYS", 3); // reputation rules stay quiet before this age
const bounceHoldRate = () => envNum("SENDER_GUARD_BOUNCE_RATE", INBOX_BOUNCE_HOLD_RATE);
const BOUNCE_MIN_SAMPLE = INBOX_MIN_SAMPLE; // sends in the window before the bounce rule can trip
const RECOVER_STREAK = 2;          // consecutive healthy checks required to revive
const MIN_HOLD_MS = 24 * 60 * 60 * 1000; // minimum rest before a revive

// WARM GRADUATION (owner mandate 2026-08-19): a warming inbox that has provably
// finished its warm-up promotes itself to active, so ready fleets never sit parked
// waiting for a human. Bars mirror the Senders panel readiness rules: provider-run
// fleets 14 days, the internal SMTP server a full month, both at 95%+ reputation
// measured THIS run (no stale data). Sending.ac inboxes are skipped: their cap is
// a flat 2/day either way, so graduating them only churns rows. SENDER_AUTO_GRADUATE=0
// turns the whole behavior off.
const gradRep = () => envNum("SENDER_GRADUATE_REP", 95);
const gradDaysProvider = () => envNum("SENDER_GRADUATE_DAYS", 14);
const gradDaysInternal = () => envNum("SENDER_GRADUATE_DAYS_INTERNAL", 30);
const autoGraduate = () => process.env.SENDER_AUTO_GRADUATE !== "0";

export interface GuardAction {
  workspaceId: string;
  email: string;
  action: "held" | "revived" | "graduated";
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
  /** Orphaned holds re-claimed from the journal this run (fleet-wide). */
  adopted: number;
  /** Warming inboxes promoted to active this run (warm-up provably complete). */
  graduated: GuardAction[];
  /** Warming inboxes that met the clock + reputation bar but were held back by
   *  real bounce pressure (warm-up NDRs): the receiving world gets a veto that
   *  the vendor's reputation score does not carry. */
  gradDeferred?: GuardAction[];
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

/**
 * Windowed bounce rate since the last revive (or lifetime before the first).
 *
 * THE PAIR MUST MATCH. `m.bounced` counts every delivery notice that LANDS in the
 * mailbox, warm-up traffic included; `m.sent` counts campaign sends. Dividing one by
 * the other compares two different populations and can exceed 100% (10,400% on the
 * ariel@ boxes on 2026-08-21, where 208 warm-up notices sat against 2 campaign sends).
 * While `sent` was stuck at 0 that arithmetic was merely dormant. The moment counter
 * reconciliation gave it a denominator it would have auto-held most of the fleet on a
 * number that was never real.
 *
 * So: the matched campaign pair decides whenever it exists. The legacy counters remain
 * the fallback ONLY for inboxes the app itself sends through, where recordSend and
 * recordBounce write both halves over the same population and the ratio is honest.
 */
function windowBounce(m: SenderInbox): { rate: number; sample: number; source: "campaign" | "app" } {
  if (typeof m.coldSent === "number") {
    const sent = Math.max(0, m.coldSent - (m.guardBaseColdSent || 0));
    const bounced = Math.max(0, (m.coldBounced || 0) - (m.guardBaseColdBounced || 0));
    return { rate: sent > 0 ? bounced / sent : 0, sample: sent, source: "campaign" };
  }
  const sent = Math.max(0, (m.sent || 0) - (m.guardBaseSent || 0));
  const bounced = Math.max(0, (m.bounced || 0) - (m.guardBaseBounced || 0));
  // A ratio above 1 is arithmetically impossible for one population, so it is proof
  // the halves disagree. Refuse to act on it rather than hold the inbox on nonsense.
  if (sent > 0 && bounced > sent) return { rate: 0, sample: 0, source: "app" };
  return { rate: sent > 0 ? bounced / sent : 0, sample: sent, source: "app" };
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
  // Reputation only means something once warm-up has run long enough to measure
  // it. A mailbox created minutes ago reports 0%, which is the absence of a
  // score rather than a bad one, and holding on it turned every new batch off on
  // its first night: 18 of a 53-mailbox delivery were parked hours after arrival
  // for "warm-up reputation 0%" while warm-up was working perfectly. Give a new
  // mailbox its grace days before this rule can speak.
  if (typeof rep === "number" && ageDays(m, acct) >= repGraceDays()) {
    if (rep < repFloor()) return `warm-up reputation ${rep}%`;
    if (rep < repHoldMature() && ageDays(m, acct) >= 7) return `warm-up reputation ${rep}% after 7+ days`;
  }
  const wb = windowBounce(m);
  if (wb.sample >= BOUNCE_MIN_SAMPLE && wb.rate > bounceHoldRate()) {
    return `bounce rate ${(wb.rate * 100).toFixed(1)}% over ${wb.sample} sends`;
  }
  return null;
}

/**
 * The guard's most recent journalled action for a mailbox (journal is newest
 * first). Falls back to an email-only match so a mailbox that has since been
 * relocated to its correct portal is still recognised as one this guard held:
 * the journal records the workspace the row lived in at the time, and a routing
 * correction would otherwise look like a mailbox with no history.
 */
function lastGuardActionFor(workspaceId: string, email: string): GuardAction | undefined {
  return state.journal.find((a) => a.workspaceId === workspaceId && a.email === email)
    || state.journal.find((a) => a.email === email);
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
  const graduated: GuardAction[] = [];
  const gradDeferred: GuardAction[] = [];
  let checked = 0;
  let holding = 0;
  let adopted = 0;

  // Graduation veto data: per-box bounce-notice counts from the host NDR sweeps
  // (campaign perBox + warm-up warmupPerBox, ~7-day window, both lanes). The
  // 2026-08 lesson: "reputation 100%" can coexist with hundreds of receiver
  // rejections; only the real notices know. Missing sweep data reads as zero
  // pressure (fail-open), the sweep's own freshness is watched on the health board.
  const ndrPressure = new Map<string, number>();
  try {
    const ndr = await loadSnapshot<{ perBox?: Record<string, number>; warmupPerBox?: Record<string, number> }>("mpc_ndr_v1");
    for (const [box, n] of Object.entries(ndr?.perBox || {})) ndrPressure.set(box.toLowerCase(), n || 0);
    for (const [box, n] of Object.entries(ndr?.warmupPerBox || {})) {
      const k = box.toLowerCase();
      ndrPressure.set(k, (ndrPressure.get(k) || 0) + (n || 0));
    }
  } catch { /* fail-open */ }
  const gradMaxNdr = (() => {
    const n = Number(process.env.SENDER_GRADUATE_MAX_NDR);
    return Number.isFinite(n) && n >= 0 ? n : 20;
  })();

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

      // Re-adopt a hold this guard placed and then lost track of. A paused row
      // with no autoHold flag is indistinguishable from an operator's own pause,
      // so bounce-back skips it forever; that is how 68 mailboxes came to sit
      // parked with nothing left to release them. The journal still remembers who
      // pressed pause, so trust it and take the row back.
      if (m.status === "paused" && !m.autoHold) {
        const last = lastGuardActionFor(ws, m.email);
        if (last?.action === "held") {
          m.autoHold = true;
          m.autoHoldAt = m.autoHoldAt || last.at;
          m.autoHoldReason = m.autoHoldReason || last.reason;
          m.pausedReason = m.pausedReason || `auto-hold: ${last.reason}`;
          adopted++;
          dirty = true;
        }
      }

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
            m.guardBaseColdSent = m.coldSent || 0;
            m.guardBaseColdBounced = m.coldBounced || 0;
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

      // WARM GRADUATION: healthy, warming, warm-up provably complete -> active.
      // Requires live reputation from THIS run (no stale mirror), warm-up still
      // running upstream, and a clean bill from every hold rule above.
      if (
        autoGraduate() && !reason && !m.autoHold && m.status === "warming" &&
        m.provider !== "sending-ac" && acct && typeof rep === "number" && rep >= gradRep() &&
        ageDays(m, acct) >= (m.provider === "own-smtp" ? gradDaysInternal() : gradDaysProvider())
      ) {
        // Receiving-world veto: a box the sweeps saw bouncing does not graduate,
        // whatever the vendor's reputation score says. It re-qualifies by itself
        // once a sweep window passes without pressure (nothing to un-set here).
        const pressure = ndrPressure.get(m.email.toLowerCase()) || 0;
        if (pressure > gradMaxNdr) {
          gradDeferred.push({ workspaceId: ws, email: m.email, action: "held", reason: `graduation deferred: ${pressure} bounce notices in the sweep window (max ${gradMaxNdr})`, at });
        } else {
          m.status = "active";
          m.activatedAt = at; // own-smtp cold ramp (limits.coldCapFor) counts from here
          m.guardBaseSent = m.sent || 0;
          m.guardBaseBounced = m.bounced || 0;
          m.guardBaseColdSent = m.coldSent || 0;
          m.guardBaseColdBounced = m.coldBounced || 0;
          dirty = true;
          graduated.push({ workspaceId: ws, email: m.email, action: "graduated", reason: `warm-up complete: day ${Math.floor(ageDays(m, acct))}, reputation ${rep}%`, at });
        }
      }

      if (m.autoHold && m.status === "paused") holding++;
      if (dirty) { try { await saveInbox(m); } catch { /* one row */ } }
    }
  }

  const report: GuardReport = { at, checked, held, revived, holding, adopted, graduated, gradDeferred, smartleadData: haveSmartlead };
  state.lastReport = report;
  state.journal = [...held, ...revived, ...graduated, ...state.journal].slice(0, 200);
  save();
  return report;
}
