/**
 * GET  /api/branding -> this workspace's white-label branding (logo, name, domain)
 * POST /api/branding -> save or reset it
 *
 * GET is open to any member so the portal can render the workspace's logo for
 * everyone on the team. Writes require accounts:manage (admin/owner) — branding
 * is a workspace setting, not something a recruiter changes.
 */

import { getBranding, setBranding } from "../../../lib/branding";
import { requireSession, requireCapability, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok({ branding: await getBranding(g.ctx.workspace.id) });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "accounts:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{
    action?: string;
    logoUrl?: string;
    logoLightUrl?: string;
    logoScale?: number;
    brandName?: string;
    accentColor?: string;
    customDomain?: string;
  }>(req);

  if (b?.action === "reset") {
    // Blank everything -> back to the house "RecruitersOS" brand.
    return ok({ branding: await setBranding(ws, { logoUrl: "", logoLightUrl: "", logoScale: undefined, brandName: "", accentColor: "", customDomain: "" }) });
  }

  // Allow large logos/pictures. The adjuster downscales, but a high-res or photo
  // logo can still be a few MB as a data URL — keep a generous ceiling.
  if (b?.logoUrl && b.logoUrl.length > 6_000_000) return fail("logo_too_large", 413);
  if (b?.logoLightUrl && b.logoLightUrl.length > 6_000_000) return fail("logo_too_large", 413);

  const patch: Parameters<typeof setBranding>[1] = {};
  if (b?.logoUrl !== undefined) patch.logoUrl = b.logoUrl;
  if (b?.logoLightUrl !== undefined) patch.logoLightUrl = b.logoLightUrl;
  if (b?.logoScale !== undefined && typeof b.logoScale === "number" && isFinite(b.logoScale)) {
    patch.logoScale = Math.max(0.4, Math.min(3, b.logoScale)); // clamp to a sane range
  }
  if (b?.brandName !== undefined) patch.brandName = b.brandName;
  if (b?.accentColor !== undefined) patch.accentColor = b.accentColor;
  if (b?.customDomain !== undefined) patch.customDomain = b.customDomain;
  if (Object.keys(patch).length === 0) return fail("nothing_to_save", 422);

  return ok({ branding: await setBranding(ws, patch) });
}
