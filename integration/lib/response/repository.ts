/**
 * RecruiterOS · Response
 * Inbox store: processed responses + idempotency on provider message ids.
 */

import type { ProcessedResponse } from "./types";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

class InboxStore {
  items: ProcessedResponse[] = [];
  seen = new Set<string>();

  private persist = debouncedSaver("inbox", () => ({
    items: this.items,
    seen: [...this.seen],
  }));
  private hydrated: Promise<void> | null = null;
  ready(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = dbEnabled()
        ? loadSnapshot<any>("inbox").then((s) => {
            if (!s) return;
            this.items = s.items || [];
            this.seen = new Set(s.seen || []);
          }).catch(() => {})
        : Promise.resolve();
    }
    return this.hydrated;
  }

  /** Returns false if this provider message was already processed. */
  claim(providerMessageId: string): boolean {
    if (this.seen.has(providerMessageId)) return false;
    this.seen.add(providerMessageId);
    this.persist();
    return true;
  }

  add(p: ProcessedResponse): void {
    this.items.unshift(p);
    this.persist();
  }

  async list(workspaceId: string, limit = 100): Promise<ProcessedResponse[]> {
    await this.ready();
    return this.items
      .filter((p) => p.inbound.workspaceId === workspaceId)
      .slice(0, limit);
  }
}

const singleton = new InboxStore();
export function getInbox(): InboxStore {
  return singleton;
}
