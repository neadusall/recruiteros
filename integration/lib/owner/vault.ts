/**
 * RecruitersOS · Owner · Password vault (OWNER ONLY)
 *
 * One place to see every account the platform runs on: the portal you sign in at, the
 * username, and the password. The catalogue in ./vaultCatalog seeds the services and
 * their real sign-in URLs; this module holds what is secret about them.
 *
 * ── How the secret is protected ─────────────────────────────────────────────────
 * Passwords are encrypted with AES-256-GCM before they are ever written down, so the
 * snapshot on disk (and any backup of it) holds ciphertext only. The key comes from
 * OWNER_VAULT_KEY, falling back to RECRUITEROS_SESSION_SECRET so the vault is never
 * silently plaintext just because an env var was missed. If neither exists the vault
 * refuses to store a password at all rather than writing one in the clear, an empty
 * vault is recoverable, a leaked one is not.
 *
 * GCM, not CBC, because it authenticates: a tampered record fails to decrypt instead of
 * decrypting to garbage. Each record carries its own random IV, so two accounts sharing
 * a password do not produce the same ciphertext.
 *
 * ── What the API is allowed to return ───────────────────────────────────────────
 * listEntries() never returns a password, not even to the owner: the table shows only
 * whether one is on file. Revealing is a separate, per-record call (revealSecret) so a
 * page load cannot spill 40 passwords into a browser cache, a screenshot or a log. That
 * is also what makes "reveal" auditable, every reveal is one deliberate request.
 *
 * ── Rotation ────────────────────────────────────────────────────────────────────
 * Changing OWNER_VAULT_KEY does not migrate anything: records encrypted under the old
 * key fail to decrypt and are reported as locked rather than lost, so the wrong key is
 * visible immediately instead of looking like an empty vault.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { nowIso, rid } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import { VAULT_CATALOG, type CatalogCategory } from "./vaultCatalog";

/* ---------------- shape ---------------- */

