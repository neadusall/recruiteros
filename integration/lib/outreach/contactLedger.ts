/**
 * RecruitersOS · Contact ledger (email-level last-touch memory)
 *
 * The warehouse contact guard (contactGuard.ts) only sees people who already
 * have a DataRecord, which cold BD prospects usually do not. This ledger is the
 * complement: a small persisted map of address -> last cold-touch, written on
 * every outbound cold email, so the 14-day no-double-contact rule holds for
 * EVERY human we email, warehouse record or not.
 *
 * Workspace-scoped (tenant isolation). Entries expire naturally: anything older
 * than twice the cooldown is pruned on write, so the snapshot stays small.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { contactCooldownDays } from "./contactGuard";

interface LedgerEntry { at: string; channel: string }
type WorkspaceLedger = Record<string, LedgerEntry>; // key: normalized email
interface LedgerState { byWorkspace: Record<string, WorkspaceLedger> }

const KEY = "outreach_contact_ledger_v1";
let state: LedgerState = { byWorkspace: {} };
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = loadSnapshot<LedgerState>(KEY).then((s) => {
      if (s?.byWorkspace) state = s;
      hydrated = true;
    });
  }
  await hydrating;
}

function norm(email: string): string {
  return (email || "").toLowerCase().trim();
}

/** Record a cold touch to this address (call on every successful cold send). */
export async function recordContact(workspaceId: string, email: string, channel = "email"): Promise<void> {
  const e = norm(email);
  if (!e || !workspaceId) return;
  await hydrate();
  const ws = (state.byWorkspace[workspaceId] ||= {});
  ws[e] = { at: new Date().toISOString(), channel };
  // Opportunistic prune: entries past 2x cooldown no longer affect any decision.
  const horizon = Date.now() - contactCooldownDays() * 2 * 86_400_000;
  for (const [k, v] of Object.entries(ws)) {
    if (Date.parse(v.at) < horizon) delete ws[k];
  }
  save();
}

/** Last cold touch to this address inside the cooldown window, if any. */
export async function recentContact(
  workspaceId: string,
  email: string,
): Promise<{ at: string; channel: string; daysAgo: number } | null> {
  const e = norm(email);
  if (!e || !workspaceId) return null;
  await hydrate();
  const hit = state.byWorkspace[workspaceId]?.[e];
  if (!hit) return null;
  const at = Date.parse(hit.at);
  if (!Number.isFinite(at)) return null;
  const days = (Date.now() - at) / 86_400_000;
  if (days >= contactCooldownDays()) return null;
  return { at: hit.at, channel: hit.channel, daysAgo: Math.floor(days) };
}
