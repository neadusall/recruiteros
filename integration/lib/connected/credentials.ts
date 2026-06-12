/**
 * RecruiterOS · Integration credentials
 *
 * Per-workspace API keys + connection status for the Connected / Integrations
 * hub, entered IN THE PORTAL (no redeploy) — the same shape and durability as
 * lib/ats/credentials.ts. One blob holds every workspace's connections; reads
 * filter by workspaceId.
 *
 * Two ways the engine reaches a saved key:
 *  1. Per-workspace, correct: the Connected route runs reads/tests inside
 *     `runWithCreds(resolvedKeys(ws), …)` so the provider singletons resolve THIS
 *     workspace's keys (see lib/providers/http.ts env()).
 *  2. Runtime default: on hydrate + save we mirror the keys into process.env so
 *     the always-on engine (crons, send paths) keeps working off the singletons
 *     without threading a workspace through every call. This deployment is
 *     single-operator, so a portal-saved key intentionally wins for the box.
 *
 * SECURITY: raw key values never leave this module. `publicConfig()` returns a
 * redacted view (which fields are present) for the UI; only test/verify and the
 * runtime resolver read the real secrets, server-side.
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver } from "../db";
import type { IntegrationId, ConnStatus } from "./index";

const KEY = "integration_credentials_v1";

export interface IntegrationCred {
  id: IntegrationId;
  /** envKey -> value, e.g. { UNIPILE_API_KEY: "…" }. */
  keys: Record<string, string>;
  status: ConnStatus;
  lastTestedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceCreds {
  workspaceId: string;
  integrations: Partial<Record<IntegrationId, IntegrationCred>>;
}

let store: Record<string, WorkspaceCreds> = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<Record<string, WorkspaceCreds>>(KEY);
      if (snap && typeof snap === "object") {
        store = snap;
        // Mirror every saved key into the running process so the engine's
        // provider singletons pick them up on boot (single-operator runtime).
        for (const w of Object.values(store)) {
          if (!shouldMirror(w.workspaceId)) continue; // never pollute env with a customer's keys
          for (const c of Object.values(w.integrations)) {
            if (c) applyEnv(c.keys);
          }
        }
        // Loud guard: with HOUSE_WORKSPACE_ID unset, shouldMirror() is true for ALL
        // workspaces, so every workspace's saved keys land in the shared process.env
        // (last-writer-wins) and a customer can ride the operator's env. Fine for a
        // solo instance; a silent cross-tenant leak the moment a 2nd workspace exists.
        if (!(process.env.HOUSE_WORKSPACE_ID || "").trim() && Object.keys(store).length > 1) {
          console.warn(
            `[creds] SECURITY: ${Object.keys(store).length} workspaces but HOUSE_WORKSPACE_ID is unset — ` +
            `all workspace keys are mirrored into shared process.env (cross-tenant leak). ` +
            `Set HOUSE_WORKSPACE_ID to your operator workspace id to isolate customers.`,
          );
        }
      }
      hydrated = true;
    })();
  }
  return hydrating;
}

function ws(workspaceId: string): WorkspaceCreds {
  if (!store[workspaceId]) store[workspaceId] = { workspaceId, integrations: {} };
  return store[workspaceId];
}

/**
 * Should this workspace's keys be mirrored into the global process.env?
 *
 * Mirroring is how the always-on engine (crons/sends) picks up portal-saved keys
 * off the provider singletons. In a white-label world that global is the HOUSE
 * (operator) channel — a customer's keys must NOT pollute it (or they'd leak into
 * other workspaces' env-fallback sends).
 *
 *  - HOUSE_WORKSPACE_ID set  -> mirror ONLY that workspace (strict isolation).
 *  - HOUSE_WORKSPACE_ID unset -> mirror all (legacy single-operator behaviour, so
 *    the operator's existing setup keeps working until they opt into isolation).
 */
function shouldMirror(workspaceId: string): boolean {
  const houseId = (process.env.HOUSE_WORKSPACE_ID || "").trim();
  return houseId ? workspaceId === houseId : true;
}

