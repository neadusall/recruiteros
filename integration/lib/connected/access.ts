/**
 * RecruiterOS · Connected · Access control (white-label credential isolation)
 *
 * The deployment env holds the HOUSE (operator) integration keys — Telnyx,
 * enrichment, RapidAPI, etc. In a single-operator world those keys were
 * everyone's. In a white-label world they are NOT. This module draws the line:
 *
 *   - HOUSE workspace (the operator's own): uses the env keys freely, as before.
 *   - CUSTOMER workspace: isolated to its OWN saved keys. It never silently
 *     inherits a house key — UNLESS the operator GRANTS a specific integration,
 *     which lends the house key with a billable flag (the resale path the owner
 *     prices). Grants are an OWNER action, never something a customer self-serves.
 *
 * Identity is resolved so the operator's own instance can NEVER be mistaken for
 * a customer and lose access:
 *   - HOUSE_WORKSPACE_ID set   -> ONLY that workspace is house; everyone else is
 *     an isolated customer. This is the switch that turns white-label on.
 *   - HOUSE_WORKSPACE_ID unset -> EVERY workspace is house (legacy single-operator
 *     behaviour, zero regression). Isolation activates only once the operator
 *     names their house workspace, so nothing breaks before they opt in.
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { IntegrationId } from "./index";

/** Is this the operator's own (house) workspace, which legitimately uses env keys? */
export function isHouseWorkspace(workspaceId: string): boolean {
  const explicit = (process.env.HOUSE_WORKSPACE_ID || "").trim();
  if (!explicit) return true; // isolation off until the operator names their house
  return workspaceId === explicit;
}

/* ---------------- grant store (operator lends a house key to a customer) ---- */

const store = { grants: new Map<string, Set<IntegrationId>>() };

const SNAP_KEY = "integration_grants";
function serialize() {
  return { grants: [...store.grants.entries()].map(([ws, set]) => [ws, [...set]]) };
}
function hydrateFrom(s: any) {
  if (s?.grants) {
    store.grants = new Map((s.grants as [string, IntegrationId[]][]).map(([ws, ids]) => [ws, new Set(ids)]));
  }
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensureGrantsReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrateFrom).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureGrantsReady();

/** Integrations the operator has granted this workspace house-key access to. */
export async function listGrants(workspaceId: string): Promise<IntegrationId[]> {
  await ensureGrantsReady();
  return [...(store.grants.get(workspaceId) ?? [])];
}

export async function isGranted(workspaceId: string, id: IntegrationId): Promise<boolean> {
  await ensureGrantsReady();
  return store.grants.get(workspaceId)?.has(id) ?? false;
}

/** Operator-only: turn a grant on/off for a customer workspace. */
export async function setGrant(
  workspaceId: string,
  id: IntegrationId,
  on: boolean,
): Promise<{ workspaceId: string; granted: IntegrationId[]; updatedAt: string }> {
  await ensureGrantsReady();
  const set = store.grants.get(workspaceId) ?? new Set<IntegrationId>();
  if (on) set.add(id);
  else set.delete(id);
  if (set.size) store.grants.set(workspaceId, set);
  else store.grants.delete(workspaceId);
  persist();
  return { workspaceId, granted: [...set], updatedAt: nowIso() };
}
