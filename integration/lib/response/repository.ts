/**
 * RecruitersOS · Response
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
      .filter((p) => p.inbound.workspaceId === workspaceId && !p.deletedAt)
      .slice(0, limit);
  }

  /** One response by inbound id, scoped to the workspace (for reply-in-place). */
  async getById(workspaceId: string, id: string): Promise<ProcessedResponse | undefined> {
    await this.ready();
    return this.items.find((p) => p.inbound.id === id && p.inbound.workspaceId === workspaceId);
  }

  /** Delete a response from the inbox (soft: kept in the snapshot, never listed). */
  async remove(workspaceId: string, id: string): Promise<boolean> {
    await this.ready();
    const p = this.items.find((x) => x.inbound.id === id && x.inbound.workspaceId === workspaceId);
    if (!p) return false;
    p.deletedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  /** Mark a response handled (cleared from the daily worklist) or un-handle it. */
  async setHandled(workspaceId: string, id: string, handled: boolean): Promise<boolean> {
    await this.ready();
    const p = this.items.find((x) => x.inbound.id === id && x.inbound.workspaceId === workspaceId);
    if (!p) return false;
    p.handledAt = handled ? new Date().toISOString() : undefined;
    this.persist();
    return true;
  }
}

const singleton = new InboxStore();
export function getInbox(): InboxStore {
  return singleton;
}
