/**
 * LinkedIn Comment Listener: who is commenting on the owner's posts, scored
 * (decision-maker + company-hiring) and tiered, with approval-gated replies.
 * GET returns the feed + readiness status. POST actions:
 *   scan            {}            -> scan now (the 15-min tick does this too)
 *   approve         { id, text? } -> post the reply via the shared engine
 *   skip            { id }
 *   edit            { id, text }
 *   draft           { id }        -> draft a reply on demand (community tier)
 *   connect_approve { id, text? } -> send the connection note
 *   connect_skip    { id }
 *   dm_approve      { id, text? } -> market radar: send the direct message.
 *                                    OPEN PROFILES ONLY (plus existing
 *                                    connections); never InMail
 *   dm_skip         { id }
 *   dm_edit         { id, text }
 *   comment_approve { id, text? } -> market radar, CLOSED profiles: leave the
 *                                    public comment on their hiring post.
 *                                    Day/week/spacing throttled; a throttle
 *                                    refusal leaves the draft open
 *   comment_skip    { id }
 *   comment_edit    { id, text }
 *   comment_limits_set { enabled?, perDay?, perWeek?, autoPost? }
 *                               -> the public-comment lane's throttle, and
 *                                  whether autopilot may post without approval
 *   pause / resume  {}
 *   auto_on / auto_off {}       -> autopilot: execute drafts hands-free
 *   keywords_set    { text }    -> comma-separated market-scan keyword bank
 *                                  (empty text restores the backend defaults)
 *   scenarios_set   { presets: string[], custom: [{label, phrase}] }
 *                               -> which hunting scenarios are active
 * Session-gated with outreach:send, same capability as the LinkedIn tab.
 */
import { ok, fail, body, requireCapability } from "../../../../lib/api";
import {
  commentWatchView, scanWorkspace, approveReply, skipReply, editReply, draftReply,
  approveConnect, skipConnect, approveDm, skipDm, editDm, setCommentWatchPaused,
  setCommentWatchAuto, setMarketKeywords, setScenarios, expandRoleFamily, aiHunt,
  setAutoIndustries, approvePostComment, skipPostComment, editPostComment, setCommentLimits,
} from "../../../../lib/linkedin/commentWatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  return ok(await commentWatchView(g.ctx.workspace.id));
}

export async function POST(req: Request): Promise<Response> {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; id?: string; text?: string }>(req);
  if (!b || !b.action) return fail("unknown_action");

  if (b.action === "scan") {
    const r = await scanWorkspace(ws);
    return ok({ ...r, view: await commentWatchView(ws) });
  }
  if (b.action === "pause" || b.action === "resume") {
    await setCommentWatchPaused(ws, b.action === "pause");
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "auto_on" || b.action === "auto_off") {
    await setCommentWatchAuto(ws, b.action === "auto_on");
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "keywords_set") {
    await setMarketKeywords(ws, String(b.text ?? "").split(",").map((k) => k.trim()).filter(Boolean));
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "scenarios_set") {
    const bb = b as { presets?: unknown; custom?: unknown; clear?: unknown };
    await setScenarios(ws,
      Array.isArray(bb.presets) ? bb.presets.map(String) : [],
      Array.isArray(bb.custom) ? bb.custom as Array<{ label?: string; phrase?: string }> : [],
      { allowClear: bb.clear === true });
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "expand_roles") {
    const r = await expandRoleFamily(String(b.text ?? "").split(",").map((k) => k.trim()).filter(Boolean));
    return ok(r);
  }
  if (b.action === "hunt_now") {
    const r = await aiHunt(ws, String(b.text ?? ""));
    return ok({ ...r, view: await commentWatchView(ws) });
  }
  if (b.action === "auto_industries_set") {
    const bb = b as { industries?: unknown };
    await setAutoIndustries(ws, Array.isArray(bb.industries) ? bb.industries.map(String) : []);
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "comment_limits_set") {
    const bb = b as { enabled?: unknown; perDay?: unknown; perWeek?: unknown; autoPost?: unknown };
    await setCommentLimits(ws, {
      enabled: typeof bb.enabled === "boolean" ? bb.enabled : undefined,
      perDay: bb.perDay === undefined ? undefined : Number(bb.perDay),
      perWeek: bb.perWeek === undefined ? undefined : Number(bb.perWeek),
      autoPost: typeof bb.autoPost === "boolean" ? bb.autoPost : undefined,
    });
    return ok({ view: await commentWatchView(ws) });
  }
  if (!b.id) return fail("missing_id");

  if (b.action === "approve") {
    const r = await approveReply(ws, g.ctx.user.id, g.ctx.user.email, String(b.id), b.text);
    return ok({ accepted: r.accepted, reason: r.reason, view: await commentWatchView(ws) });
  }
  if (b.action === "connect_approve") {
    const r = await approveConnect(ws, g.ctx.user.id, g.ctx.user.email, String(b.id), b.text);
    return ok({ accepted: r.accepted, reason: r.reason, view: await commentWatchView(ws) });
  }
  if (b.action === "skip") {
    await skipReply(ws, String(b.id));
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "connect_skip") {
    await skipConnect(ws, String(b.id));
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "dm_approve") {
    const r = await approveDm(ws, g.ctx.user.id, g.ctx.user.email, String(b.id), b.text);
    return ok({ accepted: r.accepted, reason: r.reason, view: await commentWatchView(ws) });
  }
  if (b.action === "dm_skip") {
    await skipDm(ws, String(b.id));
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "dm_edit") {
    if (!b.text) return fail("missing_text");
    await editDm(ws, String(b.id), String(b.text));
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "comment_approve") {
    const r = await approvePostComment(ws, g.ctx.user.id, g.ctx.user.email, String(b.id), b.text);
    return ok({ accepted: r.accepted, reason: r.reason, view: await commentWatchView(ws) });
  }
  if (b.action === "comment_skip") {
    await skipPostComment(ws, String(b.id));
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "comment_edit") {
    if (!b.text) return fail("missing_text");
    await editPostComment(ws, String(b.id), String(b.text));
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "edit") {
    if (!b.text) return fail("missing_text");
    await editReply(ws, String(b.id), String(b.text));
    return ok({ view: await commentWatchView(ws) });
  }
  if (b.action === "draft") {
    const item = await draftReply(ws, String(b.id));
    return ok({ drafted: !!item, view: await commentWatchView(ws) });
  }
  return fail("unknown_action");
}
