/**
 * RecruitersOS · In-backend LinkedIn bridge ("our own side", no Unipile)
 *
 * This is the provider RecruitersOS uses by default: instead of a third-party API
 * (Unipile) or a separate bridge process, the work runs in the user's OWN browser
 * via the Chrome extension, coordinated entirely inside this backend and persisted
 * in the database.
 *
 *   importFromLinkedInSearch ─► backendBridgeProvider.searchProfiles()
 *        enqueues a `search` action (DB) and long-polls
 *                         │
 *   extension ─ POST /api/linkedin/agent/poll  (Bearer <ext-token> → workspace)
 *        claims the action, scrapes the search human-like, then
 *   extension ─ POST /api/linkedin/agent/search-result { items, done }
 *        resolves the long-poll → profiles flow back → Prospects.
 *
 * Single-instance (docker compose) friendly: the action queue is persisted via
 * the shared DB snapshot layer (survives restarts); the in-flight search waiters
 * live in-memory (a restart mid-search just times out to a partial, and the
 * queued action is re-claimable). No DATABASE_URL → pure in-memory (local/demo).
 */

import { listLinkedInAccounts } from "../accounts";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { LinkedInProvider, SearchProfile } from "./provider";
import type { ActionResult } from "./types";

export interface BridgeAction {
  id: string;
  accountId: string;                 // RecruitersOS LinkedIn account id (liacc_…)
  type: string;                      // search | connect | message | inmail | voice_note | profile_view | endorse | withdraw_invite
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  status: "queued" | "claimed" | "done" | "failed";
  result: unknown;
  createdAt: string;
}

let actions: BridgeAction[] = [];
const searchWaiters = new Map<string, { items: SearchProfile[]; resolve: (v: SearchProfile[]) => void }>();
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 110_000);

// Persist only the live (queued/claimed) actions; finished ones are disposable.
const persist = debouncedSaver("linkedin_bridge", () =>
  actions.filter((a) => a.status === "queued" || a.status === "claimed"),
);
let hydrated: Promise<void> | null = null;
function ready(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<BridgeAction[]>("linkedin_bridge")
          .then((rows) => { if (rows) actions = rows; })
          .catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}

let seq = 0;
function uid(p: string): string {
  seq += 1;
  return `${p}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function enqueue(accountId: string, type: string, target: Record<string, unknown>, payload: Record<string, unknown>): BridgeAction {
  const a: BridgeAction = {
    id: uid("act"), accountId, type, target: target || {}, payload: payload || {},
    status: "queued", result: null, createdAt: new Date().toISOString(),
  };
  actions.push(a);
  persist();
  return a;
}

async function workspaceAccountIds(ws: string): Promise<Set<string>> {
  return new Set(listLinkedInAccounts(ws).map((a) => a.id));
}

/* ---------------- extension-facing (called by the ext-token-authed routes) ---------------- */

/** Claim the next queued action for any of this workspace's LinkedIn accounts. */
export async function claimNext(ws: string): Promise<BridgeAction | null> {
  await ready();
  const ids = await workspaceAccountIds(ws);
  const a = actions.find((x) => x.status === "queued" && ids.has(x.accountId));
  if (a) { a.status = "claimed"; persist(); }
  return a || null;
}

/** Record the outcome of a one-off action (connect/message/…) for this workspace. */
export async function reportResult(
  ws: string,
  actionId: string,
  ok: boolean,
  info?: string,
  providerMessageId?: string,
): Promise<boolean> {
  await ready();
  const ids = await workspaceAccountIds(ws);
  const a = actions.find((x) => x.id === actionId && ids.has(x.accountId));
  if (!a) return false;
  a.status = ok ? "done" : "failed";
  a.result = { ok, info, providerMessageId, at: new Date().toISOString() };
  persist();
  return true;
}

/**
 * Stream scraped profiles for a `search` action. Each call carries the FULL set
 * collected so far; `done` resolves the backend's long-poll. Partial calls let a
 * timed-out search still return what arrived.
 */
export async function resolveSearch(
  ws: string,
  actionId: string,
  items: SearchProfile[],
  done: boolean,
): Promise<boolean> {
  await ready();
  const ids = await workspaceAccountIds(ws);
  const a = actions.find((x) => x.id === actionId && x.type === "search" && ids.has(x.accountId));
  if (!a) return false;
  const w = searchWaiters.get(actionId);
  if (w) w.items = items;
  a.result = { ok: true, count: items.length, at: new Date().toISOString() };
  if (done) {
    a.status = "done";
    if (w) { searchWaiters.delete(actionId); w.resolve(items); }
  }
  persist();
  return true;
}

/* ---------------- the provider (used in-process by the engine + import) ---------------- */

function targetOf(p: { publicProfileUrl?: string; providerProfileId?: string; fullName?: string; firstName?: string }): Record<string, unknown> {
  return {
    profileUrl: p.publicProfileUrl || p.providerProfileId || "",
    name: p.fullName || p.firstName || "",
    providerProfileId: p.providerProfileId,
  };
}
function optimistic(action: ActionResult["action"], id: string): Promise<ActionResult> {
  // The browser executes asynchronously; we return optimistically with the action
  // id as the provider message id (the engine treats the send as in flight).
  return Promise.resolve({ ok: true, action, providerMessageId: id });
}

export const backendBridgeProvider: LinkedInProvider = {
  async resolveProfile(_account, identifier) {
    return {
      providerProfileId: identifier,
      publicProfileUrl: /^https?:/.test(identifier) ? identifier : `https://www.linkedin.com/in/${identifier}`,
    };
  },

  async searchProfiles({ account, url, limit = 100 }) {
    await ready();
    const a = enqueue(account.id, "search", {}, { url, limit });
    return new Promise<SearchProfile[]>((resolve) => {
      const w = { items: [] as SearchProfile[], resolve };
      searchWaiters.set(a.id, w);
      setTimeout(() => {
        if (searchWaiters.has(a.id)) { searchWaiters.delete(a.id); resolve(w.items); }
      }, SEARCH_TIMEOUT_MS);
    });
  },

  sendConnection({ account, prospect, note }) {
    return optimistic("connect", enqueue(account.id, "connect", targetOf(prospect), { note }).id);
  },
  withdrawInvite(account, providerProfileId) {
    return optimistic("withdraw_invite", enqueue(account.id, "withdraw_invite", { profileUrl: providerProfileId }, {}).id);
  },
  sendMessage({ account, prospect, text }) {
    return optimistic("message", enqueue(account.id, "message", targetOf(prospect), { body: text }).id);
  },
  sendInMail({ account, prospect, text, subject }) {
    return optimistic("inmail", enqueue(account.id, "inmail", targetOf(prospect), { subject, body: text }).id);
  },
  sendVoiceNote({ account, prospect, audio }) {
    return optimistic("voice_note", enqueue(account.id, "voice_note", targetOf(prospect), { audio }).id);
  },
  viewProfile(account, providerProfileId) {
    return optimistic("profile_view", enqueue(account.id, "profile_view", { profileUrl: providerProfileId }, {}).id);
  },
  endorseTopSkills(account, providerProfileId, count = 3) {
    return optimistic("endorse", enqueue(account.id, "endorse", { profileUrl: providerProfileId }, { count }).id);
  },
  async listMessages() {
    return [];
  },
  async getAccountStatus() {
    return "ok";
  },
};