/** Mirror non-empty keys into process.env for the running instance. */
function applyEnv(keys: Record<string, string>): void {
  for (const [k, v] of Object.entries(keys)) {
    if (v) process.env[k] = v;
  }
}

/**
 * Merge keys for one integration. A blank value means "leave the saved key
 * untouched" (so the UI can show "saved, leave blank to keep"). `requiredKeys`
 * lets the caller decide red vs yellow once the merge is done. Returns the cred.
 */
export async function saveKeys(
  workspaceId: string,
  id: IntegrationId,
  incoming: Record<string, string>,
  requiredKeys: string[],
): Promise<IntegrationCred> {
  await hydrate();
  const w = ws(workspaceId);
  const cfg: IntegrationCred =
    w.integrations[id] ?? { id, keys: {}, status: "red", createdAt: nowIso(), updatedAt: nowIso() };
  for (const [k, v] of Object.entries(incoming)) {
    const t = (v ?? "").trim();
    if (t) cfg.keys[k] = t; // blank = keep existing
  }
  const haveAllRequired = requiredKeys.every((k) => Boolean(cfg.keys[k]));
  cfg.status = haveAllRequired ? "yellow" : "red";
  cfg.error = undefined;
  cfg.updatedAt = nowIso();
  w.integrations[id] = cfg;
  if (shouldMirror(workspaceId)) applyEnv(cfg.keys); // house only — keep customer keys out of global env
  save();
  return cfg;
}

/** Record a test result: ok -> green, fail -> yellow with the error. */
export async function markTested(
  workspaceId: string,
  id: IntegrationId,
  ok: boolean,
  error?: string,
): Promise<IntegrationCred | null> {
  await hydrate();
  const cfg = store[workspaceId]?.integrations[id];
  if (!cfg) return null;
  cfg.status = ok ? "green" : "yellow";
  cfg.error = ok ? undefined : error || "verification_failed";
  cfg.lastTestedAt = nowIso();
  cfg.updatedAt = nowIso();
  save();
  return cfg;
}

/** Remove a saved connection (does not unset process.env for this run). */
export async function clearKeys(workspaceId: string, id: IntegrationId): Promise<void> {
  await hydrate();
  const w = store[workspaceId];
  if (!w) return;
  delete w.integrations[id];
  save();
}

/** Real keys for one integration (server-side only). */
export async function getKeys(workspaceId: string, id: IntegrationId): Promise<Record<string, string>> {
  await hydrate();
  return store[workspaceId]?.integrations[id]?.keys ?? {};
}

/** Flat map of every saved key for a workspace — feeds runWithCreds(). */
export async function resolvedKeys(workspaceId: string): Promise<Record<string, string>> {
  await hydrate();
  const out: Record<string, string> = {};
  const w = store[workspaceId];
  if (!w) return out;
  for (const c of Object.values(w.integrations)) {
    if (c) Object.assign(out, c.keys);
  }
  return out;
}

/** Stored status + error for one integration, if any. */
export async function statusOf(
  workspaceId: string,
  id: IntegrationId,
): Promise<{ status: ConnStatus; lastTestedAt?: string; error?: string } | null> {
  await hydrate();
  const c = store[workspaceId]?.integrations[id];
  if (!c) return null;
  return { status: c.status, lastTestedAt: c.lastTestedAt, error: c.error };
}

/** Redacted per-integration view for the UI: which key fields are present. */
export async function publicConfig(
  workspaceId: string,
): Promise<Record<string, { present: string[]; status: ConnStatus; lastTestedAt?: string; error?: string }>> {
  await hydrate();
  const out: Record<string, { present: string[]; status: ConnStatus; lastTestedAt?: string; error?: string }> = {};
  const w = store[workspaceId];
  if (!w) return out;
  for (const c of Object.values(w.integrations)) {
    if (!c) continue;
    out[c.id] = {
      present: Object.keys(c.keys).filter((k) => Boolean(c.keys[k])),
      status: c.status,
      lastTestedAt: c.lastTestedAt,
      error: c.error,
    };
  }
  return out;
}
