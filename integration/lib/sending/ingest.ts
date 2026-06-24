/**
 * RecruitersOS · Delivery-event ingest
 * Apply a normalized delivery event (from the Postal webhook) to the metrics +
 * suppression + governor. One entry point so the webhook stays thin.
 */

import { resolveSender, saveDomain, saveMailbox, recordEvent, suppress } from "./store";
import { ensureMetrics, runGovernor } from "./governor";
import { isMachineOpen } from "./openClass";
import type { SendEvent } from "./types";

export type DeliveryEventType = "delivered" | "bounce" | "complaint" | "open";

/**
 * Apply one event. `from` maps it to a domain/mailbox; `to` is the recipient
 * (suppressed on bounce/complaint). Bumps counters, records the event, and runs
 * the governor so a bad domain pauses immediately.
 *
 * For opens we classify human vs machine (Apple MPP / image proxies / bots) from
 * the user-agent + IP + raw event name, and keep only human opens in
 * `openedHuman` so the engagement signal isn't inflated by automated prefetch.
 */
export async function applyDeliveryEvent(ev: {
  type: DeliveryEventType;
  from: string;
  to: string;
  detail?: string;
  eventName?: string;
  userAgent?: string;
  ip?: string;
}): Promise<void> {
  const resolved = await resolveSender(ev.from);
  if (!resolved) return;
  const { workspaceId, mailbox, domain } = resolved;

  const machineOpen = ev.type === "open" && isMachineOpen({ eventName: ev.eventName, userAgent: ev.userAgent, ip: ev.ip });

  if (domain) {
    const m = ensureMetrics(domain);
    if (ev.type === "delivered") m.delivered += 1;
    else if (ev.type === "bounce") m.bounced += 1;
    else if (ev.type === "complaint") m.complained += 1;
    else if (ev.type === "open") {
      m.opened += 1;
      if (!machineOpen) m.openedHuman = (m.openedHuman || 0) + 1;
    }
    await saveDomain(domain);
  }
  if (mailbox) {
    if (ev.type === "bounce") mailbox.bounced += 1;
    if (ev.type === "complaint") mailbox.complained += 1;
    await saveMailbox(mailbox);
  }

  if (ev.type === "bounce") await suppress(ev.to, "bounce", "postal");
  if (ev.type === "complaint") await suppress(ev.to, "complaint", "postal");

  await recordEvent({
    type: ev.type as SendEvent["type"],
    domainId: domain?.id,
    mailboxId: mailbox?.id,
    to: ev.to,
    detail: ev.detail,
  });

  // Trip the governor right away on negative signals.
  if (ev.type === "bounce" || ev.type === "complaint") await runGovernor(workspaceId);

  // Close the Hire Signals tracking loop: tie this delivery event back to the curated prospect
  // by recipient email, so the funnel shows sent → opened → replied → bounced per hiring signal.
  try {
    const { recordSendEvent } = await import("../inmarket/curation");
    const mapped = ev.type === "delivered" ? "sent" : ev.type === "open" ? "open" : ev.type === "bounce" ? "bounce" : null;
    if (mapped) await recordSendEvent(ev.to, mapped, new Date().toISOString());
  } catch { /* tracking is best-effort */ }
}

/** Map a raw Postal webhook event name to our normalized type (or null to ignore). */
export function mapPostalEvent(name: string): DeliveryEventType | null {
  switch (name) {
    case "MessageDelivered": return "delivered";
    case "MessageDeliveryFailed":
    case "MessageBounced":
    case "MessageHeld": return "bounce";
    case "MessageSpamComplaint":
    case "DomainSpamComplaint": return "complaint";
    case "MessageLoaded":
    case "MessageLinkClicked": return "open";
    default: return null;
  }
}
