/**
 * RecruitersOS · In-Market · Background CAPTURE generator
 *
 * A personalized outreach video = your webcam clip composited over a SCREEN CAPTURE of the
 * contact's live job posting. Captures used to be on-demand only (click "Generate" per row), so
 * only a handful ever existed — which is why the Clients tab showed "with video 17" against
 * thousands of contacts.
 *
 * This tick fills them in HANDS-OFF: every few minutes it captures the job posting for a small
 * batch of contactable Hire Signals decision-makers that don't have one yet, so the asset count
 * climbs toward the whole book on its own. Deliberately gentle — captures launch headless Chromium
 * + ffmpeg, so we do a SMALL batch SEQUENTIALLY (one browser at a time) and bound each run with a
 * watchdog, to keep the single box responsive. Raise the batch on a bigger box or a worker.
 *
 * Gated OFF until configured, so deploying it changes nothing until you opt in:
 *   INMARKET_AUTOCAPTURE              = "1"     master switch
 *   INMARKET_AUTOCAPTURE_BATCH        = "3"     captures generated per tick (1..25)
 *   INMARKET_AUTOCAPTURE_INTERVAL_SEC = "180"   how often the tick runs
 *   INMARKET_AUTOCAPTURE_MIN_SCORE    = "0"     only capture rows scoring >= this (prioritize hot ones)
 */

const TICK_MS = () => Math.max(60, Number(process.env.INMARKET_AUTOCAPTURE_INTERVAL_SEC) || 180) * 1000;
const FIRST_DELAY_MS = 90_000;        // let the pool + curation warm up first
const WATCHDOG_MS = 8 * 60 * 1000;    // abandon a stuck run (e.g. a hung browser) before the next tick

export function autoCaptureEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.INMARKET_AUTOCAPTURE || "").toLowerCase());
}
function batchSize(): number { return Math.max(1, Math.min(Number(process.env.INMARKET_AUTOCAPTURE_BATCH) || 3, 25)); }
function minScore(): number { return Math.max(0, Number(process.env.INMARKET_AUTOCAPTURE_MIN_SCORE) || 0); }

let started = false, running = false;
let lastRun = 0, lastMade = 0, totalMade = 0, lastError: string | undefined;

/** Live status for the diagnostics surface. */
export async function autoCaptureStatus(): Promise<{ enabled: boolean; lastRun: number; lastMade: number; totalMade: number; lastError?: string }> {
  return { enabled: autoCaptureEnabled(), lastRun, lastMade, totalMade, lastError };
}

async function runTickInner(): Promise<void> {
  if (!autoCaptureEnabled()) return;
  lastRun = Date.now();
  const { listCurated } = await import("./curation");
  const { capturedKeySet, captureRoleShot, shotKey } = await import("./roleShot");

  const done = await capturedKeySet().catch(() => new Set<string>());
  // Contactable decision-makers (real person + email), highest-intent first, that we haven't captured yet.
  const rows = await listCurated({ status: "contactable", contactableOnly: true, limit: 5000 });
  const ms = minScore();
  const seen = new Set<string>();
  const todo: Array<{ company: string; role: string; jobUrl?: string; domain?: string }> = [];
  for (const r of rows) {
    const company = r.company;
    const role = r.role || r.managerTitle;
    if (!company || !role) continue;
    if (ms && (r.score || 0) < ms) continue;
    const key = shotKey(company, role);
    if (done.has(key) || seen.has(key)) continue;   // already captured, or already queued this tick
    seen.add(key);
    todo.push({ company, role, jobUrl: r.jobUrl, domain: r.domain });
    if (todo.length >= batchSize()) break;
  }

  let made = 0;
  for (const t of todo) {
    try {
      // Sequential on purpose — one headless browser at a time keeps the box responsive.
      await captureRoleShot({ company: t.company, roleTitle: t.role, roleUrl: t.jobUrl, domain: t.domain });
      made++; totalMade++;
    } catch (e) {
      lastError = (e as Error)?.message;
    }
  }
  lastMade = made;
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

async function runTick(): Promise<void> {
  if (running) return;     // never let two capture runs overlap (they fight over CPU + the browser)
  running = true;
  try { await withWatchdog(runTickInner, WATCHDOG_MS); }
  finally { running = false; }
}

/**
 * Idempotently arm the background capture generator. Safe to call on every boot; a complete no-op
 * until INMARKET_AUTOCAPTURE is set, so arming it never spends CPU you didn't ask for.
 */
export function ensureAutoCapture(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void runTick(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void runTick(); }, TICK_MS());
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}
