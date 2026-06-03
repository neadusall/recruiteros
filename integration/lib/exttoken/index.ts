/**
 * RecruiterOS · Extension ingest token
 *
 * The Chrome extension (Sales Navigator scraper / browser-execution agent) runs
 * in the user's own browser and can't carry the site session cookie cross-origin.
 * Instead the user copies a per-workspace ingest token from the app and pastes it
 * into the extension (or one-click "Connect"); the extension sends it as
 * `Authorization: Bearer <token>` when posting scraped leads to
 * /api/linkedin/campaignFromDataset and when polling /api/linkedin/agent/*.
 *
 * STATELESS + SIGNED: the token is `ext_<workspaceId>.<hmac>` where the hmac is
 * HMAC-SHA256(workspaceId) under a stable server secret. Validation just
 * re-computes and compares the signature — NO server-side storage. This means a
 * backend restart / dev recompile (which used to wipe the in-memory map and cause
 * spurious 401s) no longer invalidates a connected extension.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  // Stable across restarts in prod (deploy.sh generates RECRUITEROS_SESSION_SECRET).
  // The dev fallback keeps localhost working without any env set.
  return process.env.RECRUITEROS_SESSION_SECRET || process.env.RECRUITEROS_API_TOKEN || "ros-ext-token-dev-secret";
}

function sign(workspaceId: string): string {
  return createHmac("sha256", secret()).update("ext:" + workspaceId).digest("base64url").slice(0, 32);
}

function makeToken(workspaceId: string): string {
  return "ext_" + workspaceId + "." + sign(workspaceId);
}

export async function getOrCreateToken(workspaceId: string): Promise<string> {
  return makeToken(workspaceId);
}

// Stateless tokens can't be revoked individually; "regenerate" returns the same
// deterministic token. (Rotate RECRUITEROS_SESSION_SECRET to invalidate all.)
export async function regenerateToken(workspaceId: string): Promise<string> {
  return makeToken(workspaceId);
}

/** Resolve the workspace a bearer token belongs to, or undefined. */
export async function workspaceForToken(token: string | null | undefined): Promise<string | undefined> {
  if (!token || token.slice(0, 4) !== "ext_") return undefined;
  const body = token.slice(4);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ws = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  const expected = sign(ws);
  if (sig.length !== expected.length) return undefined;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
  } catch {
    return undefined;
  }
  return ws;
}

/** Parse "Authorization: Bearer <token>" from a request. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}
