/**
 * RecruitersOS · In-Market · Worker FLEET telemetry
 *
 * In-memory, per-worker live metrics for the fleet view: who's online, jobs/min, names/hour, totals.
 * The worker route feeds this on every claim/submit; the curation_funnel read exposes it to the UI.
 * Single main process → an in-memory map is enough; it resets on redeploy (fine — it's live telemetry,
 * not the data of record). Bounded so a flood of worker ids can't grow it unbounded.
 */

interface Ev { at: number; jobs: number; named: number }
interface W { id: string; firstSeen: number; lastSeen: number; claims: number; totalJobs: number; totalNamed: number; ev: Ev[] }

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
    w = { id, firstSeen: now, lastSeen: now, claims: 0, totalJobs: 0, totalNamed: 0, ev: [] };
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

export interface FleetWorker {
  id: string;
  online: boolean;
  lastSeenSec: number;
  jobsPerMin: number;
  namesPerHour: number;
  totalJobs: number;
  totalNamed: number;
}
export interface FleetStatus {
  workers: FleetWorker[];
  online: number;
  totalJobsPerMin: number;
  totalNamesPerHour: number;
  totalNamed: number;
}

export function fleetStatus(): FleetStatus {
  const now = Date.now();
  const workers: FleetWorker[] = [];
  for (const w of fleet.values()) {
    const elapsedMin = Math.max(1 / 60, (now - w.firstSeen) / 60_000);
    const jobs5 = w.ev.filter((e) => e.at > now - 300_000).reduce((s, e) => s + e.jobs, 0);
    const names60 = w.ev.filter((e) => e.at > now - 3_600_000).reduce((s, e) => s + e.named, 0);
    workers.push({
      id: w.id,
      online: now - w.lastSeen < 120_000,                 // seen in the last 2 min
      lastSeenSec: Math.round((now - w.lastSeen) / 1000),
      jobsPerMin: Math.round((jobs5 / Math.min(5, elapsedMin)) * 10) / 10,
      namesPerHour: Math.round((names60 / Math.min(60, elapsedMin)) * 60),
      totalJobs: w.totalJobs,
      totalNamed: w.totalNamed,
    });
  }
  workers.sort((a, b) => Number(b.online) - Number(a.online) || b.namesPerHour - a.namesPerHour || b.totalNamed - a.totalNamed);
  return {
    workers,
    online: workers.filter((w) => w.online).length,
    totalJobsPerMin: Math.round(workers.reduce((s, w) => s + w.jobsPerMin, 0) * 10) / 10,
    totalNamesPerHour: workers.reduce((s, w) => s + w.namesPerHour, 0),
    totalNamed: workers.reduce((s, w) => s + w.totalNamed, 0),
  };
}
