/**
 * RecruitersOS · In-Market · PiP video analytics
 *
 * Engagement tracking for the personalized role videos: who opened the email teaser, who
 * landed on the watch page, who pressed play, how long they watched, who finished. Events come
 * from the public watch page (watch.html) + the public GIF serve; the operator reads aggregated
 * stats in the PiP Studio "Performance" view.
 *
 * Durable via the Postgres snapshot KV (graceful no-op without DATABASE_URL, like the rest of
 * the in-market modules). Bounded: per-video aggregates + a capped recent-events feed, so the
 * snapshot never grows without limit.
 */

import { loadSnapshot, debouncedSaver } from "../db";

const STATS_KEY = "inmarket_video_stats_v1";
const FEED_CAP = 400;        // recent events kept for the activity feed
const VIEWERS_CAP = 2000;    // distinct sessions tracked per video (then count-only)

export type VideoEventType = "open" | "play" | "complete" | "heartbeat" | "gif_open";

export interface VideoEventIn {
  videoKey: string;
  type: VideoEventType;
  company?: string;
  roleTitle?: string;
  recipient?: string;   // optional per-recipient label (prospect id / name from a merge tag)
  seconds?: number;     // for heartbeat: seconds watched since the last beat
  sessionId?: string;   // anonymous per-viewer-session id (from the watch page)
}

export interface VideoAgg {
  videoKey: string;
  company?: string;
  roleTitle?: string;
  opens: number;        // watch-page loads
  plays: number;        // play presses
  completes: number;    // finished the video
  gifOpens: number;     // email teaser GIF loads (approx email opens)
  watchSeconds: number; // total seconds watched
  viewers: string[];    // distinct session ids (capped) -> unique viewers
  viewerOverflow: number;
  firstAt?: string;
  lastAt?: string;
  days: Record<string, number>; // YYYY-MM-DD -> plays that day (trend)
}

export interface RecentEvent {
  videoKey: string;
  company?: string;
  roleTitle?: string;
  type: VideoEventType;
  recipient?: string;
  at: string;
}

interface StatsState {
  byKey: Record<string, VideoAgg>;
  feed: RecentEvent[];
}

let mem: StatsState | null = null;
let loading: Promise<void> | null = null;

async function ensure(): Promise<StatsState> {
  if (mem) return mem;
  if (!loading) {
    loading = (async () => {
      const raw = (await loadSnapshot<StatsState>(STATS_KEY).catch(() => null)) || null;
      mem = raw && raw.byKey ? { byKey: raw.byKey, feed: raw.feed || [] } : { byKey: {}, feed: [] };
    })().catch(() => { mem = { byKey: {}, feed: [] }; });
  }
  await loading;
  return mem ?? (mem = { byKey: {}, feed: [] });
}

const scheduleSave = debouncedSaver(STATS_KEY, () => (mem ? mem : { byKey: {}, feed: [] }), 1200);

const VALID_KEY = /^[a-z0-9_-]{3,120}$/;
const today = () => new Date().toISOString().slice(0, 10);

/** Record one engagement event. Fire-and-forget from request handlers. */
export async function recordVideoEvent(e: VideoEventIn): Promise<void> {
  if (!e || !VALID_KEY.test(e.videoKey || "")) return;
  const st = await ensure();
  const now = new Date().toISOString();
  const a = (st.byKey[e.videoKey] ||= {
    videoKey: e.videoKey, opens: 0, plays: 0, completes: 0, gifOpens: 0,
    watchSeconds: 0, viewers: [], viewerOverflow: 0, days: {},
  });
  if (e.company && !a.company) a.company = e.company.slice(0, 120);
  if (e.roleTitle && !a.roleTitle) a.roleTitle = e.roleTitle.slice(0, 160);
  a.firstAt ||= now;
  a.lastAt = now;

  switch (e.type) {
    case "open": a.opens++; break;
    case "play":
      a.plays++;
      a.days[today()] = (a.days[today()] || 0) + 1;
      break;
    case "complete": a.completes++; break;
    case "gif_open": a.gifOpens++; break;
    case "heartbeat": a.watchSeconds += Math.max(0, Math.min(60, Math.round(e.seconds || 0))); break;
  }

  // Unique viewers (by session id), capped.
  if (e.sessionId && (e.type === "open" || e.type === "play")) {
    if (!a.viewers.includes(e.sessionId)) {
      if (a.viewers.length < VIEWERS_CAP) a.viewers.push(e.sessionId);
      else a.viewerOverflow++;
    }
  }

  // Activity feed (skip heartbeats — too noisy).
  if (e.type !== "heartbeat") {
    st.feed.unshift({
      videoKey: e.videoKey, company: a.company, roleTitle: a.roleTitle,
      type: e.type, recipient: e.recipient, at: now,
    });
    if (st.feed.length > FEED_CAP) st.feed.length = FEED_CAP;
  }

  scheduleSave();
}

