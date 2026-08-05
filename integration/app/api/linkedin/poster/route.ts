/**
 * LinkedIn Poster API (portal-session guarded, unlike the bearer-guarded
 * LinkedIn outreach engine routes: this one is driven by the recruiter's UI).
 *
 * GET  /api/linkedin/poster -> full tool state: inbox, drafts, image library,
 *   settings, Ayrshare connection status, and whether the automation clock is
 *   armed (scheduled posts need it).
 *
 * POST /api/linkedin/poster { action, ... }:
 *   add_inspiration   { author?, url?, text }
 *   delete_inspiration{ id }
 *   rewrite           { inspirationId? | text?, author?, guidance? } -> new draft
 *   regenerate        { draftId, guidance? }
 *   update_draft      { draftId, text?, imageId? (null clears), firstComment? }
 *   discard_draft     { draftId }
 *   approve           { draftId, when? }   <- THE gate: now, or scheduled
 *   cancel_schedule   { draftId }
 *   retry             { draftId }
 *   upload_image      { name?, dataUrl }
 *   delete_image      { id }
 *   make_card         { headline }
 *   make_original     { guidance? }         (AI writes a brand-grounded original)
 *   make_job_post     {}                    (blind spotlight of an open Job Library job)
 *   make_carousel     { draftId }           (draft -> branded slide PDF, attached)
 *   duplicate         { draftId }           (reuse a post as a fresh draft)
 *   refresh_stats     {}                    (pull engagement counters for posted)
 *   save_settings     { settings }
 *   watch_add         { name?, url }       (follow a creator; new posts land in the inbox)
 *   watch_remove      { id }
 *   watch_pull        { id }               (pull that creator's recent posts now)
 *   ayrshare_create_profile {}             (Business plan: per-workspace profile)
 *   ayrshare_link_url {}                   (Business plan: SSO linking URL)
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";
import {
  getState, addInspiration, deleteInspiration, rewriteToDraft, regenerateDraft,
  updateDraft, discardDraft, approveDraft, cancelSchedule, retryDraft,
  uploadImage, deleteImage, generateQuoteCard, saveSettings, getSettings,
  enginePublishStatus, addWatchedProfile, removeWatchedProfile, pullWatchedProfile,
  generateCarousel, duplicateDraft, refreshPostStats, createOriginalDraft, createJobSpotlightDraft,
} from "../../../../lib/linkedin/poster";
import {
  ayrshareConfigured, ayrshareLinkingConfigured, getAccountStatus, createProfile, generateLinkUrl,
} from "../../../../lib/providers/ayrshare";
import { automationEnabled, automationArmed } from "../../../../lib/automation/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const state = await getState(ws);
  const engine = await enginePublishStatus(ws);
  // Ayrshare's status probe is a live HTTP call; skip it entirely when no key is set.
  const ayrshare = await getAccountStatus(state.settings.ayrshareProfileKey || undefined);
  const publishVia = engine.ready ? "engine" : ayrshare.configured && ayrshare.linkedinConnected ? "ayrshare" : "none";
  return ok({
    ...state,
    engine,
    publishVia,
    ayrshare: { ...ayrshare, linkingConfigured: ayrshareLinkingConfigured() },
    automation: { enabled: automationEnabled(), armed: automationArmed() },
    anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
  });
}

interface PosterPost {
  action?: string;
  id?: string;
  author?: string;
  url?: string;
  text?: string;
  inspirationId?: string;
  guidance?: string;
  draftId?: string;
  imageId?: string | null;
  firstComment?: string;
  slides?: unknown[];
  when?: string;
  name?: string;
  dataUrl?: string;
  headline?: string;
  settings?: Record<string, unknown>;
}

export async function POST(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const b = await body<PosterPost>(req);
  if (!b?.action) return fail("action_required");

  try {
    switch (b.action) {
      case "add_inspiration": {
        if (!b.text?.trim()) return fail("text_required");
        return ok({ item: await addInspiration(ws, { author: b.author, url: b.url, text: b.text }) });
      }
      case "delete_inspiration": {
        if (!b.id) return fail("id_required");
        await deleteInspiration(ws, b.id);
        return ok({ deleted: true });
      }
      case "rewrite":
        return ok({ draft: await rewriteToDraft(ws, { inspirationId: b.inspirationId, text: b.text, author: b.author, guidance: b.guidance }) });
      case "regenerate": {
        if (!b.draftId) return fail("draftId_required");
        return ok({ draft: await regenerateDraft(ws, b.draftId, b.guidance) });
      }
      case "update_draft": {
        if (!b.draftId) return fail("draftId_required");
        return ok({ draft: await updateDraft(ws, b.draftId, { text: b.text, imageId: b.imageId, firstComment: b.firstComment }) });
      }
      case "discard_draft": {
        if (!b.draftId) return fail("draftId_required");
        await discardDraft(ws, b.draftId);
        return ok({ discarded: true });
      }
      case "approve": {
        if (!b.draftId) return fail("draftId_required");
        return ok({ draft: await approveDraft(ws, b.draftId, b.when) });
      }
      case "cancel_schedule": {
        if (!b.draftId) return fail("draftId_required");
        return ok({ draft: await cancelSchedule(ws, b.draftId) });
      }
      case "retry": {
        if (!b.draftId) return fail("draftId_required");
        return ok({ draft: await retryDraft(ws, b.draftId) });
      }
      case "upload_image": {
        if (!b.dataUrl) return fail("dataUrl_required");
        return ok({ image: await uploadImage(ws, { name: b.name, dataUrl: b.dataUrl }) });
      }
      case "delete_image": {
        if (!b.id) return fail("id_required");
        await deleteImage(ws, b.id);
        return ok({ deleted: true });
      }
      case "make_card": {
        if (!b.headline?.trim()) return fail("headline_required");
        return ok({ image: await generateQuoteCard(ws, { headline: b.headline }) });
      }
      case "make_original":
        return ok({ draft: await createOriginalDraft(ws, { topic: b.guidance }) });
      case "make_job_post":
        return ok({ draft: await createJobSpotlightDraft(ws) });
      case "make_carousel": {
        if (!b.draftId) return fail("draftId_required");
        const slides = Array.isArray(b.slides) ? b.slides.filter((x): x is string => typeof x === "string") : undefined;
        return ok(await generateCarousel(ws, { draftId: b.draftId, slides }));
      }
      case "duplicate": {
        if (!b.draftId) return fail("draftId_required");
        return ok({ draft: await duplicateDraft(ws, b.draftId) });
      }
      case "refresh_stats":
        return ok({ updated: await refreshPostStats(ws, true) });
      case "save_settings":
        return ok({ settings: await saveSettings(ws, (b.settings ?? {}) as never) });
      case "watch_add": {
        if (!b.url?.trim()) return fail("url_required");
        return ok({ profile: await addWatchedProfile(ws, { name: b.name, url: b.url }) });
      }
      case "watch_remove": {
        if (!b.id) return fail("id_required");
        await removeWatchedProfile(ws, b.id);
        return ok({ removed: true });
      }
      case "watch_pull": {
        if (!b.id) return fail("id_required");
        return ok(await pullWatchedProfile(ws, b.id));
      }
      case "ayrshare_create_profile": {
        if (!ayrshareConfigured()) return fail("ayrshare_not_configured", 409);
        const key = await createProfile(`RecruitersOS ${g.ctx.workspace.name ?? ws}`);
        const settings = await saveSettings(ws, { ayrshareProfileKey: key });
        return ok({ settings });
      }
      case "ayrshare_link_url": {
        const settings = await getSettings(ws);
        if (!settings.ayrshareProfileKey) return fail("no_profile_key: create a profile first", 409);
        return ok({ url: await generateLinkUrl(settings.ayrshareProfileKey) });
      }
      default:
        return fail("unknown_action");
    }
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message || "poster_error", err.status && err.status >= 400 && err.status < 600 ? err.status : 500);
  }
}
