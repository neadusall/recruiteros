/**
 * RecruiterOS · Response
 * The end-to-end pipeline: ingest -> match -> classify -> route -> record.
 *
 *   const out = await processInbound("instantly", workspaceId, rawWebhookBody);
 *
 * One call per inbound reply. Idempotent on the provider message id, so retried
 * webhooks are safe. Returns the processed result (or null if not a reply event).
 */

import { normalize, matchProspect } from "./ingest";
import { classify } from "./classify";
import { route, type PauseSequences } from "./router";
import { getInbox } from "./repository";
import type { ProcessedResponse, ResponseSource } from "./types";

export * from "./types";
export { ROUTING_RULES, CLASS_ORDER, ruleFor } from "./rules";
export { classify, fastPath } from "./classify";
export { route, markBooked } from "./router";
export { suppress, isSuppressed, listSuppression } from "./suppression";
export { getInbox } from "./repository";

export async function processInbound(
  source: ResponseSource,
  workspaceId: string,
  payload: Record<string, unknown>,
  pauseSequences?: PauseSequences,
): Promise<ProcessedResponse | null> {
  const inbox = getInbox();

  let inbound = normalize(source, workspaceId, payload);
  if (!inbound) return null;                        // not a reply event we handle
  if (!inbox.claim(inbound.providerMessageId)) return null; // already processed

  inbound = await matchProspect(inbound);
  const classification = await classify(inbound.text);
  const processed = await route(inbound, classification, pauseSequences);

  inbox.add(processed);
  return processed;
}

/** Convenience for the inbox UI / list route. */
export function recentResponses(workspaceId: string, limit = 100): ProcessedResponse[] {
  return getInbox().list(workspaceId, limit);
}
