/**
 * /api/signals/watch, Signal Watchlists (target-job feeds that poll on a cadence).
 *
 * TWO callers, one route:
 *
 *  1) The 15-min SCHEDULER (systemd timer / cron), authed by x-cron-secret === RECRUITEROS_CRON_SECRET
 *    , same posture as /api/sourcing/night:
 *        GET|POST ?tick=1&secret=…    → advance every DUE watchlist one poll (fire-and-forget)
 *        GET      ?status=1&secret=…  → peek the sweep (no work): budget + per-list stats
 *
 *  2) The UI (session-authed), for managing watchlists:
 *        GET                          → this workspace's watchlists + feed status + daily budget
 *        POST { action:"save",   watchlist }   → create/update a watchlist
 *        POST { action:"toggle", id, active }  → pause / resume
 *        POST { action:"delete", id }          → remove
 *        POST { action:"run",    id }          → poll this list NOW (ignores cadence, the test button)
 *
 * The long poll work runs inside the tick; the cron branch fires-and-forgets so the request never
 * outlives the proxy timeout, exactly like the night-queue tick.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { requireSession, body, ok, fail } from "../../../../lib/api";
import { jobFeedEnabled } from "../../../../lib/inmarket/jobFeed";
import { getRapidQuota } from "../../../../lib/sourcing/rapidQuota";
import {
  listWatchlists, upsertWatchlist, setWatchlistActive, deleteWatchlist,
  fetchBudgetRemaining, dailyFetchCap, tickWatchlists, pollWatchlistNow, getWatchHealth,
  type WatchlistInput,
} from "../../../../lib/signals/watch";
import { nowIso } from "../../../../lib/core/ids";

/** A request is the SCHEDULER's when it carries a cron secret or the cron-only verbs. */
function looksLikeCron(req: Request): boolean {
  const u = new URL(req.url);
  return !!(req.headers.get("x-cron-secret") || u.searchParams.get("secret") ||
    u.searchParams.get("tick") || u.searchParams.get("status"));
}

async function cronBranch(req: Request): Promise<NextResponse> {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;

  if (params.get("status") === "1") {
    // Peek without doing work: heartbeat + budget + a compact per-list readout. A watchdog reads
    // `health.lastTickAt` (stale => timer dead) and `health.consecutiveErrors` (climbing => outage).
    const lists = await listWatchlists();
    const remaining = await fetchBudgetRemaining(nowIso());
    const health = await getWatchHealth();
    return NextResponse.json({
      ok: true,
      health,
      budget: { remaining, cap: dailyFetchCap() },
      activeWatchlists: lists.filter((w) => w.active).length,
      watchlists: lists.map((w) => ({
        id: w.id, name: w.name, active: w.active, everyMinutes: w.everyMinutes,
        lastPolledAt: w.lastPolledAt, stats: w.stats,
      })),
    });
  }

  // Fire-and-forget: a sweep can run for a while; tickWatchlists() is single-flight so overlapping
  // timer hits are harmless no-ops.
  void tickWatchlists().catch((e) => console.warn("[signals-watch] tick failed:", e?.message ?? e));
  return NextResponse.json({ ok: true, ticked: true });
}

export async function GET(req: Request) {
  if (looksLikeCron(req)) return cronBranch(req);

  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const lists = await listWatchlists(ws);
  return ok({
    watchlists: lists,
    feedEnabled: jobFeedEnabled(),
    budget: { remaining: await fetchBudgetRemaining(nowIso()), cap: dailyFetchCap() },
    // The JSearch subscription's latest monthly-credit reading, captured from its own
    // response headers on every feed pull (searches and watch polls alike). Empty until
    // the first pull after this shipped.
    apiQuota: await getRapidQuota("jobs"),
  });
}

export async function POST(req: Request) {
  if (looksLikeCron(req)) return cronBranch(req);

  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);
  const action = b?.action ?? "save";

  try {
    if (action === "save") {
      const input = (b?.watchlist ?? b) as WatchlistInput;
      if (!input?.query && !input?.industry && !input?.id) return fail("missing_query", 422);
      const saved = await upsertWatchlist(ws, input);
      return ok({ watchlist: saved });
    }
    if (action === "toggle") {
      if (!b?.id) return fail("missing_id", 422);
      const okd = await setWatchlistActive(b.id, b.active !== false);
      return okd ? ok({ id: b.id, active: b.active !== false }) : fail("not_found", 404);
    }
    if (action === "delete") {
      if (!b?.id) return fail("missing_id", 422);
      const okd = await deleteWatchlist(b.id);
      return okd ? ok({ id: b.id, deleted: true }) : fail("not_found", 404);
    }
    if (action === "run") {
      if (!b?.id) return fail("missing_id", 422);
      const outcome = await pollWatchlistNow(b.id);
      return outcome ? ok({ outcome }) : fail("not_found", 404);
    }
    return fail("unknown_action", 400);
  } catch (e) {
    return fail((e as Error)?.message?.slice(0, 200) || "watch_error", 500);
  }
}
