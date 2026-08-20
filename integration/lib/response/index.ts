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
  // The store hydrates lazily from the durable snapshot. Ingest MUST wait for
  // it: on a fresh boot the seen-set is empty until hydration lands, so the
  // first sync tick after a deploy would re-claim every message still in its
  // queue file — resurrecting rows the recruiter already deleted.
  await inbox.ready();

  let inbound = normalize(source, workspaceId, payload);
  if (!inbound) return null;                        // not a reply event we handle
  if (!inbox.claim(inbound.providerMessageId)) return null; // already processed

  inbound = await matchProspect(inbound);

  // PROVE IT IS REAL, OR DO NOT KEEP IT.
  //
  // The fleet warms through Smartlead, whose traffic is deliberately indistinguishable from
  // business mail — no header, no tag, nothing to filter on (checked against live headers).
  // It arrived at ~1,200 rows a day and filled the whole 3,000-row store in under three days,
  // leaving it with zero real replies in it on 2026-08-20.
  //
  // The one thing that does separate them: a real reply comes from someone we emailed. Note
  // that a prospect record is NOT the test — the MPC engine's leads live in the curation pool,
  // not the core store, so most genuine replies arrive with prospectId null and used to be
  // indistinguishable from chatter. contacted.ts closes exactly that gap.
  if (inbound.prospectId) inbound.verified = "prospect";
  else if (inbound.campaignId) inbound.verified = "campaign";
  else if (inbound.channel === "email") {
    const { wasContacted } = await import("./contacted");
    const proof = await wasContacted(workspaceId, inbound.fromHandle);
    if (proof) inbound.verified = proof === "address" ? "contacted_address" : "contacted_domain";
  }
  const unverifiedEmail = inbound.channel === "email" && !inbound.verified;
  // Unproven email still gets the free heuristics, but never a model call and never a hot label.
  const classification = await classify(inbound.text, unverifiedEmail ? { ...hints, unverifiedSender: true } : hints);

  // Chatter stops here. Anything the heuristics DID recognise is kept even from a stranger —
  // an opt-out, a booking link, an out-of-office all carry real signal and are cheap to hold.
  // The filter only engages once this workspace has published a contacted set to test against:
  // without one, wasContacted() cannot distinguish anything, and silently dropping every
  // inbound would be far worse than keeping noise. The provider message id stays claimed, so
  // the next sync tick does not re-examine the same message forever.
  if (unverifiedEmail && classification.class === "unclassified") {
    const { hasContactedSet } = await import("./contacted");
    if (await hasContactedSet(workspaceId)) {
      inbox.noteChatter(workspaceId);
      return null;
    }
  }
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
