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

  // Generate the two-email SEQUENCE. The Day-0 base template + Day-1 video follow-up are ROTATED
  // per decision-maker (templateOpener index) so several DMs at ONE company each get a different
  // email — never the same copy three times. A company-seeded base draft (index 0) arms the
  // campaign model as the fallback for anyone we don't stamp individually below.
  const { templateOpener } = await import("../../../../lib/inmarket/videoOpener");
  const seqInput = { company, roleTitle, motion: "bd" as const };
  const baseDraft = templateOpener(seqInput); // Day-0 MPC (bd/mpc/templates) + Day-1 real-person video
  const nowIso = new Date().toISOString();

  // PER-RECIPIENT video: when the caller passes the compose inputs (clipId/clipIds [+pip, roleUrl]),
  // render each prospect its own composite. Multiple recordings (clipIds) + derived PiP layouts are
  // ROTATED per decision-maker so co-located DMs get visibly DIFFERENT videos (2 recordings → 3
  // distinct videos). Cached by (name, clip, layout). Without any clip we fall back to the shared key.
  const clipIds: string[] = Array.isArray(b?.clipIds) && b.clipIds.length
    ? b.clipIds.map((x: any) => String(x).trim()).filter(Boolean)
    : (String(b?.clipId ?? "").trim() ? [String(b.clipId).trim()] : []);
  const personalize = clipIds.length > 0 && b?.personalize !== false;
  const diversify = personalize && b?.diversify !== false;
  // LAUNCH GATE: when attaching to more than one decision-maker at a company, require ≥3 recordings
  // so each gets a DIFFERENT video (never the same message to two people down the hall from each other).
  const MIN_LAUNCH_CLIPS = 3;
  if (targets.length > 1 && clipIds.length < MIN_LAUNCH_CLIPS) {
    return fail(`Record ${MIN_LAUNCH_CLIPS} clips before launching to ${targets.length} decision-makers at ${company || "this company"} (so no two get the same video). You have ${clipIds.length}.`, 422);
  }
  const durationSec = Number(b?.durationSec) > 0 ? Number(b.durationSec) : undefined;
  const reqShot = { company, roleTitle, roleUrl: b?.roleUrl ? String(b.roleUrl) : undefined };
  const { cleanFirstName } = await import("../../../../lib/inmarket/nameAudio");
  const roleVideoMod = personalize ? await import("../../../../lib/inmarket/roleVideo") : null;
  const basePip = roleVideoMod ? roleVideoMod.normalizePip(b?.pip) : undefined;
  const layouts = roleVideoMod ? (diversify ? roleVideoMod.pipVariants(basePip) : [basePip!]) : [];
  const K = Math.max(1, clipIds.length), V = Math.max(1, layouts.length);
  const keyCache = new Map<string, string>(); // "name|clip|layoutIdx" → videoKey
  const personalizedNames = new Set<string>();
  async function resolveKey(fullName: string | null | undefined, i: number): Promise<string> {
    if (!personalize || !roleVideoMod) return videoKey;
    const clipId = clipIds[i % K];
    const layoutIdx = diversify ? Math.floor(i / K) % V : 0;
    const pip = layouts[layoutIdx] || basePip;
    const clean = cleanFirstName(fullName);
    const nm = (clean || "").toLowerCase();
    const cacheKey = `${nm}|${clipId}|${layoutIdx}`;
    if (keyCache.has(cacheKey)) return keyCache.get(cacheKey)!;
    const r = await roleVideoMod.getOrStartVideo(reqShot, clipId, pip, { firstName: clean || undefined, durationSec });
    keyCache.set(cacheKey, r.key!);
    if (clean) personalizedNames.add(nm);
    return r.key!;
  }
  const shareFor = (vk: string) => (vk === videoKey ? share : compositeShareUrls(vk, { company, roleTitle }));

  // Re-enroll only OUTREACHABLE prospects (never re-touch someone who replied/booked/won/closed/DNC).
  const ENROLLABLE = new Set(["queued", "in_sequence", "nurture"]);
  const arm = b?.arm !== false; // arm the sending cadence unless the caller opts out

  let attached = 0;
  let i = -1;
  const campaignIds = new Set<string>();
  for (const p of targets) {
    i++;
    // Each DM at this company gets its own rotated email copy...
    const draft = templateOpener(seqInput, { index: i });
    const sequence = { firstEmail: draft.first, secondEmail: draft.second };
    // ...and its own rotated video (clip + PiP layout).
    const vk = await resolveKey(p.fullName, i);
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
      c.model = videoSequenceModel(baseDraft, c.motion);
      c.outreachApproved = true;
      c.status = "active";
      c.autoRun = true;
      c.updatedAt = new Date().toISOString();
      await core.saveCampaign(c);
      armed++;
    }
  }

  const automationOn = ["on", "1", "true", "yes"].includes((process.env.AUTOMATION_ENABLED ?? "").trim().toLowerCase());
  const sequence = { firstEmail: baseDraft.first, secondEmail: baseDraft.second };
  return ok({ attached, armed, automationOn, personalizedNames: personalizedNames.size, diversified: attached > 1 && diversify, share, sequence });
}
