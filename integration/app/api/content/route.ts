/**
 * GET  /api/content -> the content library (assets)
 * POST /api/content -> add an asset  { name, type, body, campaignIds? }
 */

import { addAsset, listAssets, type AssetType } from "../../../lib/content";
import { requireSession, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok({ assets: listAssets(g.ctx.workspace.id) });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ name?: string; type?: AssetType; body?: string; campaignIds?: string[] }>(req);
  if (!b?.name || !b?.type || !b?.body) return fail("missing_fields", 422);
  const asset = addAsset(g.ctx.workspace.id, b.name, b.type, b.body, b.campaignIds ?? []);
  return ok({ asset }, 201);
}
