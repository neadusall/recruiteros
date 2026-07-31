/**
 * RecruitersOS · break log.
 *
 * What the app files when something breaks in front of a person: the code they
 * were shown, the screen they were on, the request that failed, and who they
 * are. The point is that a report can start with "it broke" and still be
 * actionable — the recruiter quotes a code, and the detail behind it is already
 * here rather than lost in a browser console nobody opened.
 *
 * Bounded on purpose: the newest 300 entries across the whole box, snapshotted
 * like every other store. This is a lookup for the last thing that went wrong,
 * not an analytics warehouse.
 */

import { rid, nowIso } from "./core/ids";
import { loadSnapshot, saveSnapshot } from "./db";

const KEY = "breaks_v1";
const MAX = 300;

export interface BreakEntry {
  id: string;
  /** Quotable code shown on screen (ROS-NET / ROS-SRV / ROS-DENY / ROS-APP). */
  code: string;
  /** What the person was doing, named as the app names it ("JD Sourcing"). */
  where: string;
  /** Route hash they were on. */
  screen: string;
  /** The API path that failed, and its status (0 = never landed). */
  path: string;
  status: number;
  /** Server-side reason when there was one. */
  detail: string;
  agent: string;
  /** Filled server-side: never trust the client for identity. */
  workspaceId: string;
  userEmail: string;
  at: string;
}

let store: BreakEntry[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<BreakEntry[]>(KEY);
      if (Array.isArray(snap)) store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

const clip = (v: unknown, max: number): string => String(v ?? "").slice(0, max);

export interface BreakInput {
  code?: unknown;
  where?: unknown;
  screen?: unknown;
  path?: unknown;
  status?: unknown;
  detail?: unknown;
  agent?: unknown;
  at?: unknown;
}

/**
 * Record one break. Everything from the client is clipped and stringified: this
 * endpoint exists BECAUSE things are going wrong, so it must never be the thing
 * that throws.
 */
export async function recordBreak(
  input: BreakInput,
  who: { workspaceId: string; userEmail: string },
): Promise<BreakEntry> {
  await hydrate();
  const entry: BreakEntry = {
    id: rid("brk"),
    code: clip(input.code, 24) || "ROS-APP",
    where: clip(input.where, 80),
    screen: clip(input.screen, 60),
    path: clip(input.path, 200),
    status: Number.isFinite(Number(input.status)) ? Number(input.status) : 0,
    detail: clip(input.detail, 600),
    agent: clip(input.agent, 300),
    workspaceId: who.workspaceId,
    userEmail: who.userEmail,
    at: nowIso(),
  };
  store.push(entry);
  if (store.length > MAX) store = store.slice(-MAX);
  await saveSnapshot(KEY, store);
  // Also on stdout, so a break is greppable in the container logs at the moment
  // it happened, without waiting for anyone to open a console.
  console.warn(`[break] ${entry.code} ${entry.userEmail} ${entry.where || entry.screen} ${entry.path}:${entry.status} ${entry.detail}`);
  return entry;
}

/** Newest first. `workspaceId` scopes it; omit for the owner's box-wide view. */
export async function listBreaks(limit = 50, workspaceId?: string): Promise<BreakEntry[]> {
  await hydrate();
  const rows = workspaceId ? store.filter((b) => b.workspaceId === workspaceId) : store;
  return rows.slice(-Math.max(1, Math.min(limit, MAX))).reverse();
}
