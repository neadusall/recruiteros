/**
 * RecruitersOS · In-Market · Worker FLEET telemetry
 *
 * In-memory, per-worker live metrics for the fleet view: who's online, jobs/min, names/hour, totals.
 * The worker route feeds this on every claim/submit; the curation_funnel read exposes it to the UI.
 * Single main process → an in-memory map is enough; it resets on redeploy (fine — it's live telemetry,
 * not the data of record). Bounded so a flood of worker ids can't grow it unbounded.
 */

interface Ev { at: number; jobs: number; named: number }
/** VIDEO events are kept apart from research events on purpose: a box that only renders video would
 *  otherwise read as a research box with a names/hour rate, and a dead video unit on a live research
 *  box would be invisible — which is exactly how video output stalled silently. */
interface VEv { at: number; made: number }
interface W {
  id: string; firstSeen: number; lastSeen: number; claims: number;
  totalJobs: number; totalNamed: number; totalSourced: number; ev: Ev[]; health?: WorkerHealth;
  videoClaims: number; totalVideos: number; lastVideoClaimAt: number; vev: VEv[];
}

/** Compact per-box health digest reported by each worker on its heartbeat (claim/submit). Self-reported
 *  telemetry from a token-authenticated box — coerced defensively where it's recorded. */
export interface WorkerHealth {
  status: "healthy" | "degraded" | "unhealthy";
  reasons: string[];
  cc: { resting: boolean; breakerTrips: number; spacingMs: number; cooldownSec: number };
  search: "healthy" | "degraded" | "throttled" | "idle";
  namedPerHour: number;
  at: number;            // when the box reported it (epoch ms)
}

const fleet = new Map<string, W>();
const KEEP_MS = 60 * 60 * 1000;   // keep one hour of events for rate math
const MAX_WORKERS = 100;

function get(id: string): W {
  let w = fleet.get(id);
  if (!w) {
    if (fleet.size >= MAX_WORKERS) {
      let stalest: string | null = null, t = Infinity;
      for (const [k, v] of fleet) if (v.lastSeen < t) { t = v.lastSeen; stalest = k; }
      if (stalest) fleet.delete(stalest);
    }
    const now = Date.now();
    w = { id, firstSeen: now, lastSeen: now, claims: 0, totalJobs: 0, totalNamed: 0, totalSourced: 0, ev: [], videoClaims: 0, totalVideos: 0, lastVideoClaimAt: 0, vev: [] };
    fleet.set(id, w);
  }
  return w;
}

export function recordClaim(id: string, count: number): void {
  if (!id) return;
  const w = get(id);
  w.lastSeen = Date.now();
  w.claims += Math.max(0, count);
}

/** A box asked for VIDEO jobs. Recorded even when the claim came back empty — the point of this
 *  counter is "is anything still asking?", which is what tells a stall (units dead) apart from a
 *  starved queue (units alive, nothing to hand them). */
export function recordVideoClaim(id: string, count: number): void {
  if (!id) return;
  const w = get(id);
  const now = Date.now();
  w.lastSeen = now;
  w.lastVideoClaimAt = now;
  w.videoClaims += Math.max(0, count);
}

/** A box reported finished composites. Kept out of recordSubmit so videos never inflate names/hour. */
export function recordVideoSubmit(id: string, made: number): void {
  if (!id) return;
  const w = get(id);
  const now = Date.now();
  w.lastSeen = now;
  w.totalVideos += Math.max(0, made);
  w.vev.push({ at: now, made: Math.max(0, made) });
  if (w.vev.length > 2000 || w.vev[0].at < now - KEEP_MS) w.vev = w.vev.filter((e) => e.at > now - KEEP_MS);
}

/** A worker shipped freshly-SOURCED companies to the pool (the "build" half). */
export function recordSource(id: string, count: number): void {
  if (!id) return;
  const w = get(id);
  w.lastSeen = Date.now();
  w.totalSourced += Math.max(0, count);
}

export function recordSubmit(id: string, jobs: number, named: number): void {
  if (!id) return;
  const w = get(id);
  const now = Date.now();
  w.lastSeen = now;
  w.totalJobs += Math.max(0, jobs);
  w.totalNamed += Math.max(0, named);
  w.ev.push({ at: now, jobs: Math.max(0, jobs), named: Math.max(0, named) });
  if (w.ev.length > 2000 || w.ev[0].at < now - KEEP_MS) w.ev = w.ev.filter((e) => e.at > now - KEEP_MS);
}