export interface VaultEntry {
  id: string;
  service: string;
  /** The Spend master line this account pays for, so the logins and the money agree. */
  vendor?: string;
  category: CatalogCategory | string;
  /** Where you sign in. */
  url: string;
  username: string;
  /** Which account, when a vendor holds more than one. */
  account?: string;
  /** What breaks without it (seeded from the catalogue, editable). */
  used_for?: string;
  notes?: string;
  /** Where the second factor lives: authenticator app, SMS to a number, recovery codes. */
  mfa?: string;
  /** Env var holding this vendor's API key, when the platform uses one. */
  envKey?: string;
  /** AES-256-GCM: iv:tag:ciphertext, all base64. Never leaves this module. */
  secret?: string;
  /** When the password was last written, so a stale credential is visible. */
  secretUpdatedAt?: string;
  /** Came from the catalogue rather than being typed in by hand. */
  seeded?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What the API is allowed to hand back: everything except the password itself. */
export type SafeEntry = Omit<VaultEntry, "secret"> & {
  hasSecret: boolean;
  /** The record exists but cannot be decrypted with the current key. */
  locked?: boolean;
};

export interface VaultKeyStatus {
  /** A key is configured and passwords can be stored. */
  ready: boolean;
  /** Which env var the key came from. */
  source: "OWNER_VAULT_KEY" | "RECRUITEROS_SESSION_SECRET" | "none";
  /** Set OWNER_VAULT_KEY so the vault does not share the session-signing secret. */
  dedicated: boolean;
}

/* ---------------- key + crypto ---------------- */

function keyMaterial(): { key: Buffer; source: VaultKeyStatus["source"] } | null {
  const dedicated = process.env.OWNER_VAULT_KEY;
  if (dedicated && dedicated.length >= 16) {
    return { key: createHash("sha256").update(dedicated).digest(), source: "OWNER_VAULT_KEY" };
  }
  const session = process.env.RECRUITEROS_SESSION_SECRET;
  if (session && session.length >= 16) {
    // Domain-separated from the session secret's own use so the two never collide.
    return { key: createHash("sha256").update(`ros-owner-vault:${session}`).digest(), source: "RECRUITEROS_SESSION_SECRET" };
  }
  return null;
}

export function vaultKeyStatus(): VaultKeyStatus {
  const k = keyMaterial();
  if (!k) return { ready: false, source: "none", dedicated: false };
  return { ready: true, source: k.source, dedicated: k.source === "OWNER_VAULT_KEY" };
}

function encrypt(plain: string): string | null {
  const k = keyMaterial();
  if (!k) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k.key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

function decrypt(blob: string): string | null {
  const k = keyMaterial();
  if (!k) return null;
  const parts = blob.split(":");
  if (parts.length !== 3) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", k.key, Buffer.from(parts[0], "base64"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, or the record was tampered with. Either way it is not readable.
    return null;
  }
}

/* ---------------- store ---------------- */

const store: { entries: Map<string, VaultEntry> } = { entries: new Map() };

const SNAP_KEY = "owner_vault_v1";
const persist = debouncedSaver(SNAP_KEY, () => ({ entries: [...store.entries.values()] }));

/**
 * Add every catalogue service the vault does not already hold.
 *
 * Only MISSING ids are written, so an edited row (a corrected URL, a filled-in username)
 * survives every future deploy, while a vendor added to the catalogue shows up on the
 * next load without a migration.
 */
function seedMissing(): number {
  let added = 0;
  for (const c of VAULT_CATALOG) {
    if (store.entries.has(c.id)) continue;
    store.entries.set(c.id, {
      id: c.id,
      service: c.service,
      vendor: c.vendor,
      category: c.category,
      url: c.url,
      username: c.username || "",
      account: c.account,
      used_for: c.used_for,
      notes: c.notes,
      envKey: c.envKey,
      seeded: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    added++;
  }
  return added;
}

/**
 * Drop the built-in rows that are no longer in the catalogue.
 *
 * The vault started out holding the platform's own logins as well as its vendors, which
 * made the page a list of everything rather than a list of the accounts behind the money.
 * Removing a service from the catalogue now removes its row too, but ONLY while the row is
 * untouched: a saved password, a typed username or an edited note means the owner has put
 * something there, and nothing the owner put in is ever deleted by a deploy.
 */
function pruneRetired(): number {
  const live = new Set(VAULT_CATALOG.map((c) => c.id));
  let removed = 0;
  for (const [id, e] of store.entries) {
    if (live.has(id) || !e.seeded) continue;
    if (e.secret || e.username || e.mfa) continue;
    store.entries.delete(id);
    removed++;
  }
  return removed;
}

let hydrated: Promise<void> | null = null;
export function ensureVaultReady(): Promise<void> {
  if (!hydrated) {
    const load = dbEnabled()
      ? loadSnapshot<{ entries?: VaultEntry[] }>(SNAP_KEY)
          .then((s) => {
            for (const e of s?.entries || []) if (e?.id) store.entries.set(e.id, e);
          })
          .catch(() => {})
      : Promise.resolve();
    hydrated = load.then(() => {
      const changed = seedMissing() + pruneRetired();
      if (changed) persist();
    });
  }
  return hydrated;
}
void ensureVaultReady();

/* ---------------- reads ---------------- */

function safe(e: VaultEntry): SafeEntry {
  const { secret, ...rest } = e;
  const out: SafeEntry = { ...rest, hasSecret: !!secret };
  // A stored secret that will not decrypt is the signature of a changed key. Say so,
  // rather than showing the row as if no password was ever saved.
  if (secret && decrypt(secret) === null) out.locked = true;
  return out;
}

export async function listVault(): Promise<SafeEntry[]> {
  await ensureVaultReady();
  return [...store.entries.values()]
    .map(safe)
    /* Accounts of the same vendor sit together, in account order, so three RackNerd
       client areas read as one vendor with three logins rather than three strangers. */
    .sort((a, b) =>
      a.category.localeCompare(b.category) ||
      (a.vendor || a.service).localeCompare(b.vendor || b.service) ||
      a.service.localeCompare(b.service) ||
      (a.account || "").localeCompare(b.account || ""));
}

/** The one call that returns a password, for exactly one record. */
export async function revealSecret(id: string): Promise<{ ok: boolean; password?: string; error?: string }> {
  await ensureVaultReady();
  const e = store.entries.get(id);
  if (!e) return { ok: false, error: "not_found" };
  if (!e.secret) return { ok: true, password: "" };
  const plain = decrypt(e.secret);
  if (plain === null) return { ok: false, error: "locked" };
  return { ok: true, password: plain };
}

/* ---------------- writes ---------------- */

export interface VaultPatch {
  service?: string;
  category?: string;
  url?: string;
  username?: string;
  account?: string;
  used_for?: string;
  notes?: string;
  mfa?: string;
  envKey?: string;
  /** Omit to leave the stored password untouched; "" clears it. */
  password?: string;
}

const FIELDS: Array<keyof VaultPatch> = ["service", "category", "url", "username", "account", "used_for", "notes", "mfa", "envKey"];

export async function upsertEntry(id: string | undefined, patch: VaultPatch): Promise<{ ok: boolean; entry?: SafeEntry; error?: string }> {
  await ensureVaultReady();

  const now = nowIso();
  const existing = id ? store.entries.get(id) : undefined;
  if (id && !existing) return { ok: false, error: "not_found" };

  const entry: VaultEntry = existing
    ? { ...existing }
    : {
        id: rid("vlt"),
        service: "",
        category: "Platform",
        url: "",
        username: "",
        createdAt: now,
        updatedAt: now,
      };

  for (const f of FIELDS) {
    const v = patch[f];
    if (v !== undefined) (entry as unknown as Record<string, unknown>)[f] = String(v).trim();
  }
  if (!entry.service) return { ok: false, error: "service_required" };

  if (patch.password !== undefined) {
    if (patch.password === "") {
      delete entry.secret;
      delete entry.secretUpdatedAt;
    } else {
      const blob = encrypt(patch.password);
      if (!blob) return { ok: false, error: "no_key" };
      entry.secret = blob;
      entry.secretUpdatedAt = now;
    }
  }

  entry.updatedAt = now;
  store.entries.set(entry.id, entry);
  persist();
  return { ok: true, entry: safe(entry) };
}

export async function deleteEntry(id: string): Promise<boolean> {
  await ensureVaultReady();
  const had = store.entries.delete(id);
  if (had) persist();
  return had;
}

/** Put back any catalogue service that was deleted, without touching what is there. */
export async function reseedVault(): Promise<number> {
  await ensureVaultReady();
  const added = seedMissing();
  if (added) persist();
  return added;
}

/** Headline counts for the tab: how much of the vault is actually filled in. */
export async function vaultSummary(): Promise<{ total: number; withPassword: number; withUsername: number; locked: number; missing: number }> {
  const entries = await listVault();
  const withPassword = entries.filter((e) => e.hasSecret && !e.locked).length;
  const locked = entries.filter((e) => e.locked).length;
  return {
    total: entries.length,
    withPassword,
    withUsername: entries.filter((e) => !!e.username).length,
    locked,
    missing: entries.length - withPassword - locked,
  };
}
