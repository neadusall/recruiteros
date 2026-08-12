/**
 * RecruitersOS · Response
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
  hints?: import("./classify").ClassifyHints,
): Promise<ProcessedResponse | null> {
  const inbox = getInbox();

  let inbound = normalize(source, workspaceId, payload);
  if (!inbound) return null;                        // not a reply event we handle
  if (!inbox.claim(inbound.providerMessageId)) return null; // already processed

  inbound = await matchProspect(inbound);
  // Email from a sender we cannot tie to a prospect or campaign is warm-up
  // network chatter (it arrives hundreds a day on the fleet boxes): keep the
  // free heuristics but never spend a model call or a hot label on it.
  const unverifiedEmail = inbound.channel === "email" && !inbound.prospectId && !inbound.campaignId;
  const classification = await classify(inbound.text, unverifiedEmail ? { ...hints, unverifiedSender: true } : hints);
  const processed = await route(inbound, classification, pauseSequences);

  inbox.add(processed);

  // Pre-draft the reply so it is already waiting in the composer when the
  // recruiter opens the thread. Fire-and-forget: ingest never waits on the AI.
  import("./draft").then((d) => void d.preDraft(workspaceId, processed).catch(() => {})).catch(() => {});

  return processed;
}

/** Convenience for the inbox UI / list route. */
export function recentResponses(workspaceId: string, limit = 100): Promise<ProcessedResponse[]> {
  return getInbox().list(workspaceId, limit);
}
