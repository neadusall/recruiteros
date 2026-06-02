/**
 * RecruiterOS · Extension ingest token
 *
 * The Chrome extension (Sales Navigator scraper) runs in the user's own browser
 * and can't carry the site session cookie cross-origin. Instead the user copies
 * a per-workspace ingest token from the app and pastes it into the extension;
 * the extension sends it as `Authorization: Bearer <token>` when posting scraped
 * leads to /api/linkedin/campaignFromDataset.
 *
 * In-memory reference store (swap for Prisma at the seam).
 */

import { rid } from "../core/ids";

const byWs = new Map<string, string>();    // workspaceId -> token
const byToken = new Map<string, string>(); // token -> workspaceId

function mint(): string {
  return "ext_" + rid("k").replace(/[^a-zA-Z0-9]/g, "") + Math.random().toString(36).slice(2, 12);
}

export function getOrCreateToken(workspaceId: string): string {
  let t = byWs.get(workspaceId);
  if (!t) { t = mint(); byWs.set(workspaceId, t); byToken.set(t, workspaceId); }
  return t;
}

export function regenerateToken(workspaceId: string): string {
  const old = byWs.get(workspaceId);
  if (old) byToken.delete(old);
  const t = mint();
  byWs.set(workspaceId, t);
  byToken.set(t, workspaceId);
  return t;
}

/** Resolve the workspace a bearer token belongs to, or undefined. */
export function workspaceForToken(token: string | null | undefined): string | undefined {
  return token ? byToken.get(token) : undefined;
}

/** Parse "Authorization: Bearer <token>" from a request. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}
