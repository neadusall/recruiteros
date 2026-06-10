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

/** Pricing the operator attaches to a granted integration (the resale terms). */
export interface GrantTerms {
  /** % added on top of the metered house cost when this customer uses the key. */
  markupPct?: number;
  /** Flat monthly fee for the access, if any. */
  monthlyUsd?: number;
  grantedAt: string;
}

const store = { grants: new Map<string, Map<IntegrationId, GrantTerms>>() };

const SNAP_KEY = "integration_grants";
function serialize() {
  return {
    grants: [...store.grants.entries()].map(([ws, m]) => [ws, [...m.entries()]]),
  };
}
function hydrateFrom(s: any) {
  if (s?.grants) {
    store.grants = new Map(
      (s.grants as [string, [IntegrationId, GrantTerms][]][]).map(([ws, entries]) => [ws, new Map(entries)]),
    );
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

/** Integration ids the operator has granted this workspace house-key access to. */
export async function listGrants(workspaceId: string): Promise<IntegrationId[]> {
  await ensureGrantsReady();
  return [...(store.grants.get(workspaceId)?.keys() ?? [])];
}

/** Full grant terms for a workspace (for the owner console / billing flow). */
export async function grantsFor(workspaceId: string): Promise<Record<string, GrantTerms>> {
  await ensureGrantsReady();
  const out: Record<string, GrantTerms> = {};
  for (const [id, terms] of store.grants.get(workspaceId) ?? []) out[id] = terms;
  return out;
}

export async function isGranted(workspaceId: string, id: IntegrationId): Promise<boolean> {
  await ensureGrantsReady();
  return store.grants.get(workspaceId)?.has(id) ?? false;
}

/** Operator-only: turn a grant on/off for a customer workspace, with resale terms. */
export async function setGrant(
  workspaceId: string,
  id: IntegrationId,
  on: boolean,
  terms?: { markupPct?: number; monthlyUsd?: number },
): Promise<{ workspaceId: string; grants: Record<string, GrantTerms>; updatedAt: string }> {
  await ensureGrantsReady();
  const m = store.grants.get(workspaceId) ?? new Map<IntegrationId, GrantTerms>();
  if (on) {
    const prev = m.get(id);
    m.set(id, {
      markupPct: terms?.markupPct ?? prev?.markupPct,
      monthlyUsd: terms?.monthlyUsd ?? prev?.monthlyUsd,
      grantedAt: prev?.grantedAt ?? nowIso(),
    });
  } else {
    m.delete(id);
  }
  if (m.size) store.grants.set(workspaceId, m);
  else store.grants.delete(workspaceId);
  persist();
  const out: Record<string, GrantTerms> = {};
  for (const [k, v] of m) out[k] = v;
  return { workspaceId, grants: out, updatedAt: nowIso() };
}
