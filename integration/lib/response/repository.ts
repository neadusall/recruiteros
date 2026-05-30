/**
 * RecruiterOS · Response
 * Inbox store: processed responses + idempotency on provider message ids.
 */

import type { ProcessedResponse } from "./types";

class InboxStore {
  items: ProcessedResponse[] = [];
  seen = new Set<string>();

  /** Returns false if this provider message was already processed. */
  claim(providerMessageId: string): boolean {
    if (this.seen.has(providerMessageId)) return false;
    this.seen.add(providerMessageId);
    return true;
  }

  add(p: ProcessedResponse): void {
    this.items.unshift(p);
  }

  list(workspaceId: string, limit = 100): ProcessedResponse[] {
    return this.items
      .filter((p) => p.inbound.workspaceId === workspaceId)
      .slice(0, limit);
  }
}

const singleton = new InboxStore();
export function getInbox(): InboxStore {
  return singleton;
}
