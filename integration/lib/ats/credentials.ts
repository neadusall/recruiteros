/**
 * RecruitersOS · ATS credentials
 *
 * Per-workspace connection settings for the system-of-record (Loxo today;
 * Bullhorn / Crelate / … reuse the same shape). Entered in the portal under the
 * ATS tab — NOT baked into server env — so each workspace connects its own ATS
 * account without a redeploy.
 *
 * Durable via lib/db (file volume in prod, Postgres when DATABASE_URL is set),
 * same hydrate-once / debounced-snapshot pattern as the data warehouse. One blob
 * holds every workspace's config; reads filter by workspaceId.
 *
 * SECURITY: the raw apiKey / webhookSecret never leave this module unmasked.
 * `publicConfig()` returns a redacted view for the UI; only the sync engine and
 * client construction call `getVendorConfig()` for the real secret, server-side.
 */

import { nowIso } from "../core/ids";
import { loadSnapshot, saveSnapshot, debouncedSaver } from "../db";
import type { AtsVendor } from "./types";

const KEY = "ats_credentials_v1";

/** One vendor connection for one workspace. */
export interface AtsVendorConfig {
  vendor: AtsVendor;
  /** Agency domain, e.g. "app.loxo.co" (no scheme). */
  domain?: string;
  /** Agency slug, e.g. "your-agency". */
  slug?: string;
  /** Bearer token / API key. Stored server-side, never returned unmasked. */
  apiKey?: string;
  /** Shared secret we require on inbound webhooks (we generate it on connect). */
  webhookSecret?: string;
  /** "red" not started · "yellow" saved, untested · "green" verified. */
  status: "red" | "yellow" | "green";
  lastTestedAt?: string;
  lastSyncAt?: string;
  /** Updated-since cursor (ISO) for incremental polling. */
  cursor?: string;
  /** Loxo webhook ids we registered, so we can clean them up on disconnect. */
  webhookIds?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceAts {
  workspaceId: string;
  active?: AtsVendor;
  vendors: Partial<Record<AtsVendor, AtsVendorConfig>>;
}

let store: Record<string, WorkspaceAts> = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<Record<string, WorkspaceAts>>(KEY);
      if (snap && typeof snap === "object") store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

function ws(workspaceId: string): WorkspaceAts {
  if (!store[workspaceId]) store[workspaceId] = { workspaceId, vendors: {} };
  return store[workspaceId];
}

/** The active vendor's config (real secrets), or null. Server-side only. */
export async function getActiveConfig(workspaceId: string): Promise<AtsVendorConfig | null> {
  await hydrate();
  const w = store[workspaceId];
  if (!w || !w.active) return null;
  return w.vendors[w.active] ?? null;
}

/** A specific vendor's config (real secrets), or null. Server-side only. */
export async function getVendorConfig(workspaceId: string, vendor: AtsVendor): Promise<AtsVendorConfig | null> {
  await hydrate();
  return store[workspaceId]?.vendors[vendor] ?? null;
}

/** Active vendor id for a workspace, or null. */
export async function getActiveVendor(workspaceId: string): Promise<AtsVendor | null> {
  await hydrate();
  return store[workspaceId]?.active ?? null;
}

/**
 * Create or update a vendor connection. Saving credentials moves status to
 * "yellow" (saved, not yet verified). Returns the stored config.
 */
export async function saveVendorConfig(
  workspaceId: string,
  vendor: AtsVendor,
  fields: { domain?: string; slug?: string; apiKey?: string; webhookSecret?: string },
): Promise<AtsVendorConfig> {
  await hydrate();
  const w = ws(workspaceId);
  const existing = w.vendors[vendor];
  const cfg: AtsVendorConfig = existing ?? {
    vendor,
    status: "red",
    webhookIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  // A blank field in an edit means "leave the saved value untouched" — NEVER
  // overwrite a stored credential with an empty string. The form re-saves on
  // every Test/Sync click, so a momentarily-empty field must not wipe a good
  // value (that surfaced as a spurious "missing_credentials" on Sync).
  const domain = fields.domain !== undefined ? stripScheme(fields.domain) : undefined;
  if (domain) cfg.domain = domain;
  const slug = fields.slug !== undefined ? fields.slug.trim() : undefined;
  if (slug) cfg.slug = slug;
  if (fields.apiKey && fields.apiKey.trim()) cfg.apiKey = fields.apiKey.trim();
  if (fields.webhookSecret && fields.webhookSecret.trim()) cfg.webhookSecret = fields.webhookSecret.trim();
  if (!cfg.webhookSecret) cfg.webhookSecret = genSecret(workspaceId, vendor);
  cfg.status = cfg.apiKey && cfg.domain && cfg.slug ? "yellow" : "red";
  cfg.error = undefined;
  cfg.updatedAt = nowIso();
  w.vendors[vendor] = cfg;
  // First vendor connected becomes active automatically.
  if (!w.active) w.active = vendor;
  // Flush credentials SYNCHRONOUSLY rather than on the 250ms debounce: a redeploy
  // (auto-deploy fires on every push to main) restarts the single app container,
  // and an unflushed debounced write would be lost — the next process boots without
  // the key and Sync fails with "missing_credentials". Awaiting the snapshot makes
  // the key durable before this request returns.
  await saveSnapshot(KEY, store);
  return cfg;
}

/** Record the result of a connection test. */
export async function markTested(
  workspaceId: string,
  vendor: AtsVendor,
  ok: boolean,
  error?: string,
): Promise<AtsVendorConfig | null> {
  await hydrate();
  const cfg = store[workspaceId]?.vendors[vendor];
  if (!cfg) return null;
  cfg.status = ok ? "green" : "yellow";
  cfg.error = ok ? undefined : error || "connection_failed";
  cfg.lastTestedAt = nowIso();
  cfg.updatedAt = nowIso();
  save();
  return cfg;
}

/** Advance the incremental-sync cursor and stamp lastSyncAt. */
export async function markSynced(workspaceId: string, vendor: AtsVendor, cursor: string): Promise<void> {
  await hydrate();
  const cfg = store[workspaceId]?.vendors[vendor];
  if (!cfg) return;
  cfg.cursor = cursor;
  cfg.lastSyncAt = nowIso();
  cfg.updatedAt = nowIso();
  save();
}

/** Remember the webhook ids we registered (for later cleanup). */
export async function setWebhookIds(workspaceId: string, vendor: AtsVendor, ids: string[]): Promise<void> {
  await hydrate();
  const cfg = store[workspaceId]?.vendors[vendor];
  if (!cfg) return;
  cfg.webhookIds = ids;
  cfg.updatedAt = nowIso();
  save();
}

/** Choose which connected vendor is the system of record. */
export async function setActiveVendor(workspaceId: string, vendor: AtsVendor): Promise<boolean> {
  await hydrate();
  const w = store[workspaceId];
  if (!w || !w.vendors[vendor]) return false;
  w.active = vendor;
  save();
  return true;
}

/** Remove a vendor connection. */
export async function disconnectVendor(workspaceId: string, vendor: AtsVendor): Promise<void> {
  await hydrate();
  const w = store[workspaceId];
  if (!w) return;
  delete w.vendors[vendor];
  if (w.active === vendor) {
    const remaining = Object.keys(w.vendors) as AtsVendor[];
    w.active = remaining[0];
  }
  save();
}

/** Every workspace that has a verified ("green") vendor — drives the cron. */
export async function listConfiguredWorkspaces(): Promise<Array<{ workspaceId: string; vendor: AtsVendor }>> {
  await hydrate();
  const out: Array<{ workspaceId: string; vendor: AtsVendor }> = [];
  for (const w of Object.values(store)) {
    if (!w.active) continue;
    const cfg = w.vendors[w.active];
    if (cfg && cfg.status === "green") out.push({ workspaceId: w.workspaceId, vendor: w.active });
  }
  return out;
}

/**
 * Redacted view for the UI: tells you whether a key is present and shows the
 * non-secret settings, but never the apiKey/webhookSecret themselves.
 */
export async function publicConfig(workspaceId: string): Promise<{
  active: AtsVendor | null;
  vendors: Array<{
    vendor: AtsVendor;
    domain?: string;
    slug?: string;
    hasApiKey: boolean;
    status: "red" | "yellow" | "green";
    lastTestedAt?: string;
    lastSyncAt?: string;
    error?: string;
  }>;
}> {
  await hydrate();
  const w = store[workspaceId];
  if (!w) return { active: null, vendors: [] };
  return {
    active: w.active ?? null,
    vendors: Object.values(w.vendors).map((c) => ({
      vendor: c.vendor,
      domain: c.domain,
      slug: c.slug,
      hasApiKey: Boolean(c.apiKey),
      status: c.status,
      lastTestedAt: c.lastTestedAt,
      lastSyncAt: c.lastSyncAt,
      error: c.error,
    })),
  };
}

/* ---------------- helpers ---------------- */
function stripScheme(s: string): string {
  return s.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** Deterministic, non-cryptographic per-connection secret for webhook verification. */
function genSecret(workspaceId: string, vendor: AtsVendor): string {
  const base = `${workspaceId}:${vendor}:ros-ats`;
  let h1 = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    h1 ^= base.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return "whk_" + (h1 >>> 0).toString(36) + Buffer.from(base).toString("base64url").slice(0, 18);
}
