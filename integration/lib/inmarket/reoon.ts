/**
 * RecruitersOS · In-Market · Reoon email verification
 *
 * Hetzner blocks outbound port 25, so we can't run our own SMTP RCPT probe to confirm a guessed
 * email is real. Reoon does that SMTP check from THEIR infrastructure and exposes it over an API —
 * so this is the drop-in replacement that produces `emailValidated=true` for genuinely deliverable
 * addresses, which is exactly what the validated-only auto-enroll requires before anything reaches
 * BD Bulk. No guesses ever enrol; only Reoon-confirmed emails do.
 *
 * It plugs into the EXISTING validation seam (curation.pendingValidationEmails ->
 * curation.applyEmailValidation), so nothing else in the pipeline changes:
 *
 *   curated guess (passed the free MX/role/disposable pass, still "pending")
 *     -> Reoon BULK task (their servers SMTP-verify each address)
 *     -> verdicts -> applyEmailValidation: valid -> emailValidated=true (enrollable),
 *                    invalid -> suppressed (never sent, never bounces)
 *
 * BULK (not single) on purpose: power/SMTP verification is slow per address, so Reoon's bulk task
 * API verifies a whole batch server-side and we poll for the result — fast enough to clear 5K/day.
 * The free pre-pass already dropped the obvious dead addresses, so we only spend Reoon credits on
 * plausible ones.
 *
 * Fully gated — OFF until configured, so deploying it changes nothing:
 *   REOON_API_KEY            (required)  your Reoon Email Verifier API key
 *   REOON_BULK_SIZE          (800)       emails per bulk task
 *   REOON_INTERVAL_SEC       (180)       how often the tick runs (create / poll)
 *   REOON_ACCEPT_CATCHALL    ("1")       treat accept-all/catch-all domains as valid (corporate
 *                                        catch-alls are usually real + low bounce risk; set "0" to exclude)
 *   REOON_TASK_MAX_AGE_SEC   (1800)      abandon a stuck task after this long and start fresh
 */

import { loadSnapshot, saveSnapshot } from "../db";

const BASE = "https://emailverifier.reoon.com/api/v1";
const STATE_KEY = "inmarket_reoon_task_v1";
const TICK_MS = () => (Number(process.env.REOON_INTERVAL_SEC) || 180) * 1000;
const FIRST_DELAY_MS = 45_000;
const WATCHDOG_MS = 90_000;
const HTTP_TIMEOUT_MS = 20_000;

interface TaskState { taskId: string; count: number; createdAt: number }

export function reoonEnabled(): boolean {
  return !!(process.env.REOON_API_KEY || "").trim();
}
function apiKey(): string { return (process.env.REOON_API_KEY || "").trim(); }
function bulkSize(): number { return Math.max(1, Math.min(Number(process.env.REOON_BULK_SIZE) || 800, 5000)); }
function acceptCatchAll(): boolean { return (process.env.REOON_ACCEPT_CATCHALL ?? "1") !== "0"; }
function taskMaxAgeMs(): number { return (Number(process.env.REOON_TASK_MAX_AGE_SEC) || 1800) * 1000; }

/**
 * Map ONE Reoon per-email result to our tri-state verdict:
 *   true  -> deliverable, mark emailValidated (enrollable)
 *   false -> undeliverable/unsafe, suppress (never send)
 *   null  -> inconclusive, leave pending so a later task can retry
 * Defensive across Reoon's field names (status string + the boolean flags it returns in power mode).
 */
function interpret(r: any): boolean | null {
  if (!r || typeof r !== "object") return null;
  const status = String(r.status ?? r.result ?? r.state ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const disposable = r.is_disposable === true || r.disposable === true;
  const roleAcct = r.is_role_account === true || r.is_role === true;
  const safe = r.is_safe_to_send === true || r.safe_to_send === true;
  const catchAll = r.is_catchall === true || r.is_catch_all === true || status.includes("catch") || status.includes("accept_all");

  // Hard negatives first.
  if (disposable) return false;
  if (["invalid", "undeliverable", "disabled", "spamtrap", "spam_trap", "rejected", "bounce"].some((s) => status.includes(s))) return false;
  if (r.is_deliverable === false || r.deliverable === false) return false;

  // Clear positives.
  if (status === "valid" || status === "safe" || status === "deliverable" || status === "ok" || safe) {
    // a confirmed-valid role mailbox is still not a PERSON for 1:1 BD — exclude it.
    return roleAcct ? false : true;
  }

  // Catch-all / accept-all domains: the domain accepts mail but the mailbox can't be individually
  // proven. For BD these are usually real companies with low bounce risk — accept by default.
  if (catchAll) return acceptCatchAll() ? (roleAcct ? false : true) : null;

  // "unknown" / unrecognised → inconclusive; leave pending for a later retry.
  return null;
}

/** Create a bulk verification task; returns its id, or null on failure. */
async function createBulkTask(emails: string[]): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/create-bulk-verification-task/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `ros-${emails.length}-${emails[0]?.slice(0, 8) ?? "x"}`, emails, key: apiKey() }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    const id = j?.task_id ?? j?.taskId ?? j?.id ?? j?.data?.task_id;
    return id != null ? String(id) : null;
  } catch {
    return null;
  }
}

