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
  if (!videoKey) return fail("missing videoKey", 422);

  const company = b?.company ? String(b.company) : "";
  const roleTitle = b?.roleTitle ? String(b.roleTitle) : "";
  const ids: string[] = Array.isArray(b?.prospectIds) ? b.prospectIds.map(String) : [];
  const campaignId = b?.campaignId ? String(b.campaignId) : "";

  const core = getCore();
  const all = await core.listProspects(ws);
  let targets: Prospect[];
  if (ids.length) targets = all.filter((p) => ids.includes(p.id));
  else if (company) targets = all.filter((p) => companyMatch(p.company, company));
  else return fail("provide prospectIds or company", 422);

  // SIGN the share URLs server-side (don't trust client URLs) — the recipient surface requires
  // a valid signature; this also makes the attached links expire per the share TTL.
  const { compositeShareUrls } = await import("../../../../lib/inmarket/shareSign");
  const share = compositeShareUrls(videoKey, { company, roleTitle });

  // Generate the TWO-EMAIL SEQUENCE once (text intro → video follow-up) and attach to every
  // prospect, so outreach runs the right cadence — the video is ALWAYS the second touch.
  const { templateOpener } = await import("../../../../lib/inmarket/videoOpener");
  const seqInput = { company, roleTitle, motion: "bd" as const };
  const draft = templateOpener(seqInput); // Day-0 MPC (bd/mpc/templates) + Day-1 real-person video

  const sequence = { firstEmail: draft.first, secondEmail: draft.second };
  const nowIso = new Date().toISOString();

  // PER-RECIPIENT cloned-name personalization: when the caller passes the compose inputs
  // (clipId [+pip, roleUrl]), render each distinct first name's own "Hey {name}," composite
  // (cached by name, non-blocking) and stamp each prospect with THEIR videoKey + signed links.
  // Without clipId we fall back to the single shared videoKey.
  const clipId = String(b?.clipId ?? "").trim();
  const personalize = !!clipId && b?.personalize !== false;
  const reqShot = { company, roleTitle, roleUrl: b?.roleUrl ? String(b.roleUrl) : undefined };
  const { cleanFirstName } = await import("../../../../lib/inmarket/nameAudio");
  const roleVideoMod = personalize ? await import("../../../../lib/inmarket/roleVideo") : null;
  const keyByName = new Map<string, string>(); // normalized name ("" = no-name) → videoKey
  const personalizedNames = new Set<string>();
  async function resolveKey(fullName?: string | null): Promise<string> {
    if (!personalize || !roleVideoMod) return videoKey;
    const clean = cleanFirstName(fullName);
    const nm = (clean || "").toLowerCase();
    if (keyByName.has(nm)) return keyByName.get(nm)!;
    const r = await roleVideoMod.getOrStartVideo(reqShot, clipId, b?.pip, { firstName: clean || undefined });
    keyByName.set(nm, r.key!);
    if (clean) personalizedNames.add(nm);
    return r.key!;
  }
  const shareFor = (vk: string) => (vk === videoKey ? share : compositeShareUrls(vk, { company, roleTitle }));

  // Re-enroll only OUTREACHABLE prospects (never re-touch someone who replied/booked/won/closed/DNC).
  const ENROLLABLE = new Set(["queued", "in_sequence", "nurture"]);
  const arm = b?.arm !== false; // arm the sending cadence unless the caller opts out

  let attached = 0;
  const campaignIds = new Set<string>();
  for (const p of targets) {
    const vk = await resolveKey(p.fullName);
    const sh = shareFor(vk);
    const pv = {
      videoKey: vk, watchUrl: sh.watch, gifUrl: sh.gif, mp4Url: sh.mp4,
      roleTitle: roleTitle || undefined, sequence, expiresAt: sh.exp, at: nowIso,
    };
    const next: Prospect = { ...p, personalizedVideo: pv };
    if (campaignId) next.campaignId = campaignId;
    if (arm && ENROLLABLE.has(p.status)) {
      // Re-enroll into the 2-touch sequence from day 0 (email 1 now, video at day N).
      next.status = "queued";
      next.dripStage = 0;
      next.sequenceStartedAt = undefined;
    }
    if (next.campaignId) campaignIds.add(next.campaignId);
    await core.saveProspect(next);
    await core.recordActivity({
      id: `act_${vk}_${p.id}`.slice(0, 80),
      workspaceId: ws,
      prospectId: p.id,
      type: "video_attached",
      channel: "system",
      at: nowIso,
      summary: `PiP video sequence attached${roleTitle ? ` (${roleTitle})` : ""}: ${sh.watch}`,
      campaignId: next.campaignId,
    }).catch(() => {});
    attached++;
  }

  // ARM the campaign(s): set the approved 2-touch video model + activate autopilot so the cadence
  // engine sends email 1 (day 0) → email 2 video follow-up (day N). Gated globally by AUTOMATION_ENABLED.
  let armed = 0;
  if (arm) {
    const { videoSequenceModel } = await import("../../../../lib/inmarket/videoOpener");
    for (const cid of campaignIds) {
      const c = await core.getCampaign(cid);
      if (!c) continue;
      c.model = videoSequenceModel(draft, c.motion);
      c.outreachApproved = true;
      c.status = "active";
      c.autoRun = true;
      c.updatedAt = new Date().toISOString();
      await core.saveCampaign(c);
      armed++;
    }
  }

  const automationOn = ["on", "1", "true", "yes"].includes((process.env.AUTOMATION_ENABLED ?? "").trim().toLowerCase());
  return ok({ attached, armed, automationOn, personalizedNames: personalizedNames.size, share, sequence });
}
