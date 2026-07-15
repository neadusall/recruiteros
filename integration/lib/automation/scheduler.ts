/**
 * RecruitersOS · Automation scheduler  (the in-process n8n replacement)
 *
 * n8n was never doing real work in this stack — it was a CLOCK. Every engine
 * (cadence drafter, LinkedIn sequence engine, voice-drop dialer, email warm-up,
 * 6-month nurture) already lives inside RecruitersOS as a function. n8n just
 * pinged the cron endpoints on a timer and held a couple of webhooks. This
 * module is that clock, moved in-process: it arms once on server boot (via
 * instrumentation.ts) and ticks the same engines forever, calling them DIRECTLY
 * (no HTTP, no shared-secret round-trip). The cron HTTP endpoints stay as
 * manual / redundant external triggers.
 *
 * Master switch: AUTOMATION_ENABLED. Unset/`off` -> the clock never arms, so a
 * fresh deploy is inert until you opt in. Per-campaign switch: `campaign.autoRun`
 * (the "Autopilot" toggle) decides which campaigns run hands-off — the cadence
 * tick auto-approves + pushes only those, leaving manual campaigns human-gated.
 *
 * Every cycle mirrors the ATS scheduler's discipline: idempotent arm, per-task
 * overlap guard, unref'd timers (never hold the event loop open), and errors
 * swallowed so one bad cycle never touches a user request or stops the others.
 */

import { getCore } from "../core/repository";

let started = false;

