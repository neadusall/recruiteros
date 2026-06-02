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

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const origin = new URL(req.url).origin;
  return ok({ token: getOrCreateToken(g.ctx.workspace.id), backendBaseUrl: origin + "/api/linkedin" });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ action?: string }>(req);
  const origin = new URL(req.url).origin;
  const token = b?.action === "regenerate" ? regenerateToken(g.ctx.workspace.id) : getOrCreateToken(g.ctx.workspace.id);
  return ok({ token, backendBaseUrl: origin + "/api/linkedin" });
}
