/**
 * In-Market · Attach a PiP role video to outreach (the recipient bridge).
 *
 * Ties a generated picture-in-picture role video to the hiring-manager PROSPECTS at that
 * company, so the sequence that's already running for them renders this prospect's own video
 * (via the {{watchlink}} / {{videogif}} / {{videoembed}} merge fields in lib/automation/model).
 *
 * GET  /api/in-market/attach?company=Acme
 *        -> { count, prospects:[{id,fullName,email,campaignId,hasVideo}] } at that company,
 *           so the studio can show "attach to N prospects".
 * POST /api/in-market/attach
 *        { videoKey, watchUrl, gifUrl, roleTitle?, company?, prospectIds?, campaignId? }
 *        -> stamp prospect.personalizedVideo on the targeted prospects (explicit ids, else all
 *           workspace prospects matching `company`), optionally move them onto `campaignId`.
 *           Returns { attached }.
 *
 * Operator-only (requireSession); prospects are created from Hire Signals beforehand.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { getCore } from "../../../../lib/core/repository";
import type { Prospect } from "../../../../lib/core/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Loose company match so "Airbnb" pairs with "Airbnb, Inc." etc. */
function companyMatch(a?: string, b?: string): boolean {
  const x = (a || "").trim().toLowerCase().replace(/[.,]+$/, "");
  const y = (b || "").trim().toLowerCase().replace(/[.,]+$/, "");
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const company = new URL(req.url).searchParams.get("company") || "";
  if (!company) return fail("missing company", 422);

  const all = await getCore().listProspects(g.ctx.workspace.id);
  const matches = all.filter((p) => companyMatch(p.company, company));
  return ok({
    count: matches.length,
    prospects: matches.map((p) => ({
      id: p.id, fullName: p.fullName, email: p.email, title: p.title,
      campaignId: p.campaignId, hasVideo: !!p.personalizedVideo,
    })),
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const b = await body<any>(req);
  const videoKey = String(b?.videoKey ?? "").trim();
  const watchUrl = String(b?.watchUrl ?? "").trim();
  const gifUrl = String(b?.gifUrl ?? "").trim();
  if (!videoKey || !watchUrl || !gifUrl) return fail("missing videoKey/watchUrl/gifUrl", 422);

  const company = b?.company ? String(b.company) : "";
  const ids: string[] = Array.isArray(b?.prospectIds) ? b.prospectIds.map(String) : [];
  const campaignId = b?.campaignId ? String(b.campaignId) : "";

  const core = getCore();
  const all = await core.listProspects(ws);
  let targets: Prospect[];
  if (ids.length) targets = all.filter((p) => ids.includes(p.id));
  else if (company) targets = all.filter((p) => companyMatch(p.company, company));
  else return fail("provide prospectIds or company", 422);

  const pv = {
    videoKey, watchUrl, gifUrl,
    roleTitle: b?.roleTitle ? String(b.roleTitle) : undefined,
    at: new Date().toISOString(),
  };

  let attached = 0;
  for (const p of targets) {
    const next: Prospect = { ...p, personalizedVideo: pv };
    if (campaignId) next.campaignId = campaignId;
    await core.saveProspect(next);
    await core.recordActivity({
      id: `act_${videoKey}_${p.id}`.slice(0, 80),
      workspaceId: ws,
      prospectId: p.id,
      type: "video_attached",
      channel: "system",
      at: pv.at,
      summary: `PiP video attached${pv.roleTitle ? ` (${pv.roleTitle})` : ""}: ${watchUrl}`,
      campaignId: next.campaignId,
    }).catch(() => {});
    attached++;
  }

  return ok({ attached });
}
