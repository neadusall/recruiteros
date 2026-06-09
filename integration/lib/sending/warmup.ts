/**
 * RecruiterOS · Warm-up engine
 * Ramps each mailbox's daily cap on a slow, organic-looking curve and graduates
 * it from "warming" to "active" once it reaches a steady ceiling.
 *
 * The optional synthetic-engagement round (mailbox↔mailbox sends to build
 * positive history) is GATED behind SENDING_WARMUP_ENGAGE=1 because high-volume
 * synthetic loops carry Gmail/Outlook ToS + detection risk (see the design doc).
 * The cap-ramp alone is the safe default and the bulk of the value.
 */

import { allMailboxes, saveMailbox, getServer, getDomain } from "./store";
import { capForDay } from "./caps";
import { sendMessage, postalConfigured } from "./postal";

const CEILING = Number(process.env.SENDING_MAILBOX_CEILING || 50);

/** Advance every warming mailbox one ramp day; graduate at the ceiling. */
export async function advanceWarmup(workspaceId: string): Promise<{ advanced: number; graduated: number }> {
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
  return { advanced, graduated };
}

/**
 * Optional synthetic warm-up round: send a light, capped set of mailbox→mailbox
 * messages to build sending history. OFF unless SENDING_WARMUP_ENGAGE=1. Kept
 * deliberately small and slow; this is reputation-ASSISTING, not a guarantee.
 */
export async function runWarmupRound(workspaceId: string): Promise<{ sent: number; skipped: boolean }> {
  if (process.env.SENDING_WARMUP_ENGAGE !== "1") return { sent: 0, skipped: true };
  const boxes = (await allMailboxes(workspaceId)).filter((m) => m.status !== "paused");
  if (boxes.length < 2) return { sent: 0, skipped: true };

  let sent = 0;
  const perRound = Math.min(boxes.length, 5); // small, slow
  for (let i = 0; i < perRound; i++) {
    const from = boxes[i];
    const to = boxes[(i + 1) % boxes.length];
    const domain = await getDomain(workspaceId, from.domainId);
    const server = domain?.serverId ? await getServer(workspaceId, domain.serverId) : undefined;
    if (!server || !postalConfigured(server)) continue;
    try {
      await sendMessage(server, {
        from: from.address,
        to: to.address,
        subject: "Re: quick sync",
        plainBody: "Thanks — sounds good, let's circle back this week.",
      });
      sent++;
    } catch { /* skip */ }
  }
  return { sent, skipped: false };
}
