/**
 * RecruitersOS · Send Queue · AUTO-FILL engine (set-and-forget buffer keeper)
 *
 * The "no empty days" autopilot. When ON, it continuously stages send-ready prospects into the
 * designated Send Queue campaign so the next few days always hold your 4–6K/day band — without
 * anyone clicking the review gate. It is UI-CONTROLLED (settings live in the snapshot store, not
 * env), so the operator flips it on, picks a campaign + band, and walks away.
 *
 * POPULATE ONLY (same safety contract as autoEnroll): "filling" = enrolling curated, verified
 * decision-makers onto the campaign (curation.enrollToBulk → addProspect, status "queued"). It does
 * NOT send anything — sends stay under the campaign's own controls. The buffer it builds is what
 * gives the video compositor (autoVideo) time to finish each prospect's 2nd-email video before that
 * prospect's send day, so the Send Queue's readiness gate clears in time.
 *
 * Buffer-aware: it never over-stages. It tops up only until (a) the day's target is met AND (b) the
 * ready supply covers bufferDays × dailyTarget — so it holds a rolling few-day cushion and no more.
 */

import { loadSnapshot, saveSnapshot } from "../db";

const SETTINGS_KEY = "send_autofill_settings_v1";
const COUNTER_KEY = "send_autofill_counter_v1";
const TICK_MS = 5 * 60 * 1000;        // top up every 5 minutes
const FIRST_DELAY_MS = 90_000;        // let curation/verification warm up after boot
const WATCHDOG_MS = 4 * 60 * 1000;    // abandon a stuck tick before the next fires
const RUN_BATCH_CAP = 1000;           // most prospects staged in a single run

export interface AutofillSettings {
  enabled: boolean;
  workspaceId: string;   // the workspace that owns the campaign (set when the campaign is chosen)
  campaignId: string;    // the Send Queue campaign to stage into
  targetMin: number;     // daily band low  (default 4000)
  targetMax: number;     // daily band high (default 6000)
  bufferDays: number;    // keep this many days staged ahead (default 5)
}

const DEFAULTS: AutofillSettings = { enabled: false, workspaceId: "", campaignId: "", targetMin: 4000, targetMax: 6000, bufferDays: 5 };

