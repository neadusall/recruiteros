/**
 * RecruitersOS · Response
 * Do-not-contact (DNC) suppression list.
 *
 * STOP / unsubscribe must be honored the instant it arrives and enforced at the
 * source of truth, then mirrored to every sending platform (Instantly,
 * SalesRobot/Unipile, OS Text) so no channel can reach the contact again.
 *
 * DURABLE: the list is snapshotted to the db layer (`response_suppression_v1`) and
 * re-hydrated on boot — a server restart must never forget who said stop. The email
 * send path (lib/channels dispatch) checks this list before every send.
 */

import { normalizePhone } from "../core/repository";
import { instantly, salesrobot, ostext } from "../providers";
import { loadSnapshot, debouncedSaver } from "../db";

export interface SuppressionEntry {
  workspaceId: string;
  handles: string[];   // any of: email, linkedin url, phone
  reason: string;
  at: string;
}

const KEY = "response_suppression_v1";
const list: SuppressionEntry[] = [];
let hydrating: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (!hydrating) {
    hydrating = loadSnapshot<SuppressionEntry[]>(KEY)
      .then((snap) => { if (Array.isArray(snap)) list.push(...snap); })
      .catch(() => { /* memory-only until the store is reachable */ });
  }
  return hydrating;
}
const persist = debouncedSaver(KEY, () => list);

function key(h: string): string {
  const t = h.trim().toLowerCase();
  return /^\+?\d[\d\s().-]+$/.test(t) ? normalizePhone(t) : t;
}

/** Add a contact's handles to the DNC list (durably) and fan out to sending platforms. */
export async function suppress(
  workspaceId: string,
  handles: Array<string | undefined>,
  reason: string,
  at: string,
): Promise<SuppressionEntry> {
  await ensureLoaded();
  const clean = handles.filter(Boolean).map((h) => key(h as string));
  const entry: SuppressionEntry = { workspaceId, handles: clean, reason, at };
  list.push(entry);
  persist();
  await mirrorToPlatforms(entry);
  return entry;
}

export async function isSuppressed(workspaceId: string, handle?: string): Promise<boolean> {
  if (!handle) return false;
  await ensureLoaded();
  const k = key(handle);
  return list.some((e) => e.workspaceId === workspaceId && e.handles.includes(k));
}

export async function listSuppression(workspaceId: string): Promise<SuppressionEntry[]> {
  await ensureLoaded();
  return list.filter((e) => e.workspaceId === workspaceId);
}

/**
 * Push the opt-out to each provider's suppression endpoint across every channel.
 * Each call no-ops (dry-logs) until that provider's key is set, so this is safe
 * to run with partial configuration. Failures are swallowed per-channel: an
 * opt-out must never fail because one provider is down.
 */
async function mirrorToPlatforms(entry: SuppressionEntry): Promise<void> {
  const isEmail = (h: string) => h.includes("@");
  const isPhone = (h: string) => /^\+?\d{6,}$/.test(h);
  const tasks: Promise<unknown>[] = [];

  for (const h of entry.handles) {
    if (isEmail(h)) {
      tasks.push(swallow(instantly.blocklistAdd(h)));        // email channel
    } else if (isPhone(h)) {
      tasks.push(swallow(ostext.optOut(h)));                 // SMS channel
    } else {
      tasks.push(swallow(salesrobot.removeProspect(h)));     // LinkedIn channel (profile url)
    }
  }
  await Promise.all(tasks);
  console.info("[suppression] DNC mirrored to all channels", entry.handles, entry.reason);
}

function swallow<T>(p: Promise<T>): Promise<T | null> {
  return p.catch((e) => {
    console.warn("[suppression] channel mirror failed", e?.message ?? e);
    return null;
  });
}
