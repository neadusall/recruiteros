/**
 * POST /api/linkedin/campaignFromDataset
 *   Receives scraped Sales Navigator leads from the Chrome extension and turns
 *   them into rich prospects under a campaign (created if needed).
 *
 *   Auth: Authorization: Bearer <ext-token> (from GET /api/ext-token). The
 *   extension runs in the user's browser, so it can't use the session cookie.
 *
 *   Body: { campaignName: string, leads: Lead[] }
 *   Lead: { fullName, firstName?, title?, headline?, company?, location?,
 *           photoUrl?, profileUrl?, salesNavUrl?, connectionDegree? }
 */

import { getCore } from "../../../../lib/core/repository";
import { addProspect } from "../../../../lib/prospects";
import { workspaceForToken, bearerToken } from "../../../../lib/exttoken";
import { getImportMotion } from "../../../../lib/importmotion";
import { rid, nowIso } from "../../../../lib/core/ids";
import { body, ok, fail } from "../../../../lib/api";

interface Lead {
  fullName?: string;
  firstName?: string;
  title?: string;
  headline?: string;
  company?: string;
  location?: string;
  photoUrl?: string;
  profileUrl?: string;
  salesNavUrl?: string;
}

export async function POST(req: Request) {
  const ws = await workspaceForToken(bearerToken(req));
  if (!ws) return fail("unauthorized", 401);

  const b = await body<{ campaignName?: string; leads?: Lead[]; motion?: string }>(req);
  const leads = Array.isArray(b?.leads) ? b!.leads : [];
  if (!leads.length) return fail("no_leads", 422);
  // Follow the portal's current motion so the leads land in the right bucket
  // (BD vs Recruiting). Use the explicit body motion if sent, else the
  // workspace's last-toggled import motion, else recruiting.
  const motion: "bd" | "recruiting" =
    b?.motion === "bd" ? "bd" : b?.motion === "recruiting" ? "recruiting" : await getImportMotion(ws);
  const name = (b?.campaignName || (motion === "bd" ? "LinkedIn import (BD)" : "LinkedIn import")).trim();

  const core = getCore();
  const camps = await core.listCampaigns(ws);
  let camp = camps.find((c) => c.name === name);
  if (!camp) {
    camp = {
      id: rid("camp"), workspaceId: ws, name, motion,
      goal: "Imported from LinkedIn / Sales Navigator", status: "draft",
      icp: {}, signals: [], steps: [], createdAt: nowIso(),
    } as any;
    await core.saveCampaign(camp as any);
  }

  let added = 0, deduped = 0;
  for (const l of leads) {
    if (!l || !l.fullName) continue;
    const linkedinUrl = l.profileUrl || l.salesNavUrl || undefined;
    if (linkedinUrl) {
      const existing = await core.findProspectByLinkedin(ws, linkedinUrl);
      if (existing) { deduped++; continue; }
    }
    await addProspect({
      workspaceId: ws,
      campaignId: camp.id,
      motion,
      fullName: l.fullName,
      title: l.title || l.headline,
      headline: l.headline,
      company: l.company,
      location: l.location,
      photoUrl: l.photoUrl,
      linkedinUrl,
      category: "linkedin_search",
    });
    added++;
  }

  return ok({ ok: true, campaignId: camp.id, campaign: name, added, deduped, total: leads.length });
}
