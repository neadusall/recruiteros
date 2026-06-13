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

const CEILING = Number(process.env.SENDING_MAILBOX_CEILING || 50);
const IP_CEILING = Number(process.env.SENDING_IP_CEILING || 1000);

/**
 * Advance every warming mailbox one ramp day (graduate at the ceiling), AND ramp
 * each live server's shared-IP daily ceiling on its own slower curve — the IP is
 * the long pole, so a cold IPv4 is warmed gently or every mailbox on it suffers.
 */
export async function advanceWarmup(workspaceId: string): Promise<{ advanced: number; graduated: number; ipsAdvanced: number }> {
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
