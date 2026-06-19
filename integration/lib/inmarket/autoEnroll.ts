/**
 * RecruitersOS · In-Market · Auto-enroll autopilot (POPULATE ONLY — never auto-sends)
 *
 * Closes the last mile of the Hire Signals → BD Bulk pipeline hands-off: every few minutes it
 * takes the freshly-curated, VERIFIED-deliverable decision-makers (status "contactable" — they
 * have a real name + an email whose domain can receive mail and that passed the free verifier;
 * undeliverable ones were already suppressed) and enrolls a batch into the BD Bulk MPC campaign,
 * up to a daily cap. So the BD Bulk tab fills itself toward the 5K/day target without anyone
 * clicking the review gate.
 *
 * POPULATE ONLY by design: enrolling = creating the Prospect on the campaign (enrollToBulk →
 * addProspect). It does NOT send anything — the MPC emails go out only under BD Bulk's own
 * sending controls. Point this at a campaign that is NOT on send-autopilot and nothing leaves the
 * building automatically; the prospects just stack up, ready.
 *
 * Fully gated — OFF unless configured, so deploying it changes nothing until you opt in:
 *   INMARKET_AUTOENROLL            = "1"        master switch
 *   INMARKET_AUTOENROLL_WORKSPACE  = "<wsId>"   workspace that owns the BD Bulk campaign
 *   INMARKET_AUTOENROLL_CAMPAIGN   = "<cmpId>"  the BD Bulk campaign to populate
 *   INMARKET_AUTOENROLL_DAILY_CAP  = "5000"     max enrolled per calendar day (default 5000)
 *   INMARKET_AUTOENROLL_BATCH      = "300"      max enrolled per tick (default 300)
 */

import { loadSnapshot, saveSnapshot } from "../db";

const TICK_MS = 5 * 60 * 1000;        // enroll a batch every 5 minutes
const FIRST_DELAY_MS = 60_000;        // let curation get a head start after boot
const WATCHDOG_MS = 4 * 60 * 1000;    // abandon a stuck tick before the next fires
const COUNTER_KEY = "inmarket_autoenroll_counter_v1";

interface DayCounter { day: string; enrolled: number }

function cfg() {
  const on = ["1", "true", "yes", "on"].includes((process.env.INMARKET_AUTOENROLL || "").toLowerCase());
  return {
    on,
    workspaceId: (process.env.INMARKET_AUTOENROLL_WORKSPACE || "").trim(),
    campaignId: (process.env.INMARKET_AUTOENROLL_CAMPAIGN || "").trim(),
    dailyCap: Math.max(0, Number(process.env.INMARKET_AUTOENROLL_DAILY_CAP) || 5000),
    batch: Math.max(1, Math.min(Number(process.env.INMARKET_AUTOENROLL_BATCH) || 300, 1000)),
  };
}

/** True only when the autopilot is fully configured (switch + workspace + campaign). */
export function autoEnrollEnabled(): boolean {
  const c = cfg();
  return c.on && !!c.workspaceId && !!c.campaignId;
}

function dayKey(nowIso: string): string {
  return nowIso.slice(0, 10); // YYYY-MM-DD
}

async function readCounter(nowIso: string): Promise<DayCounter> {
  const saved = await loadSnapshot<DayCounter>(COUNTER_KEY);
  const today = dayKey(nowIso);
  if (saved && saved.day === today) return saved;
  return { day: today, enrolled: 0 }; // new day → reset
}

/** Live status for the diagnostics surface. */
export async function autoEnrollStatus(): Promise<{ enabled: boolean; today: number; cap: number }> {
  const c = cfg();
  const ctr = await readCounter(new Date().toISOString());
  return { enabled: autoEnrollEnabled(), today: ctr.enrolled, cap: c.dailyCap };
}

let started = false;
let running = false;

async function runTickInner(): Promise<void> {
  const c = cfg();
  if (!autoEnrollEnabled()) return;

  const nowIso = new Date().toISOString();
  const ctr = await readCounter(nowIso);
  const remaining = c.dailyCap - ctr.enrolled;
  if (remaining <= 0) return; // daily cap reached; resets at midnight UTC

  const { listCurated, approveForBulk, enrollToBulk, requireValidatedEmail } = await import("./curation");
  // Build large lists now from the syntax guesses (full name + title + company + URL + email); once
  // INMARKET_REQUIRE_VALIDATED is set (SMTP/paid validator live) this flips to validated-only.
  // enrollToBulk enforces the same rule; matching the selection here avoids wasting the daily cap.
  const needValid = requireValidatedEmail();
  const want = Math.min(c.batch, remaining);
  const candidates = await listCurated({ status: "contactable", contactableOnly: true, validatedOnly: needValid, limit: want });
  if (!candidates.length) return;

  const ids = candidates.map((r) => r.id);
  // Review-gate step 1 (contactable → queued), then enroll. Auto-running the gate is the whole
  // point of the autopilot; the human gate stays available for anyone who'd rather drive manually.
  await approveForBulk(ids);
  const res = await enrollToBulk(c.workspaceId, c.campaignId, ids, nowIso);

  if (res.enrolled > 0) {
    await saveSnapshot(COUNTER_KEY, { day: ctr.day, enrolled: ctr.enrolled + res.enrolled } as DayCounter);
  }
}

function withWatchdog(fn: () => Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, ms);
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
    fn().then(() => { clearTimeout(timer); finish(); }, () => { clearTimeout(timer); finish(); });
  });
}

async function runTick(): Promise<void> {
  if (running) return;
  running = true;
  try { await withWatchdog(runTickInner, WATCHDOG_MS); }
  finally { running = false; }
}

/**
 * Idempotently arm the auto-enroll autopilot. Safe to call on every boot; the timer only arms
 * once per process and is a complete no-op until the autopilot is configured (so it never
 * silently starts populating a campaign you didn't point it at).
 */
export function ensureAutoEnroll(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void runTick(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void runTick(); }, TICK_MS);
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}
