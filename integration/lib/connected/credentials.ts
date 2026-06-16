/**
 * RecruitersOS · Integration credentials
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

/**
 * Boot hook: load the saved-credential snapshot and mirror the house keys into
 * process.env ONCE at server startup — before any request is served. Without this,
 * mirroring is lazy (it only happens the first time a credentials function runs), so
 * a tool that reads process.env directly (JD Sourcing's AI key, enrichment, voice,
 * crons) fails right after a redeploy until someone happens to open the Connected
 * page. Called from instrumentation.register(). Idempotent via the hydrate() guard.
 */
export async function ensureCredsHydrated(): Promise<void> {
  await hydrate();
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

/**
 * Single-operator recovery for orphaned connections.
 *
 * Symptom this fixes: an operator connected several integrations, then a redeploy /
 * re-login handed their session a DIFFERENT workspace id (the recurring auth churn).
 * Their saved creds still sit on disk under the OLD id, but the Connected page reads
 * the new id and shows everything red — "I have to reconnect everything."
 *
 * When isolation is OFF (HOUSE_WORKSPACE_ID unset → every workspace is the house, the
 * existing single-operator contract) and the active workspace has NO saved
 * integrations, adopt the most recently saved cred for each integration found under
 * any other workspace id. This is consistent with hydrate(), which already mirrors
 * every workspace's keys into the shared process.env on a no-HOUSE_WORKSPACE_ID box.
 *
 * Hard no-op when HOUSE_WORKSPACE_ID is set (real white-label) so we NEVER pull one
 * tenant's keys into another, and a no-op the moment the workspace has its own creds.
 * Returns the number of integrations recovered.
 */
export async function recoverOrphanedCreds(workspaceId: string): Promise<number> {
  await hydrate();
  if ((process.env.HOUSE_WORKSPACE_ID || "").trim()) return 0; // isolation on: never cross tenants
  const mine = store[workspaceId];
  if (mine && Object.keys(mine.integrations).length) return 0; // already has its own connections

  const newest: Partial<Record<IntegrationId, IntegrationCred>> = {};
  for (const [wid, w] of Object.entries(store)) {
    if (wid === workspaceId) continue;
    for (const [id, cred] of Object.entries(w.integrations)) {
      if (!cred) continue;
      const prev = newest[id as IntegrationId];
      if (!prev || (cred.updatedAt || "") > (prev.updatedAt || "")) newest[id as IntegrationId] = cred;
    }
  }
  const ids = Object.keys(newest) as IntegrationId[];
  if (!ids.length) return 0;

  const target = ws(workspaceId);
  for (const id of ids) {
    const cred = newest[id];
    if (cred) target.integrations[id] = { ...cred, keys: { ...cred.keys }, updatedAt: nowIso() };
  }
  if (shouldMirror(workspaceId)) {
    for (const c of Object.values(target.integrations)) if (c) applyEnv(c.keys);
  }
  save();
  console.warn(`[creds] recovered ${ids.length} orphaned integration(s) into workspace ${workspaceId}: ${ids.join(", ")}`);
  return ids.length;
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
