/**
 * GET  /api/ext-token  -> this workspace's Chrome-extension ingest token (+ the
 *                         base URL to paste into the extension)
 * POST /api/ext-token { action: "regenerate" } -> rotate the token
 *
 * Session-gated. The token authenticates the browser extension when it posts
 * scraped Sales Navigator leads to /api/linkedin/campaignFromDataset.
 */

import { getOrCreateToken, regenerateToken } from "../../../lib/exttoken";
import { getImportMotion, setImportMotion } from "../../../lib/importmotion";
import { body, ok, requireCapability } from "../../../lib/api";
import type { Motion } from "../../../lib/core/types";

/**
 * The PUBLIC origin the browser/extension should call — NOT new URL(req.url).origin,
 * which behind a reverse proxy is the app's internal address (e.g. localhost:3000)
 * and would tell the extension to post to localhost. Prefer the configured app URL,
 * then forwarded headers, then the Host header, then the request origin.
 */
function publicOrigin(req: Request): string {
  const env = (process.env.RECRUITEROS_APP_URL || "").replace(/\/$/, "");
  if (env) return env;
  const xfHost = req.headers.get("x-forwarded-host");
  if (xfHost) return (req.headers.get("x-forwarded-proto") || "https") + "://" + xfHost.split(",")[0].trim();
  const host = req.headers.get("host");
  if (host) return (/^(localhost|127\.|\[?::1)/.test(host) ? "http" : "https") + "://" + host;
  return new URL(req.url).origin;
}

export async function GET(req: Request) {
  const g = requireCapability(req, "apikeys:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  return ok({ token: await getOrCreateToken(ws), backendBaseUrl: publicOrigin(req) + "/api/linkedin", importMotion: await getImportMotion(ws) });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "apikeys:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; motion?: Motion }>(req);
  // The portal calls this on every motion toggle so extension scrapes land in
  // the active bucket.
  if (b?.action === "set-motion") {
    return ok({ importMotion: await setImportMotion(ws, b.motion === "bd" ? "bd" : "recruiting") });
  }
  const token = b?.action === "regenerate" ? await regenerateToken(ws) : await getOrCreateToken(ws);
  return ok({ token, backendBaseUrl: publicOrigin(req) + "/api/linkedin", importMotion: await getImportMotion(ws) });
}
