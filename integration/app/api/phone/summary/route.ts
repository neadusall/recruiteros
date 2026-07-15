/**
 * GET /api/phone/summary
 * One bootstrap call for the phone UI: my lines + active line, workspace
 * settings, my live call if one is in flight (browser-refresh resume),
 * recent calls, and open follow-ups. Polled lightly by the phone tab.
 */

import { requireCapability, ok } from "../../../../lib/api";
import {
  linesForUser, getUserState, getPhoneSettings, queryCalls, findLiveCall,
  listFollowUps, phoneDayStats, callQueue, ensurePhoneReady,
} from "../../../../lib/phone/store";
import { sweepPipelines } from "../../../../lib/phone/calls";
import type { Motion } from "../../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  sweepPipelines();

  const ws = g.ctx.workspace.id;
  const url = new URL(req.url);
  const motion: Motion = url.searchParams.get("motion") === "recruiting" ? "recruiting" : "bd";
  const isAdmin = g.ctx.capabilities.includes("telnyx:manage");

  const lines = linesForUser(ws, g.ctx.user.id, isAdmin, motion);
  const state = getUserState(ws, g.ctx.user.id);
  const activeLineId =
    state.activeLineId && lines.some((l) => l.id === state.activeLineId)
      ? state.activeLineId
      : lines[0]?.id;

  const recent = queryCalls(ws, motion, { limit: 12 });
  const missed = queryCalls(ws, motion, { direction: "missed", limit: 1 });

  return ok({
    lines,
    activeLineId,
    settings: getPhoneSettings(ws, motion),
    liveCall: findLiveCall(ws, g.ctx.user.id) ?? null,
    recent: recent.calls,
    totalCalls: recent.total,
    missedCount: missed.total,
    openFollowUps: listFollowUps(ws, motion, { status: "open" }).slice(0, 20),
    stats: phoneDayStats(ws, motion),
    queue: callQueue(ws, motion),
    isAdmin,
    userId: g.ctx.user.id,
  });
}