/** Poll a bulk task. Returns {done, verdicts} — verdicts only when the task has completed. */
async function pollBulkTask(taskId: string): Promise<{ done: boolean; verdicts: Array<{ email: string; valid: boolean }> }> {
  try {
    const res = await fetch(`${BASE}/get-result-bulk-verification-task/?key=${encodeURIComponent(apiKey())}&task_id=${encodeURIComponent(taskId)}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return { done: false, verdicts: [] };
    const j: any = await res.json().catch(() => null);
    const status = String(j?.status ?? j?.task_status ?? "").toLowerCase();
    const completed = status.includes("complet") || status.includes("done") || status.includes("finish");
    if (!completed) return { done: false, verdicts: [] };

    // results can come back as a map { "<email>": {...} } or an array [{ email, status, ... }].
    const raw = j?.results ?? j?.data ?? j?.emails ?? {};
    const entries: Array<{ email: string; r: any }> = Array.isArray(raw)
      ? raw.map((r: any) => ({ email: String(r?.email ?? "").toLowerCase(), r }))
      : Object.entries(raw).map(([email, r]) => ({ email: String(email).toLowerCase(), r }));

    const verdicts: Array<{ email: string; valid: boolean }> = [];
    for (const { email, r } of entries) {
      if (!email) continue;
      const v = interpret(r);
      if (v === null) continue; // inconclusive → leave pending
      verdicts.push({ email, valid: v });
    }
    return { done: true, verdicts };
  } catch {
    return { done: false, verdicts: [] };
  }
}

let lastRun = 0, lastApplied = 0, lastError: string | undefined;
/** Live status for the diagnostics surface. */
export async function reoonStatus(): Promise<{ enabled: boolean; activeTask: boolean; lastRun: number; lastApplied: number; lastError?: string }> {
  const state = reoonEnabled() ? await loadSnapshot<TaskState | null>(STATE_KEY).catch(() => null) : null;
  return { enabled: reoonEnabled(), activeTask: !!state?.taskId, lastRun, lastApplied, lastError };
}

let started = false;
let running = false;

/**
 * One step of the verification state machine:
 *  - if a task is in flight: poll it; on completion apply the verdicts and clear it; abandon if stale.
 *  - else: pull the next batch of pending guesses and submit a new task.
 * Only ever one task in flight at a time, so we never double-spend credits on the same addresses.
 */
async function runReoonTickInner(): Promise<void> {
  if (!reoonEnabled()) return;
  lastRun = Date.now();
  const state = await loadSnapshot<TaskState | null>(STATE_KEY).catch(() => null);

  if (state?.taskId) {
    const { done, verdicts } = await pollBulkTask(state.taskId);
    if (done) {
      if (verdicts.length) {
        const { applyEmailValidation } = await import("./curation");
        lastApplied = await applyEmailValidation(verdicts, new Date().toISOString());
      }
      await saveSnapshot(STATE_KEY, null);
    } else if (Date.now() - (state.createdAt || 0) > taskMaxAgeMs()) {
      await saveSnapshot(STATE_KEY, null); // stuck task → abandon, the next tick starts fresh
    }
    return;
  }

  // No task in flight → submit the next batch of still-pending guesses.
  const { pendingValidationEmails } = await import("./curation");
  const emails = await pendingValidationEmails(bulkSize());
  if (!emails.length) return;
  const taskId = await createBulkTask(emails);
  if (taskId) await saveSnapshot(STATE_KEY, { taskId, count: emails.length, createdAt: Date.now() } as TaskState);
}

function withWatchdog(fn: () => Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, ms);
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
    fn().then(() => { clearTimeout(timer); finish(); }, (e) => { lastError = (e as Error)?.message; clearTimeout(timer); finish(); });
  });
}

async function runReoonTick(): Promise<void> {
  if (running) return;
  running = true;
  try { await withWatchdog(runReoonTickInner, WATCHDOG_MS); }
  finally { running = false; }
}

/**
 * Idempotently arm the Reoon validation tick. Safe to call on every boot; a complete no-op until
 * REOON_API_KEY is set, so arming it here never spends a credit you didn't ask for.
 */
export function ensureReoonValidation(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void runReoonTick(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void runReoonTick(); }, TICK_MS());
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}