const SH = new Set(["healthy", "degraded", "throttled", "idle"]);
const ST = new Set(["healthy", "degraded", "unhealthy"]);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** Record a worker's self-reported health digest (heartbeat). Coerces untrusted input into shape. */
export function recordHealth(id: string, raw: unknown): void {
  if (!id || !raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  const cc = (r.cc && typeof r.cc === "object" ? r.cc : {}) as Record<string, unknown>;
  const w = get(id);
  w.lastSeen = Date.now();
  w.health = {
    status: ST.has(String(r.status)) ? (r.status as WorkerHealth["status"]) : "degraded",
    reasons: Array.isArray(r.reasons) ? r.reasons.map((x) => String(x).slice(0, 200)).slice(0, 8) : [],
    cc: {
      resting: cc.resting === true,
      breakerTrips: Math.max(0, Math.round(num(cc.breakerTrips))),
      spacingMs: Math.max(0, Math.round(num(cc.spacingMs))),
      cooldownSec: Math.max(0, Math.round(num(cc.cooldownSec))),
    },
    search: SH.has(String(r.search)) ? (r.search as WorkerHealth["search"]) : "idle",
    namedPerHour: Math.max(0, Math.round(num(r.namedPerHour))),
    at: Date.now(),
  };
}

export interface FleetWorker {
  id: string;
  online: boolean;
  lastSeenSec: number;
  jobsPerMin: number;
  namesPerHour: number;
  totalJobs: number;
  totalNamed: number;
  /** Companies this box has SOURCED into the pool (the build half). */
  totalSourced: number;
  /** Latest self-reported health digest from the box (undefined until it heartbeats). */
  health?: WorkerHealth;
  /** VIDEO half of this box: composites finished in the last hour and since it came up. */
  videosPerHour: number;
  totalVideos: number;
  /** Seconds since this box last ASKED for video jobs; null if it never has (no video unit running). */
  lastVideoClaimSec: number | null;
}
export interface FleetStatus {
  workers: FleetWorker[];
  online: number;
  totalJobsPerMin: number;
  totalNamesPerHour: number;
  totalNamed: number;
  /** Fleet-wide health roll-up: worst online box wins, so a single strained IP is visible at a glance. */
  health: "healthy" | "degraded" | "unhealthy" | "idle";
  /** VIDEO fleet, tracked separately from research: boxes whose video unit claimed in the last 5 min
   *  (the worker's idle sleep is 30s, so a live unit always lands inside that window), what they
   *  produced, and how long since ANY box asked for video work. videoOnline 0 with work waiting =
   *  the render units are down, not a starved queue. */
  videoOnline: number;
  totalVideosPerHour: number;
  totalVideos: number;
  lastVideoClaimSec: number | null;
}

export function fleetStatus(): FleetStatus {
  const now = Date.now();
  const workers: FleetWorker[] = [];
  for (const w of fleet.values()) {
    const elapsedMin = Math.max(1 / 60, (now - w.firstSeen) / 60_000);
    const jobs5 = w.ev.filter((e) => e.at > now - 300_000).reduce((s, e) => s + e.jobs, 0);
    const names60 = w.ev.filter((e) => e.at > now - 3_600_000).reduce((s, e) => s + e.named, 0);
    const videos60 = w.vev.filter((e) => e.at > now - 3_600_000).reduce((s, e) => s + e.made, 0);
    workers.push({
      id: w.id,
      online: now - w.lastSeen < 120_000,                 // seen in the last 2 min
      lastSeenSec: Math.round((now - w.lastSeen) / 1000),
      jobsPerMin: Math.round((jobs5 / Math.min(5, elapsedMin)) * 10) / 10,
      namesPerHour: Math.round((names60 / Math.min(60, elapsedMin)) * 60),
      totalJobs: w.totalJobs,
      totalNamed: w.totalNamed,
      totalSourced: w.totalSourced,
      health: w.health,
      videosPerHour: Math.round((videos60 / Math.min(60, elapsedMin)) * 60),
      totalVideos: w.totalVideos,
      lastVideoClaimSec: w.lastVideoClaimAt ? Math.round((now - w.lastVideoClaimAt) / 1000) : null,
    });
  }
  workers.sort((a, b) => Number(b.online) - Number(a.online) || b.namesPerHour - a.namesPerHour || b.totalNamed - a.totalNamed);
  // Fleet roll-up = the WORST status among online boxes (a single strained IP shouldn't read as "all good").
  const RANK = { unhealthy: 3, degraded: 2, healthy: 1, idle: 0 } as const;
  let worst: FleetStatus["health"] = "idle";
  for (const w of workers) {
    if (!w.online || !w.health) continue;
    if (RANK[w.health.status] > RANK[worst]) worst = w.health.status;
  }
  return {
    workers,
    online: workers.filter((w) => w.online).length,
    totalJobsPerMin: Math.round(workers.reduce((s, w) => s + w.jobsPerMin, 0) * 10) / 10,
    totalNamesPerHour: workers.reduce((s, w) => s + w.namesPerHour, 0),
    totalNamed: workers.reduce((s, w) => s + w.totalNamed, 0),
    health: worst,
    videoOnline: workers.filter((w) => w.lastVideoClaimSec !== null && w.lastVideoClaimSec < 300).length,
    totalVideosPerHour: workers.reduce((s, w) => s + w.videosPerHour, 0),
    totalVideos: workers.reduce((s, w) => s + w.totalVideos, 0),
    lastVideoClaimSec: workers.reduce<number | null>(
      (best, w) => (w.lastVideoClaimSec === null ? best : best === null ? w.lastVideoClaimSec : Math.min(best, w.lastVideoClaimSec)),
      null,
    ),
  };
}
