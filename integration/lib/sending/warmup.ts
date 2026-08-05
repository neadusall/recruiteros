/**
 * RecruitersOS · Warm-up engine
 * Ramps each mailbox's daily cap on a slow, organic-looking curve and graduates
 * it from "warming" to "active" once it reaches a steady ceiling.
 *
 * The optional synthetic-engagement round (mailbox↔mailbox sends to build
 * positive history) is GATED behind SENDING_WARMUP_ENGAGE=1 because high-volume
 * synthetic loops carry Gmail/Outlook ToS + detection risk (see the design doc).
 * The cap-ramp alone is the safe default and the bulk of the value.
 */

import { allMailboxes, saveMailbox, listServers, saveServer } from "./store";
import { capForDay, serverCapForDay } from "./caps";
import { postalConfigured } from "./postal";
import { runEngagement } from "./engagement";
import { loadSnapshot, debouncedSaver } from "../db";

const CEILING = Number(process.env.SENDING_MAILBOX_CEILING || 50);
const IP_CEILING = Number(process.env.SENDING_IP_CEILING || 1000);

/**
 * Once-per-UTC-day guard. advanceWarmup used to advance on EVERY caller (the
 * 6h scheduler tick, the hourly external cron, the manual button), which burned
 * ~4+ ramp days per calendar day: a mailbox hit full volume in ~2 days and a
 * cold IP compressed its ~3-week ramp into ~5 days. A ramp day is a calendar
 * day, period. Same pattern as lib/senders/store.resetDailyIfNewDay.
 */
interface WarmupClock { lastAdvanceDay: Record<string, string> } // workspaceId -> YYYY-MM-DD (UTC)
const CLOCK_KEY = "sending_warmup_clock_v1";
let clock: WarmupClock = { lastAdvanceDay: {} };
let clockHydrated = false;
let clockHydrating: Promise<void> | null = null;
const saveClock = debouncedSaver(CLOCK_KEY, () => clock);

async function alreadyAdvancedToday(workspaceId: string): Promise<boolean> {
  if (!clockHydrated) {
    if (!clockHydrating) {
      clockHydrating = loadSnapshot<WarmupClock>(CLOCK_KEY).then((s) => {
        if (s?.lastAdvanceDay) clock = s;
        clockHydrated = true;
      });
    }
    await clockHydrating;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (clock.lastAdvanceDay[workspaceId] === today) return true;
  clock.lastAdvanceDay[workspaceId] = today;
  saveClock();
  return false;
}

/**
 * Advance every warming mailbox one ramp day (graduate at the ceiling), AND ramp
 * each live server's shared-IP daily ceiling on its own slower curve — the IP is
 * the long pole, so a cold IPv4 is warmed gently or every mailbox on it suffers.
 * No-ops for the rest of the day after the first call (date-guarded).
 */
export async function advanceWarmup(workspaceId: string): Promise<{ advanced: number; graduated: number; ipsAdvanced: number }> {
  if (await alreadyAdvancedToday(workspaceId)) return { advanced: 0, graduated: 0, ipsAdvanced: 0 };
  let advanced = 0;
  let graduated = 0;
  for (const m of await allMailboxes(workspaceId)) {
    if (m.status !== "warming") continue;
    m.warmupDay += 1;
    m.dailyCap = capForDay(m.warmupDay, CEILING);
    if (m.dailyCap >= CEILING) { m.status = "active"; graduated++; }
    advanced++;
    await saveMailbox(m);
  }
  let ipsAdvanced = 0;
  for (const s of await listServers(workspaceId)) {
    if (!postalConfigured(s)) continue;                       // only live IPs warm
    if (serverCapForDay(s.warmupDay ?? 0, IP_CEILING) >= IP_CEILING) continue; // already warm
    s.warmupDay = (s.warmupDay ?? 0) + 1;
    s.dailyCap = serverCapForDay(s.warmupDay, IP_CEILING);
    ipsAdvanced++;
    await saveServer(s);
  }
  return { advanced, graduated, ipsAdvanced };
}

/**
 * One warm-up engagement round. Delegates to the real bidirectional engine
 * (engagement.ts): warming mailboxes -> real-provider seed inboxes, then the seed
 * client rescues-from-spam / opens / replies over IMAP+SMTP. OFF unless
 * SENDING_WARMUP_ENGAGE=1. Driven frequently by /api/sending/warmup/cron.
 */
export async function runWarmupRound(workspaceId: string): Promise<{ sent: number; skipped: boolean }> {
  const r = await runEngagement(workspaceId);
  return { sent: r.sent, skipped: r.skipped };
}
