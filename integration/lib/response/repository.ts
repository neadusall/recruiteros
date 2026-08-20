/**
 * RecruitersOS · Response
 * Inbox store: processed responses + idempotency on provider message ids.
 */

import type { ProcessedResponse, OutboundNote } from "./types";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

/** Identity-verified: matched to a prospect we know, attributed to a campaign send (the MPC
 *  bridge only queues sender-verified replies), or proved by `verified` — the sender is
 *  someone this workspace has actually emailed. Email rows with none of the three are warm-up
 *  network chatter arriving hundreds a day; they must never crowd out or evict a real reply.
 *  Rows ingested before `verified` existed still pass on the first two, so history is safe. */
export function isRealReply(p: ProcessedResponse): boolean {
  return !!(p.inbound.prospectId || p.inbound.campaignId || p.inbound.verified);
}

class InboxStore {
  items: ProcessedResponse[] = [];
  seen = new Set<string>();
  outbound: OutboundNote[] = [];
  /** workspace -> yyyy-mm-dd -> how much warm-up chatter was filtered out that day. Kept so a
   *  quiet reply inbox can be read correctly: "nobody wrote back" and "we are dropping the
   *  wrong things" look identical without it. */
  chatter: Record<string, Record<string, number>> = {};

  private saver = debouncedSaver("inbox", () => ({
    items: this.items,
    seen: [...this.seen],
    outbound: this.outbound,
    chatter: this.chatter,
  }));
  /** Never let a save run before hydration: a mutation on a not-yet-hydrated
   *  store would snapshot the near-empty boot state over the durable file,
   *  wiping history and every delete ever made. */
  private persist = (): void => {
    void this.ready().then(() => this.saver());
  };
  private hydrated: Promise<void> | null = null;
  ready(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = dbEnabled()
        ? loadSnapshot<any>("inbox").then((s) => {
            if (!s) return;
            this.seen = new Set(s.seen || []);
            // Deleted rows do not ride along: drop them from the store for good,
            // keeping only their provider message ids claimed so the sync ticks
            // (which re-read their queue files every pass) can never re-ingest them.
            const items: ProcessedResponse[] = [];
            for (const p of (s.items || []) as ProcessedResponse[]) {
              if (p?.deletedAt) {
                if (p.inbound?.providerMessageId) this.seen.add(p.inbound.providerMessageId);
                continue;
              }
              items.push(p);
            }
            this.items = items;
            this.outbound = s.outbound || [];
            this.chatter = s.chatter || {};
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
    // Belt and braces: the ingest pipeline claims before add, but the seen guard
    // must hold even for a future path that forgets — especially so a DELETED
    // row can never be re-ingested by the next sync tick.
    if (p.inbound.providerMessageId) this.seen.add(p.inbound.providerMessageId);
    this.persist();
  }

  /** Record one filtered warm-up message. Deliberately not stored as a row: the whole point is
   *  that chatter no longer occupies the inbox. Trimmed to the last 30 days. */
  noteChatter(workspaceId: string): void {
    const day = new Date().toISOString().slice(0, 10);
    const w = (this.chatter[workspaceId] ??= {});
    w[day] = (w[day] || 0) + 1;
    const days = Object.keys(w).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 30))) delete w[d];
    this.persist();
  }

  /** How much chatter was filtered for a workspace over the last `days` days. */
  async chatterFiltered(workspaceId: string, days = 1): Promise<number> {
    await this.ready();
    const w = this.chatter[workspaceId] || {};
    return Object.keys(w).sort().slice(-days).reduce((n, d) => n + (w[d] || 0), 0);
  }

  async list(workspaceId: string, limit = 100): Promise<ProcessedResponse[]> {
    await this.ready();
    const mine = this.items.filter((p) => p.inbound.workspaceId === workspaceId && !p.deletedAt);
    // Real replies are first-class citizens of this list: a plain newest-N slice
    // lets warm-up chatter push a day-old real reply out of the window entirely.
    // Every real reply makes the list; unverified rows only fill what is left.
    const real = mine.filter(isRealReply).slice(0, limit);
    const rest = mine.filter((p) => !isRealReply(p)).slice(0, Math.max(0, limit - real.length));
    return [...real, ...rest].sort((a, b) =>
      (b.inbound.receivedAt || "").localeCompare(a.inbound.receivedAt || ""));
  }

  /** One response by inbound id, scoped to the workspace (for reply-in-place). */
  async getById(workspaceId: string, id: string): Promise<ProcessedResponse | undefined> {
    await this.ready();
    return this.items.find((p) => p.inbound.id === id && p.inbound.workspaceId === workspaceId);
  }

  /** Every non-deleted inbox row for one person: by prospect id or any known handle.
   *  Handles compare case-insensitively (emails, linkedin urls). */
  async forPerson(workspaceId: string, keys: { prospectId?: string | null; handles?: (string | undefined | null)[] }): Promise<ProcessedResponse[]> {
    await this.ready();
    const handles = new Set((keys.handles || []).filter(Boolean).map((h) => String(h).trim().toLowerCase()));
    return this.items.filter((p) => {
      if (p.inbound.workspaceId !== workspaceId || p.deletedAt) return false;
      if (keys.prospectId && p.inbound.prospectId === keys.prospectId) return true;
      const h = (p.inbound.fromHandle || "").trim().toLowerCase();
      return !!h && handles.has(h);
    });
  }

  /** Record an outbound message sent from the reply center. */
  async addOutbound(note: OutboundNote): Promise<void> {
    await this.ready();
    this.outbound.unshift(note);
    this.persist();
  }

  /** Outbound reply-center messages for one person (prospect id or response ids). */
  async outboundForPerson(workspaceId: string, keys: { prospectId?: string | null; responseIds?: string[] }): Promise<OutboundNote[]> {
    await this.ready();
    const rids = new Set(keys.responseIds || []);
    return this.outbound.filter((n) =>
      n.workspaceId === workspaceId &&
      ((keys.prospectId && n.prospectId === keys.prospectId) || rids.has(n.responseId)));
  }

  /** Delete a response from the inbox. Deleting is forever: the row leaves the
   *  store entirely and its provider message id stays claimed, so the sync
   *  ticks that re-read their queue files can never bring it back. */
  async remove(workspaceId: string, id: string): Promise<boolean> {
    await this.ready();
    const i = this.items.findIndex((x) => x.inbound.id === id && x.inbound.workspaceId === workspaceId);
    if (i < 0) return false;
    const pm = this.items[i].inbound.providerMessageId;
    if (pm) this.seen.add(pm);
    this.items.splice(i, 1);
    this.persist();
    return true;
  }

  /** Every distinct workspace that has rows in the store (for background ticks). */
  async workspaceIds(): Promise<string[]> {
    await this.ready();
    return [...new Set(this.items.map((p) => p.inbound.workspaceId))];
  }

  /** Stamp a row as escalated to the operator (the watchdog sends that email once). */
  async markEscalated(workspaceId: string, id: string): Promise<void> {
    await this.ready();
    const p = this.items.find((x) => x.inbound.id === id && x.inbound.workspaceId === workspaceId);
    if (p) { p.escalatedAt = new Date().toISOString(); this.persist(); }
  }

  /** Bound the snapshot so it can never grow without limit. Newest rows are kept
   *  (items are unshifted); the seen-id guard is rebuilt from the newest entries. */
  async prune(maxItems = 3000, maxOutbound = 3000, maxSeen = 20000, maxUnverified = 200): Promise<number> {
    await this.ready();
    let dropped = 0;
    // Warm-up chatter gets its own small quota, well under the overall cap. Evicting it only
    // once the store is FULL was not enough: on 2026-08-20 all 3,000 rows were chatter, so
    // real replies were perfectly protected and there were none left to protect. New chatter
    // no longer enters the store at all; this is what drains what is already sitting in it.
    // Per WORKSPACE, so one noisy tenant's chatter can never squeeze out another's.
    {
      const perWs = new Map<string, number>();
      const evict = new Set<ProcessedResponse>();
      for (const p of this.items) {            // newest-first
        if (isRealReply(p) || p.deletedAt) continue;
        const ws = p.inbound.workspaceId;
        const n = (perWs.get(ws) || 0) + 1;
        perWs.set(ws, n);
        if (n > maxUnverified) evict.add(p);
      }
      if (evict.size) {
        this.items = this.items.filter((p) => !evict.has(p));
        dropped += evict.size;
      }
    }
    if (this.items.length > maxItems) {
      // Evict warm-up chatter before any real reply: drop unverified rows from
      // the old end first, and only truncate real rows if the store is somehow
      // all-real (then oldest-first, as before).
      let toDrop = this.items.length - maxItems;
      const kept: ProcessedResponse[] = [];
      for (let i = this.items.length - 1; i >= 0; i--) {
        const p = this.items[i];
        if (toDrop > 0 && !isRealReply(p)) { toDrop--; continue; }
        kept.push(p);
      }
      kept.reverse();
      if (kept.length > maxItems) kept.length = maxItems;
      dropped += this.items.length - kept.length;
      this.items = kept;
    }
    if (this.outbound.length > maxOutbound) { dropped += this.outbound.length - maxOutbound; this.outbound.length = maxOutbound; }
    if (this.seen.size > maxSeen) {
      const keep = [...this.seen];
      this.seen = new Set(keep.slice(keep.length - maxSeen)); // newest claims are appended last
      dropped += keep.length - maxSeen;
    }
    if (dropped) this.persist();
    return dropped;
  }

  /** Attach the on-arrival AI pre-draft to a response. */
  async setSuggested(workspaceId: string, id: string, s: { text: string; objective: string; at: string }): Promise<boolean> {
    await this.ready();
    const p = this.items.find((x) => x.inbound.id === id && x.inbound.workspaceId === workspaceId);
    if (!p) return false;
    p.suggestedReply = s;
    this.persist();
    return true;
  }

  /** Snooze a response until a moment (empty/undefined clears the snooze). */
  async setSnooze(workspaceId: string, id: string, until?: string): Promise<boolean> {
    await this.ready();
    const p = this.items.find((x) => x.inbound.id === id && x.inbound.workspaceId === workspaceId);
    if (!p) return false;
    p.snoozedUntil = until || undefined;
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

// The Next.js server compiles this module into TWO webpack instances (the
// instrumentation/scheduler layer and the API-route layer each get their own
// module id). A plain module-level singleton therefore existed TWICE in one
// process, each with its own items[] and its own debounced writer to the same
// snap_inbox.json - whichever instance persisted last silently reverted the
// other's mutations. Observed in prod: a recruiter's delete (route instance)
// was resurrected minutes later by a scheduler-instance persist, and every
// route-side OutboundNote was wiped the same way. Pinning the instance on
// globalThis makes every compiled copy share ONE store and ONE writer.
const g = globalThis as { __rosInboxStore?: InboxStore };
const singleton = (g.__rosInboxStore ??= new InboxStore());
export function getInbox(): InboxStore {
  return singleton;
}