/** Master switch — the whole clock is inert unless this is explicitly on. */
export function automationEnabled(): boolean {
  const v = (process.env.AUTOMATION_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Register one self-ticking, overlap-guarded, unref'd task. Each task owns its
 * own `running` flag so a slow cycle is skipped rather than overlapped, and the
 * timer is unref'd so it never keeps the process alive on its own.
 */
function every(label: string, ms: number, firstDelayMs: number, fn: () => Promise<void>): void {
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch {
      /* one bad cycle of `${label}` must never stop the clock or hit a request */
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void cycle(); }, firstDelayMs);
  const t = setInterval(() => { void cycle(); }, ms);
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}

/* ----------------------------- the five ticks ----------------------------- */

/** Advance the LinkedIn multi-channel cadence (due enrollments -> next step). */
async function tickLinkedin(): Promise<void> {
  const { SequenceEngine } = await import("../linkedin/sequenceEngine");
  const { getRepository } = await import("../linkedin/repository");
  await new SequenceEngine(getRepository()).tick(new Date(), 100);
}

/**
 * The LinkedIn OS shared engine tick: promote waiting actions into freed
 * capacity, execute due scheduled actions via the provider, advance LinkedIn
 * campaign enrollments and the slow-drip activation queue. EVERY LinkedIn
 * action (LinkedIn campaigns, multichannel workflows, hire signals, manual
 * sends) executes here and nowhere else.
 */
async function tickLinkedinOs(): Promise<void> {
  const { tickLinkedInOs } = await import("../linkedin/os/executor");
  await tickLinkedInOs();
}

/** Drain the AMD voicemail queue for every RUNNING voice campaign, in-window. */
async function tickVoice(): Promise<void> {
  const { ensureVoiceReady, listRunningCampaigns } = await import("../voice/store");
  const { runDueDrops } = await import("../voice/campaign");
  await ensureVoiceReady();
  const at = new Date();
  for (const c of listRunningCampaigns()) {
    try { await runDueDrops(c.workspaceId, c.id, at); } catch { /* skip one campaign */ }
  }
}

/** Daily email-infra maintenance: warm-up, reputation, governor, seeds, setup. */
async function tickSending(): Promise<void> {
  // Recruiter sender pool: roll the daily caps over (date-guarded — a no-op except on the first
  // tick of a new UTC day). pickSender also calls this lazily; here it keeps the Send Queue's
  // remaining-capacity numbers fresh even before the day's first send.
  try {
    const { resetDailyIfNewDay } = await import("../senders");
    await resetDailyIfNewDay();
  } catch { /* pool reset is best-effort; the lazy pick-time guard still covers sends */ }
  const { listSendingWorkspaceIds, runSendingDaily, runSeedMaintenance, listAutoSetupWorkspaceIds, advanceAutoSetup } = await import("../sending");
  for (const ws of await listAutoSetupWorkspaceIds()) {
    try { await advanceAutoSetup(ws); } catch { /* one workspace's setup */ }
  }
  for (const ws of await listSendingWorkspaceIds()) {
    try { await runSendingDaily(ws); } catch { /* one workspace */ }
  }
  try { await runSeedMaintenance(); } catch { /* seeds are global, best-effort */ }
}

/** Publish LinkedIn Poster posts that were approved for a scheduled time. */
async function tickLinkedinPosts(): Promise<void> {
  const { tickDuePosts } = await import("../linkedin/poster");
  await tickDuePosts(new Date());
}

/** Advance the 24-month BD nurture drip (due touches + triggers + dormant floor). */
async function tickNurture(): Promise<void> {
  const { runNurtureTick } = await import("../bd/nurtureCron");
  await runNurtureTick(new Date());
}

/**
 * Auto-enroll into the nurture drip — the in-process replacement for n8n polling
 * /api/prospects/queue. For every workspace that has opted into hands-off (at least one
 * active BD Autopilot campaign), enroll its eligible in-market BD prospects into the
 * 24-month drip, capped per cycle so it paces in. Workspaces without Autopilot keep the
 * manual portal "Activate" control. The nurture tick then sends the touches.
 */
async function tickNurtureEnroll(): Promise<void> {
  const { enrollEligible } = await import("../bd/nurtureEnroll");
  const all = await getCore().listAllCampaigns();
  const optedIn = new Set(
    all.filter((c) => c.motion === "bd" && c.status === "active" && c.autoRun).map((c) => c.workspaceId),
  );
  const cap = positiveIntEnv("RECRUITEROS_NURTURE_ENROLL_CAP", 50);
  for (const ws of optedIn) {
    try { await enrollEligible(ws, { limit: cap }); } catch { /* one workspace's enroll */ }
  }
}

/**
 * The Autopilot tick. For every workspace that owns at least one ACTIVE BD campaign
 * with `autoRun` on, run that workspace's hands-off campaigns end-to-end
 * (enrich -> draft -> send -> advance), bypassing the human approval queue.
 * Autopilot is BD-only; recruiting campaigns and manual campaigns are untouched —
 * their morning approval queue keeps working.
 */
async function tickCadence(): Promise<void> {
  const { runAutopilot } = await import("../campaigns");
  const all = await getCore().listAllCampaigns();
  const autopilotWorkspaces = new Set(
    all.filter((c) => c.motion === "bd" && c.status === "active" && c.autoRun).map((c) => c.workspaceId),
  );
  for (const ws of autopilotWorkspaces) {
    try { await runAutopilot(ws); } catch { /* one workspace's autopilot */ }
  }
}

/**
 * The five ticks, defined ONCE so the scheduler and the UI describe the same
 * thing. Each: a stable key, a human label, its env override + default
 * interval, the staggered first-delay (so boot doesn't fire all five at once),
 * and the engine function it drives.
 */
interface TickSpec { key: string; label: string; env: string; defaultMs: number; firstDelayMs: number; fn: () => Promise<void>; }
const TICKS: TickSpec[] = [
  { key: "cadence", label: "Pull + draft + send (Autopilot)", env: "RECRUITEROS_CADENCE_TICK_MS", defaultMs: 30 * 60_000, firstDelayMs: 90_000, fn: tickCadence },
  { key: "linkedin", label: "LinkedIn cadence", env: "RECRUITEROS_LINKEDIN_TICK_MS", defaultMs: 3 * 60_000, firstDelayMs: 30_000, fn: tickLinkedin },
  { key: "linkedin_os", label: "LinkedIn OS shared engine", env: "RECRUITEROS_LINKEDIN_OS_TICK_MS", defaultMs: 2 * 60_000, firstDelayMs: 40_000, fn: tickLinkedinOs },
  { key: "linkedin_posts", label: "LinkedIn Poster scheduled posts", env: "RECRUITEROS_LINKEDIN_POSTS_TICK_MS", defaultMs: 60_000, firstDelayMs: 35_000, fn: tickLinkedinPosts },
  { key: "voice", label: "Voicemail drops", env: "RECRUITEROS_VOICE_TICK_MS", defaultMs: 15 * 60_000, firstDelayMs: 45_000, fn: tickVoice },
  { key: "nurture_enroll", label: "Auto-enroll into nurture", env: "RECRUITEROS_NURTURE_ENROLL_TICK_MS", defaultMs: 30 * 60_000, firstDelayMs: 50_000, fn: tickNurtureEnroll },
  { key: "nurture", label: "24-month nurture drip", env: "RECRUITEROS_NURTURE_TICK_MS", defaultMs: 6 * 60 * 60_000, firstDelayMs: 60_000, fn: tickNurture },
  { key: "sending", label: "Email warm-up + reputation", env: "RECRUITEROS_SENDING_TICK_MS", defaultMs: 6 * 60 * 60_000, firstDelayMs: 75_000, fn: tickSending },
];

/** The configured ticks (key, label, effective interval ms) — for the Autopilot
 *  dashboard, so the UI shows the real cadence (including any env overrides). */
export function automationTicks(): Array<{ key: string; label: string; everyMs: number }> {
  return TICKS.map((t) => ({ key: t.key, label: t.label, everyMs: positiveIntEnv(t.env, t.defaultMs) }));
}

/** Whether the in-process clock is armed in THIS process (vs. merely enabled by env). */
export function automationArmed(): boolean {
  return started;
}

/**
 * Idempotently arm the whole automation clock. Safe to call repeatedly — only
 * arms once per process. No-op (and logs why) when the master switch is off.
 */
export function ensureAutomationScheduler(): void {
  if (started) return;
  if (!automationEnabled()) {
    console.log("[automation] AUTOMATION_ENABLED is off — internal clock not armed (set AUTOMATION_ENABLED=on to run campaigns hands-off).");
    return;
  }
  started = true;
  for (const t of TICKS) every(t.key, positiveIntEnv(t.env, t.defaultMs), t.firstDelayMs, t.fn);
  console.log("[automation] internal clock armed — campaigns with Autopilot on now run hands-off (no n8n).");
}
