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
import { body, ok, fail, requireCapability } from "../../../../lib/api";
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
    // News-feed breaker state. A watchdog should treat `newsFeed.open` as a real
    // outage: while it is open every news list reports zero, and a zero that is
    // actually a block must never read as a quiet market.
    const { newsFeedHealth } = await import("../../../../lib/signals/watch/newsDiscover");
    // Job-feed health is the same guarantee for the paid arm. JSearch answers a broken
    // subscription with 200 OK + zero jobs, so `jobFeed.suspectOutage` is what stops a
    // dead feed from being logged as "0 net-new companies" — a number that looks like a
    // slow market and is actually no data at all.
    const { jobFeedHealth } = await import("../../../../lib/inmarket/jobFeed");
    // Back pressure: whether discovery is currently paused because the send queue is
    // already full, and what the day's staging target actually resolved to. Without
    // these, a deliberately paused belt and a dead one produce the same zeros.
    const { beltRoom } = await import("../../../../lib/signals/watch/poll");
    const { dailyTargetExplained } = await import("../../../../lib/sending/autofill");
    const [capacity, target] = await Promise.all([
      beltRoom().catch(() => undefined),
      dailyTargetExplained().catch(() => undefined),
    ]);
    return NextResponse.json({
      ok: true,
      health,
      newsFeed: newsFeedHealth(),
      jobFeed: jobFeedHealth(),
      capacity,
      dailyTarget: target,
      budget: { remaining, cap: dailyFetchCap() },
      activeWatchlists: lists.filter((w) => w.active).length,
      newsWatchlists: lists.filter((w) => w.source === "news" && w.active).length,
      watchlists: lists.map((w) => ({
        id: w.id, name: w.name, source: w.source, active: w.active, everyMinutes: w.everyMinutes,
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

  const g = requireCapability(req, "sourcing:run");
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

  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);
  const action = b?.action ?? "save";

  try {
    if (action === "save") {
      const input = (b?.watchlist ?? b) as WatchlistInput;
      // A news list searches a SEGMENT, not a job query, so it has no `query` to check.
      // Requiring one here is what would silently reject every news watchlist.
      const hasTerm = input?.source === "news"
        ? Boolean(input?.segment?.trim())
        : Boolean(input?.query || input?.industry);
      if (!hasTerm && !input?.id) {
        return fail(input?.source === "news" ? "missing_segment" : "missing_query", 422);
      }
      const saved = await upsertWatchlist(ws, input);
      return ok({ watchlist: saved });
    }
    // The desk profile: who this firm is, what it recruits into, how it positions.
    // These are the only claims the signal-anchored pitch makes about the SENDER, so
    // they cannot be inferred from a headline and have to be stored per workspace.
    if (action === "deskProfile") {
      const { getDeskProfile, profileComplete } = await import("../../../../lib/signals/watch/signalPitch");
      const profile = await getDeskProfile(ws);
      return ok({ profile, complete: profileComplete(profile) });
    }
    if (action === "saveDeskProfile") {
      const { saveDeskProfile, profileComplete } = await import("../../../../lib/signals/watch/signalPitch");
      const profile = await saveDeskProfile(ws, (b?.profile ?? {}) as never);
      return ok({ profile, complete: profileComplete(profile) });
    }
    // Head to head: Hire Signals (job feed) vs news signals, on reply rate per send.
    // Deliberately conservative, see lib/signals/watch/sourceTrial.ts: it answers
    // "insufficient_data" with a number of sends still needed rather than naming a
    // winner off a sample that cannot support one.
    if (action === "sourceTrial") {
      const { allCurated } = await import("../../../../lib/inmarket/curation");
      const { compareArms } = await import("../../../../lib/signals/watch/sourceTrial");
      const report = compareArms(await allCurated(), {
        from: typeof b?.from === "string" ? b.from : undefined,
        to: typeof b?.to === "string" ? b.to : undefined,
        minSendsPerArm: Number.isFinite(Number(b?.minSendsPerArm)) ? Number(b.minSendsPerArm) : undefined,
        baselineRate: Number.isFinite(Number(b?.baselineRate)) ? Number(b.baselineRate) : undefined,
      });
      return ok({ trial: report });
    }
    // Which VERTICAL is working, which is the weekly decision. Deliberately separate from
    // sourceTrial: that answers "jobs or news" once, this answers "keep this segment on"
    // every week, and it reports upstream screenability well before reply rate is readable
    // so a desk is not waiting a quarter to turn off a segment that never produced.
    if (action === "listTrial") {
      const { allCurated } = await import("../../../../lib/inmarket/curation");
      const { compareLists } = await import("../../../../lib/signals/watch/sourceTrial");
      const lists = await listWatchlists(ws);
      const names: Record<string, string> = {};
      for (const w of lists) names[w.id] = w.name;
      const rows = compareLists(await allCurated(), {
        from: typeof b?.from === "string" ? b.from : undefined,
        to: typeof b?.to === "string" ? b.to : undefined,
        minProspects: Number.isFinite(Number(b?.minProspects)) ? Number(b.minProspects) : undefined,
        minSends: Number.isFinite(Number(b?.minSends)) ? Number(b.minSends) : undefined,
        names,
      });
      return ok({ lists: rows });
    }
    // The measured vertical presets, and one-click creation of them. The three fields that
    // decide whether a list produces anything (segment string, signals, target roles) are
    // the three nobody guesses right, so this is the difference between the feature being
    // usable and being configurable.
    if (action === "presets") {
      const { VERTICAL_PRESETS } = await import("../../../../lib/signals/watch/presets");
      const existing = new Set((await listWatchlists(ws)).map((w) => (w.segment || "").trim().toLowerCase()));
      return ok({
        presets: VERTICAL_PRESETS.map((p) => ({ ...p, alreadyAdded: existing.has(p.segment.toLowerCase()) })),
      });
    }
    if (action === "addPresets") {
      const { VERTICAL_PRESETS, presetByKey, presetToWatchlist } = await import("../../../../lib/signals/watch/presets");
      const keys: string[] = Array.isArray(b?.keys) && b.keys.length
        ? b.keys.map((k: unknown) => String(k))
        // No explicit selection means the tier-A set: the verticals defensible on a
        // logistics desk today. Never every preset, because tier B asserts a desk the
        // firm may not be able to claim, and the pitch would degrade to filler.
        : VERTICAL_PRESETS.filter((p) => p.tier === "a").map((p) => p.key);
      // Adding the same vertical twice would double-pitch every company it finds, so an
      // existing segment is reported as skipped rather than duplicated.
      const existing = new Set((await listWatchlists(ws)).map((w) => (w.segment || "").trim().toLowerCase()));
      const added: string[] = [];
      const skipped: string[] = [];
      for (const key of keys) {
        const p = presetByKey(key);
        if (!p) { skipped.push(key); continue; }
        if (existing.has(p.segment.toLowerCase())) { skipped.push(p.key); continue; }
        await upsertWatchlist(ws, presetToWatchlist(p, { active: b?.active !== false }));
        existing.add(p.segment.toLowerCase());
        added.push(p.key);
      }
      return ok({ added, skipped, watchlists: await listWatchlists(ws) });
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
