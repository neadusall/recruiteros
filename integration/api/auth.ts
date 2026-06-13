/**
 * RecruitersOS · Public API
 * API-key authentication + scope enforcement.
 *
 * Keys are presented as a Bearer token: `Authorization: Bearer rk_live_<id>.<secret>`.
 * Only a SHA-256 hash of the secret is ever stored, so a leaked database cannot be used
 * to call the API. Verification is constant-time to avoid timing oracles.
 *
 * The key store is pluggable (interface below). Wire it to the RecruitersOS DB in
 * production; an in-memory implementation is provided for dev/tests.
 */

import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import type { ApiKey, ApiRequest, ApiScope, AuthContext } from "./types";

/* ------------------------------------------------------------------ */
/* Key store (pluggable)                                               */
/* ------------------------------------------------------------------ */

export interface KeyStore {
  /** Look up an issued key by its public id (the part before the dot). */
  findById(keyId: string): Promise<ApiKey | undefined>;
  /** Persist a newly issued key. */
  save(key: ApiKey): Promise<void>;
  /** Mark a key revoked. */
  revoke(keyId: string): Promise<void>;
  /** Record last-used (best-effort; may be async/fire-and-forget). */
  touch(keyId: string, at: string): Promise<void>;
  /** All non-revoked keys for a workspace (for the config UI). */
  listForWorkspace(workspaceId: string): Promise<ApiKey[]>;
}

/* ------------------------------------------------------------------ */
/* Hashing helpers                                                     */
/* ------------------------------------------------------------------ */

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time string compare over equal-length hex digests. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/* ------------------------------------------------------------------ */
/* Issuing keys                                                        */
/* ------------------------------------------------------------------ */

export interface IssuedKey {
  /** The full secret to show the user ONCE. Never recoverable afterwards. */
  plaintext: string;
  /** The stored record (hash only). */
  record: ApiKey;
}

/**
 * Mint a new API key. Returns the plaintext exactly once (show it to the user, then
 * forget it) and the persisted record carrying only the hash.
 *
 * `now` is injected so issuance is deterministic in tests; randomness comes from the
 * crypto RNG, which is the one acceptable place for it (key material, not control flow).
 */
export function issueKey(input: {
  workspaceId: string;
  scopes: ApiScope[];
  label: string;
  now: string;
  live?: boolean;
}): IssuedKey {
  const keyId = `rk_${input.live === false ? "test" : "live"}_${randomBytes(8).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `${keyId}.${secret}`;
  const record: ApiKey = {
    id: keyId,
    workspaceId: input.workspaceId,
    secretHash: sha256(secret),
    scopes: input.scopes,
    label: input.label,
    createdAt: input.now,
  };
  return { plaintext, record };
}

/* ------------------------------------------------------------------ */
/* Verifying requests                                                  */
/* ------------------------------------------------------------------ */

// `code`/`message` are declared (optional) on the success branch too so the
// router can read them after an `if (!result.ok)` check without depending on
// discriminated-union narrowing, which strict:false does not perform.
export type AuthResult =
  | { ok: true; auth: AuthContext; code?: undefined; message?: undefined }
  | { ok: false; code: "missing_token" | "malformed_token" | "invalid_token" | "revoked"; message: string };

/** Extract the Bearer token from a request, accepting `Authorization` or `x-api-key`. */
function extractToken(req: ApiRequest): string | undefined {
  const auth = req.headers["authorization"];
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers["x-api-key"]?.trim() || undefined;
}

/**
 * Authenticate a request. Splits the token into `<keyId>.<secret>`, looks up the key,
 * and compares the secret hash in constant time. Returns an `AuthContext` on success.
 */
export async function authenticate(req: ApiRequest, store: KeyStore, now: string): Promise<AuthResult> {
  const token = extractToken(req);
  if (!token) return { ok: false, code: "missing_token", message: "Provide an API key via Authorization: Bearer or x-api-key." };

  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, code: "malformed_token", message: "Malformed API key." };
  const keyId = token.slice(0, dot);
  const secret = token.slice(dot + 1);

  const key = await store.findById(keyId);
  if (!key) return { ok: false, code: "invalid_token", message: "Unknown API key." };
  if (key.revokedAt) return { ok: false, code: "revoked", message: "This API key has been revoked." };
  if (!safeEqualHex(sha256(secret), key.secretHash)) {
    return { ok: false, code: "invalid_token", message: "Invalid API key." };
  }

  // Best-effort last-used stamp; never block the request on it.
  void store.touch(keyId, now).catch(() => undefined);
  return { ok: true, auth: { workspaceId: key.workspaceId, keyId: key.id, scopes: key.scopes } };
}

/** True if the context holds the required scope (admin satisfies everything). */
export function hasScope(auth: AuthContext, scope: ApiScope): boolean {
  return auth.scopes.includes("admin") || auth.scopes.includes(scope);
}

/* ------------------------------------------------------------------ */
/* In-memory store (dev / tests)                                       */
/* ------------------------------------------------------------------ */

export function memoryKeyStore(seed: ApiKey[] = []): KeyStore {
  const byId = new Map<string, ApiKey>(seed.map((k) => [k.id, k]));
  return {
    async findById(id) {
      return byId.get(id);
    },
    async save(key) {
      byId.set(key.id, key);
    },
    async revoke(id) {
      const k = byId.get(id);
      if (k) k.revokedAt = new Date().toISOString();
    },
    async touch(id, at) {
      const k = byId.get(id);
      if (k) k.lastUsedAt = at;
    },
    async listForWorkspace(workspaceId) {
      return [...byId.values()].filter((k) => k.workspaceId === workspaceId && !k.revokedAt);
    },
  };
}
