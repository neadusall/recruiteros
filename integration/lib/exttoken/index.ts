/**
 * RecruiterOS · Extension ingest token
 *
 * The Chrome extension (Sales Navigator scraper / browser-execution agent) runs
 * in the user's own browser and can't carry the site session cookie cross-origin.
 * Instead the user copies a per-workspace ingest token from the app and pastes it
 * into the extension; the extension sends it as `Authorization: Bearer <token>`
 * when posting scraped leads to /api/linkedin/campaignFromDataset and when polling
 * the in-backend bridge at /api/linkedin/agent/*.
 *
 * Persisted via the shared DB snapshot layer, so a redeploy/restart does NOT
 * regenerate the token (no re-pasting into the extension). No-op without
 * DATABASE_URL — falls back to in-memory for local/static use.
 */

import { rid } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

const byWs = new Map<string, string>();    // workspaceId -> token
const byToken = new Map<string, string>(); // token -> workspaceId

const persist = debouncedSaver("exttoken", () => [...byWs.entries()]);

let hydrated: Promise<void> | null = null;
function ready(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<[string, string][]>("exttoken")
          .then((rows) => {
            for (const [ws, tok] of rows ?? []) {
              byWs.set(ws, tok);
              byToken.set(tok, ws);
            }
          })
          .catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}

function mint(): string {
  return "ext_" + rid("k").replace(/[^a-zA-Z0-9]/g, "") + Math.random().toString(36).slice(2, 12);
}

export async function getOrCreateToken(workspaceId: string): Promise<string> {
  await ready();
  let t = byWs.get(workspaceId);
  if (!t) {
    t = mint();
    byWs.set(workspaceId, t);
    byToken.set(t, workspaceId);
    persist();
  }
  return t;
}

export async function regenerateToken(workspaceId: string): Promise<string> {
  await ready();
  const old = byWs.get(workspaceId);
  if (old) byToken.delete(old);
  const t = mint();
  byWs.set(workspaceId, t);
  byToken.set(t, workspaceId);
  persist();
  return t;
}

/** Resolve the workspace a bearer token belongs to, or undefined. */
export async function workspaceForToken(token: string | null | undefined): Promise<string | undefined> {
  await ready();
  return token ? byToken.get(token) : undefined;
}

/** Parse "Authorization: Bearer <token>" from a request. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}
