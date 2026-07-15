/**
 * RecruitersOS · Outbound Performance · admin config audit log
 *
 * Every admin change to goals, limits, thresholds, or required notifications
 * is recorded: who, what, previous value, new value, when. Append-only,
 * capped per workspace so the snapshot stays bounded.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { rid, nowIso } from "../core/ids";
import type { AuditEntry } from "./types";

const KEY = "outbound_audit_v1";
const CAP = 500;

let state: Record<string, AuditEntry[]> = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<Record<string, AuditEntry[]>>(KEY);
      if (snap && typeof snap === "object") state = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

export async function appendAudit(
  workspaceId: string,
  entry: { adminId: string; adminEmail: string; change: string; previous: unknown; next: unknown },
): Promise<AuditEntry> {
  await hydrate();
  const e: AuditEntry = { id: rid("aud"), workspaceId, at: nowIso(), ...entry };
  const list = state[workspaceId] ?? (state[workspaceId] = []);
  list.unshift(e);
  if (list.length > CAP) list.length = CAP;
  save();
  return e;
}

export async function listAudit(workspaceId: string, limit = 100): Promise<AuditEntry[]> {
  await hydrate();
  return (state[workspaceId] ?? []).slice(0, limit);
}
