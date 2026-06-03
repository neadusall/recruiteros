/**
 * GET  /api/ext-token  -> this workspace's Chrome-extension ingest token (+ the
 *                         base URL to paste into the extension)
 * POST /api/ext-token { action: "regenerate" } -> rotate the token
 *
 * Session-gated. The token authenticates the browser extension when it posts
 * scraped Sales Navigator leads to /api/linkedin/campaignFromDataset.
 */

import { getOrCreateToken, regenerateToken } from "../../../lib/exttoken";
import { requireSession, body, ok } from "../../../lib/api";

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
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok({ token: await getOrCreateToken(g.ctx.workspace.id), backendBaseUrl: publicOrigin(req) + "/api/linkedin" });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ action?: string }>(req);
  const token = b?.action === "regenerate" ? await regenerateToken(g.ctx.workspace.id) : await getOrCreateToken(g.ctx.workspace.id);
  return ok({ token, backendBaseUrl: publicOrigin(req) + "/api/linkedin" });
}