function clampN(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

export async function getAutofillSettings(): Promise<AutofillSettings> {
  const s = await loadSnapshot<Partial<AutofillSettings>>(SETTINGS_KEY);
  return { ...DEFAULTS, ...(s || {}) };
}

/** Persist a partial settings update (only provided fields change). Keeps min ≤ max. */
export async function setAutofillSettings(patch: Partial<AutofillSettings>): Promise<AutofillSettings> {
  const cur = await getAutofillSettings();
  const targetMin = clampN(patch.targetMin ?? cur.targetMin, 1, 1_000_000, DEFAULTS.targetMin);
  const targetMax = clampN(patch.targetMax ?? cur.targetMax, 1, 1_000_000, DEFAULTS.targetMax);
  const next: AutofillSettings = {
    enabled: patch.enabled ?? cur.enabled,
    workspaceId: patch.workspaceId !== undefined ? String(patch.workspaceId).trim() : cur.workspaceId,
    campaignId: patch.campaignId !== undefined ? String(patch.campaignId).trim() : cur.campaignId,
    targetMin,
    targetMax: Math.max(targetMin, targetMax),
    bufferDays: clampN(patch.bufferDays ?? cur.bufferDays, 1, 14, DEFAULTS.bufferDays),
  };
  await saveSnapshot(SETTINGS_KEY, next);
  return next;
}

/** The per-day target = the midpoint of the band (so we aim for the middle of 4–6K). */
function dailyTargetOf(s: AutofillSettings): number {
  return Math.round((s.targetMin + s.targetMax) / 2);
}

/** The effective per-day target: the workspace's daily email pool when set
 *  (e.g. Lume's 3,000/day), otherwise the configured band midpoint — so the
 *  buffer keeper never stages faster than the number the team was given. */
async function resolveDailyTarget(s: AutofillSettings, fallbackWorkspaceId?: string): Promise<number> {
  const ws = s.workspaceId || fallbackWorkspaceId || "";
  if (ws) {
    try {
      const { emailPoolSplit } = await import("../outbound/goals");
      const pool = await emailPoolSplit(ws);
      if (pool) return pool.total;
    } catch { /* outbound module unavailable — band midpoint applies */ }
  }
  return dailyTargetOf(s);
}

interface DayCounter { day: string; enrolled: number }
function dayKey(nowIso: string): string { return nowIso.slice(0, 10); }
async function readCounter(nowIso: string): Promise<DayCounter> {
  const saved = await loadSnapshot<DayCounter>(COUNTER_KEY);
  const today = dayKey(nowIso);
  if (saved && saved.day === today) return saved;
  return { day: today, enrolled: 0 }; // new day → reset
}

export interface AutofillResult {
  enrolled: number;
  skipped: number;
  reason: "ok" | "disabled" | "no_campaign" | "daily_target_met" | "buffer_full" | "no_ready_supply";
  today: number;        // enrolled so far today
  dailyTarget: number;
}

/**
 * Run one auto-fill cycle. Stages send-ready curated prospects into the configured campaign until
 * the day's target is met or the rolling buffer is full. `force` runs it even when the toggle is off
 * (the "Fill now" button) — but never without a chosen campaign.
 */
export async function runAutofill(nowIso: string, opts?: { force?: boolean }): Promise<AutofillResult> {
  const s = await getAutofillSettings();
  const dailyTarget = await resolveDailyTarget(s);
  const ctr = await readCounter(nowIso);
  const base = { today: ctr.enrolled, dailyTarget };
  if (!opts?.force && !s.enabled) return { enrolled: 0, skipped: 0, reason: "disabled", ...base };
  if (!s.campaignId || !s.workspaceId) return { enrolled: 0, skipped: 0, reason: "no_campaign", ...base };

  const remainingToday = dailyTarget - ctr.enrolled;
  if (remainingToday <= 0) return { enrolled: 0, skipped: 0, reason: "daily_target_met", ...base };

  // Buffer guard: never stage past bufferDays × dailyTarget of ready supply.
  const { sendQueueOverview } = await import("./sendReady");
  const ov = await sendQueueOverview(s.workspaceId, nowIso);
  const room = Math.max(0, s.bufferDays * dailyTarget - ov.readySupply);
  const want = Math.min(remainingToday, room, RUN_BATCH_CAP);
  if (want <= 0) return { enrolled: 0, skipped: 0, reason: "buffer_full", ...base };

  // Stage the next batch of verified, contactable decision-makers (same selection autoEnroll uses,
  // so the daily cap isn't wasted on rows enrollToBulk would reject).
  const { listCurated, approveForBulk, enrollToBulk, requireValidatedEmail } = await import("../inmarket/curation");
  const needValid = requireValidatedEmail();
  const candidates = await listCurated({ status: "contactable", contactableOnly: true, validatedOnly: needValid, limit: want });
  if (!candidates.length) return { enrolled: 0, skipped: 0, reason: "no_ready_supply", ...base };

  const ids = candidates.map((r) => r.id);
  await approveForBulk(ids);
  const res = await enrollToBulk(s.workspaceId, s.campaignId, ids, nowIso);
  if (res.enrolled > 0) {
    await saveSnapshot(COUNTER_KEY, { day: ctr.day, enrolled: ctr.enrolled + res.enrolled } as DayCounter);
  }
  return { enrolled: res.enrolled, skipped: res.skipped, reason: "ok", today: ctr.enrolled + res.enrolled, dailyTarget };
}

/** Status for the Send Queue UI: the settings + today's staged count + the resolved daily target.
 *  `workspaceId` = the viewer's workspace, used to resolve its email pool before
 *  auto-fill has ever been saved (the stored settings start with no workspace). */
export async function autofillStatus(nowIso: string, workspaceId?: string): Promise<{ settings: AutofillSettings; today: number; dailyTarget: number }> {
  const s = await getAutofillSettings();
  const ctr = await readCounter(nowIso);
  return { settings: s, today: ctr.enrolled, dailyTarget: await resolveDailyTarget(s, workspaceId) };
}

let started = false;
let running = false;

function withWatchdog(fn: () => Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, ms);
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
    fn().then(() => { clearTimeout(timer); finish(); }, () => { clearTimeout(timer); finish(); });
  });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const s = await getAutofillSettings();
    if (s.enabled && s.campaignId && s.workspaceId) {
      await withWatchdog(async () => { await runAutofill(new Date().toISOString()); }, WATCHDOG_MS);
    }
  } finally { running = false; }
}

/**
 * Idempotently arm the auto-fill timer. Safe to call on every request (only arms once per process)
 * and a complete no-op until the operator turns auto-fill on with a chosen campaign.
 */
export function ensureAutofill(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void tick(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}