export interface VideoStatRow {
  videoKey: string;
  company?: string;
  roleTitle?: string;
  opens: number;
  plays: number;
  completes: number;
  gifOpens: number;
  uniqueViewers: number;
  watchSeconds: number;
  avgWatchSeconds: number;
  completionRate: number; // completes / plays
  playRate: number;       // plays / opens
  lastAt?: string;
}

function toRow(a: VideoAgg): VideoStatRow {
  const uniqueViewers = a.viewers.length + a.viewerOverflow;
  return {
    videoKey: a.videoKey, company: a.company, roleTitle: a.roleTitle,
    opens: a.opens, plays: a.plays, completes: a.completes, gifOpens: a.gifOpens,
    uniqueViewers, watchSeconds: a.watchSeconds,
    avgWatchSeconds: a.plays ? Math.round(a.watchSeconds / a.plays) : 0,
    completionRate: a.plays ? a.completes / a.plays : 0,
    playRate: a.opens ? a.plays / a.opens : 0,
    lastAt: a.lastAt,
  };
}

export interface StatsOverview {
  totals: {
    videos: number;
    gifOpens: number;
    opens: number;
    plays: number;
    completes: number;
    uniqueViewers: number;
    watchSeconds: number;
    avgWatchSeconds: number;
    completionRate: number;
  };
  trend: { date: string; plays: number; opens: number }[]; // last `days` days
  videos: VideoStatRow[];   // per-video, plays desc
  recent: RecentEvent[];    // newest first
}

/** Aggregated stats for the operator dashboard. */
export async function statsOverview(opts?: { days?: number; recent?: number }): Promise<StatsOverview> {
  const st = await ensure();
  const aggs = Object.values(st.byKey);
  const rows = aggs.map(toRow).sort((x, y) => y.plays - x.plays || y.opens - x.opens);

  const totals = rows.reduce(
    (t, r) => {
      t.gifOpens += r.gifOpens; t.opens += r.opens; t.plays += r.plays;
      t.completes += r.completes; t.uniqueViewers += r.uniqueViewers; t.watchSeconds += r.watchSeconds;
      return t;
    },
    { videos: rows.length, gifOpens: 0, opens: 0, plays: 0, completes: 0, uniqueViewers: 0, watchSeconds: 0, avgWatchSeconds: 0, completionRate: 0 },
  );
  totals.avgWatchSeconds = totals.plays ? Math.round(totals.watchSeconds / totals.plays) : 0;
  totals.completionRate = totals.plays ? totals.completes / totals.plays : 0;

  // Trend: last N days. Opens trend uses lastAt-day approximation isn't stored per-day, so we
  // derive plays/day from each agg's `days` map (the metric that matters for engagement).
  const nDays = Math.max(1, Math.min(60, opts?.days ?? 14));
  const dates: string[] = [];
  const base = new Date(today() + "T00:00:00Z").getTime();
  for (let i = nDays - 1; i >= 0; i--) dates.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  const trend = dates.map((date) => ({
    date,
    plays: aggs.reduce((s, a) => s + (a.days[date] || 0), 0),
    opens: 0,
  }));

  return {
    totals,
    trend,
    videos: rows,
    recent: st.feed.slice(0, Math.max(1, Math.min(FEED_CAP, opts?.recent ?? 60))),
  };
}

/** Stats for a single video (or undefined if none yet). */
export async function statsForVideo(videoKey: string): Promise<VideoStatRow | null> {
  if (!VALID_KEY.test(videoKey || "")) return null;
  const st = await ensure();
  const a = st.byKey[videoKey];
  return a ? toRow(a) : null;
}
