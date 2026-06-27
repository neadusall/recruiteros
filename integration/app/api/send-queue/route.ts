/**
 * Send Queue — rolling-buffer readiness dashboard + auto-fill control.
 *
 * GET  /api/send-queue
 *   -> { overview, autofill, campaigns } : send-ready supply, runway, per-day projection, the
 *      needs-assets breakdown, per-campaign readiness, the auto-fill settings/status, and the
 *      workspace's campaigns (for the auto-fill picker). Also arms the auto-fill timer.
 * POST /api/send-queue
 *   { action: "autofill_settings", settings } -> save the toggle / campaign / band / buffer.
 *   { action: "fill_now" }                    -> stage one batch right now (ignores the toggle).
 */

import { sendQueueOverview, needsAssetsList, type MissingAsset } from "../../../lib/sending/sendReady";
import { getAutofillSettings, setAutofillSettings, autofillStatus, runAutofill, ensureAutofill } from "../../../lib/sending/autofill";
import { getCore } from "../../../lib/core/repository";
import { requireSession, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  try {
    ensureAutofill(); // arm the buffer keeper (no-op until turned on)
    const nowIso = new Date().toISOString();
    const [overview, autofill, campaigns] = await Promise.all([
      sendQueueOverview(ws, nowIso),
      autofillStatus(nowIso),
      getCore().listCampaigns(ws),
    ]);
    // Slim campaign list for the picker (+ whether it's set up as the Send Queue campaign and its date).
    const camps = campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, sendQueue: !!c.sendQueue, scheduledFor: c.scheduledFor }));
    return ok({ overview, autofill, campaigns: camps });
  } catch (e: any) {
    return fail(e?.message ?? "send_queue_failed", e?.status ?? 500);
  }
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  // Save the auto-fill toggle / chosen campaign / target band / buffer. We always stamp the current
  // workspace so the background tick knows whose campaign to stage into.
  if (b?.action === "autofill_settings") {
    const s = (b.settings || {}) as Record<string, unknown>;
    try {
      const saved = await setAutofillSettings({
        enabled: s.enabled === true || s.enabled === false ? (s.enabled as boolean) : undefined,
        campaignId: s.campaignId !== undefined ? String(s.campaignId) : undefined,
        targetMin: s.targetMin !== undefined ? Number(s.targetMin) : undefined,
        targetMax: s.targetMax !== undefined ? Number(s.targetMax) : undefined,
        bufferDays: s.bufferDays !== undefined ? Number(s.bufferDays) : undefined,
        workspaceId: ws,
      });
      ensureAutofill();
      return ok({ settings: saved });
    } catch (e: any) {
      return fail(e?.message ?? "settings_failed", 422);
    }
  }

  // Stage one batch immediately (the "Fill now" button). Forces a run even if the toggle is off,
  // but still requires a chosen campaign. Stamp the workspace first so an un-saved picker still works.
  if (b?.action === "fill_now") {
    const cur = await getAutofillSettings();
    if (b.campaignId || !cur.campaignId) {
      await setAutofillSettings({ workspaceId: ws, campaignId: b.campaignId ? String(b.campaignId) : cur.campaignId });
    } else if (cur.workspaceId !== ws) {
      await setAutofillSettings({ workspaceId: ws });
    }
    try {
      const result = await runAutofill(new Date().toISOString(), { force: true });
      return ok({ result });
    } catch (e: any) {
      return fail(e?.message ?? "fill_failed", e?.status ?? 400);
    }
  }

  // One-click "set up as Send Queue campaign": mark it, retime 1st email → Day 0 / 2nd (video) → Day 1,
  // optional launch date. Never approves/activates sending.
  if (b?.action === "campaign_setup") {
    const campaignId = String(b.campaignId ?? "").trim();
    if (!campaignId) return fail("missing_campaign", 422);
    const { setupSendQueueCampaign } = await import("../../../lib/sending/sendQueueSetup");
    try {
      const result = await setupSendQueueCampaign(campaignId, { scheduledFor: b.scheduledFor !== undefined ? String(b.scheduledFor) : undefined });
      return ok({ result });
    } catch (e: any) {
      return fail(e?.message ?? "setup_failed", e?.status ?? 400);
    }
  }

  // The per-prospect worklist behind the "needs assets" cards: who's staged but not yet send-ready,
  // and exactly what each is missing — optionally sliced to one asset (verified_email | video | watch_page).
  if (b?.action === "needs_list") {
    const allowed: MissingAsset[] = ["verified_email", "video", "watch_page"];
    const missing = allowed.includes(b.missing) ? (b.missing as MissingAsset) : undefined;
    const items = await needsAssetsList(ws, { missing, limit: Math.min(Number(b.limit) || 200, 1000) });
    return ok({ items });
  }

  return fail("unknown_action", 400);
}
