/**
 * RecruitersOS · In-Market · Distributed RESEARCH WORKER
 *
 * Runs on each cheap worker box (its own IP / IPv6 /64 = its own free scraping quota). In a loop it:
 *   1. CLAIMs a batch of (company, role) jobs from the main server,
 *   2. researches each decision-maker with THIS box's IP (Common Crawl + team page + news + GitHub),
 *   3. SUBMITs the named results back to the main server, which merges them into the curated DB.
 *
 * This is how the free model scales toward 5K/day: N workers ≈ N× the per-IP-rate-limited throughput.
 *
 * Run (on the worker box, repo checked out + `npm install`):
 *   WORKER_MAIN_URL=https://recruitersos.co \
 *   WORKER_TOKEN=<same as main INMARKET_WORKER_TOKEN> \
 *   npx tsx integration/scripts/research-worker.ts
 *
 * Strong + sustainable: every network call is timed out; claim/submit failures back off exponentially
 * and retry forever (a worker NEVER crashes out of the loop); research errors per company are skipped.
 */

import { hostname } from "os";
import { createServer } from "http";
import { resolveDecisionMaker } from "../lib/inmarket/decisionMaker";
import { buildCuratedRow, type CuratedProspect } from "../lib/inmarket/curation";
import { commonCrawlHealth } from "../lib/inmarket/commonCrawl";
import { searchHealth } from "../lib/inmarket/searchHealth";
import { secEdgarHealth } from "../lib/inmarket/secEdgar";

interface Job { lead: { company: string; domain?: string; industry?: string; signalType?: string; reason?: string; score?: number; employeeCount?: number; roleDetails?: Array<{ title: string }>; roles?: string[]; sourceUrl?: string }; role: string }

const MAIN = (process.env.WORKER_MAIN_URL || "").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN || "";
const WORKER_ID = (process.env.WORKER_ID || hostname() || "worker").replace(/[^\w.\-]/g, "").slice(0, 60);
const BATCH = Math.min(Math.max(Number(process.env.WORKER_BATCH) || 120, 1), 1000);
const CONCURRENCY = Math.min(Math.max(Number(process.env.WORKER_CONCURRENCY) || 8, 1), 24);
const IDLE_SLEEP_MS = Math.max(Number(process.env.WORKER_IDLE_SLEEP_MS) || 30_000, 5_000);
const HTTP_TIMEOUT_MS = 30_000;
const HEALTH_PORT = Math.min(65535, Math.max(0, Number(process.env.WORKER_HEALTH_PORT) || 0)); // 0 = off (opt-in)
const HEALTH_TOKEN = process.env.WORKER_HEALTH_TOKEN || ""; // optional bearer to protect the endpoint

if (!MAIN || !TOKEN) {
  console.error("[worker] set WORKER_MAIN_URL and WORKER_TOKEN. Exiting.");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* This box's live health (loop stats + Common Crawl + search sources)  */
/* ------------------------------------------------------------------ */

const startedAt = Date.now();
const stats = {
  cycles: 0, claimedTotal: 0, researchedTotal: 0, namedTotal: 0, submittedTotal: 0,
  lastCycleAt: 0, lastClaimed: 0, lastResearched: 0, lastNamed: 0,
  consecutiveFails: 0, lastError: "", lastErrorAt: 0,
};

/** Full health snapshot for the /health endpoint. Reads the in-memory source-health surfaces. */
function buildHealth() {
  const now = Date.now();
  const uptimeSec = Math.round((now - startedAt) / 1000);
  const cc = commonCrawlHealth();
  const sh = searchHealth();
  const se = secEdgarHealth();
  // Reasons this box is anything less than fully healthy — the same signals the monitor thresholds watch.
  const reasons: string[] = [];
  if (cc.resting) reasons.push(`common-crawl resting ${cc.restingForSec}s`);
  if (cc.index.breakerTrips >= 2) reasons.push(`common-crawl breaker trips=${cc.index.breakerTrips}`);
  if (cc.index.spacingMs >= 16_000) reasons.push(`common-crawl index spacing maxed (${cc.index.spacingMs}ms)`);
  if (cc.index.cooldownForSec > 0) reasons.push(`common-crawl cooldown ${cc.index.cooldownForSec}s`);
  if (sh.status === "throttled") reasons.push("search engines throttled");
  if (se.resting) reasons.push(`sec-edgar resting ${se.restingForSec}s`);
  if (stats.consecutiveFails >= 3) reasons.push(`main-server calls failing (${stats.consecutiveFails})`);
  // Unhealthy = the box can't sustain its job right now; degraded = strain but still producing.
  const unhealthy = cc.resting || stats.consecutiveFails >= 5 || (cc.index.breakerTrips >= 2 && sh.status === "throttled");
  const status: "healthy" | "degraded" | "unhealthy" = unhealthy ? "unhealthy" : reasons.length ? "degraded" : "healthy";
  const namedPerHour = uptimeSec > 30 ? Math.round(stats.namedTotal / (uptimeSec / 3600)) : 0;
  return {
    worker: WORKER_ID,
    status,
    reasons,
    uptimeSec,
    main: MAIN,
    loop: {
      cycles: stats.cycles,
      claimedTotal: stats.claimedTotal,
      researchedTotal: stats.researchedTotal,
      namedTotal: stats.namedTotal,
      submittedTotal: stats.submittedTotal,
      namedPerHour,
      lastCycleSecAgo: stats.lastCycleAt ? Math.round((now - stats.lastCycleAt) / 1000) : null,
      lastClaimed: stats.lastClaimed,
      lastResearched: stats.lastResearched,
      lastNamed: stats.lastNamed,
      consecutiveFails: stats.consecutiveFails,
      lastError: stats.lastError || undefined,
      lastErrorSecAgo: stats.lastErrorAt ? Math.round((now - stats.lastErrorAt) / 1000) : null,
    },
    commonCrawl: cc,
    search: { status: sh.status, engines: sh.engines },
    secEdgar: se,
  };
}

/** Compact digest the box piggybacks to the main on each call, so the fleet view aggregates all boxes. */
function healthDigest() {
  const h = buildHealth();
  return {
    status: h.status,
    reasons: h.reasons,
    cc: {
      resting: h.commonCrawl.resting,
      breakerTrips: h.commonCrawl.index.breakerTrips,
      spacingMs: h.commonCrawl.index.spacingMs,
      cooldownSec: h.commonCrawl.index.cooldownForSec,
    },
    search: h.search.status,
    namedPerHour: h.loop.namedPerHour,
  };
}

/** Opt-in local HTTP health endpoint. Returns 503 when unhealthy so a monitor can alert on the code alone. */
function startHealthServer(): void {
  if (!HEALTH_PORT) return;
  try {
    const srv = createServer((req, res) => {
      if (HEALTH_TOKEN && (req.headers.authorization || "") !== `Bearer ${HEALTH_TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      const h = buildHealth();
      res.writeHead(h.status === "unhealthy" ? 503 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(h, null, 2));
    });
    srv.on("error", (e) => console.error(`[worker] health server: ${(e as Error).message}`)); // never crash the loop
    srv.listen(HEALTH_PORT, () => console.log(`[worker] ${ts()} health endpoint on :${HEALTH_PORT}${HEALTH_TOKEN ? " (token-protected)" : ""}`));
  } catch (e) {
    console.error(`[worker] health server failed to start: ${(e as Error).message}`);
  }
}

async function callMain(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${MAIN}/api/in-market/worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, worker: WORKER_ID, ...payload }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${action} -> HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Research a batch of jobs concurrently with THIS box's IP. Per-job errors are skipped, never fatal. */
async function research(jobs: Job[]): Promise<CuratedProspect[]> {
  const rows: CuratedProspect[] = [];
  const nowIso = ts();
  let cursor = 0;
  async function w(): Promise<void> {
    while (cursor < jobs.length) {
      const { lead, role } = jobs[cursor++];
      if (!lead?.company || !role) continue;
      try {
        const dm = await resolveDecisionMaker(lead.company, role, {
          domain: lead.domain, companySize: lead.employeeCount, sourceUrl: lead.sourceUrl,
        });
        rows.push(buildCuratedRow(lead, role, dm, nowIso));
      } catch { /* skip this company; keep the batch going */ }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, w));
  return rows;
}

async function loop(): Promise<void> {
  startHealthServer();
  console.log(`[worker] ${ts()} started "${WORKER_ID}" → ${MAIN} (batch ${BATCH}, concurrency ${CONCURRENCY})`);
  for (;;) {
    try {
      // claim carries this box's health digest, so an idle box (no jobs) still heartbeats the fleet view.
      const claim = await callMain("claim", { limit: BATCH, health: healthDigest() });
      const jobs = (Array.isArray(claim.jobs) ? claim.jobs : []) as Job[];
      if (!jobs.length) { await sleep(IDLE_SLEEP_MS); continue; }

      const rows = await research(jobs);
      const named = rows.filter((r) => r.managerName).length;
      let added: unknown = "?";
      if (rows.length) {
        const sub = await callMain("submit", { rows, health: healthDigest() });
        added = sub.newlyAdded ?? "?";
      }
      // Update live stats for the health surface.
      stats.cycles++;
      stats.lastCycleAt = Date.now();
      stats.lastClaimed = jobs.length; stats.claimedTotal += jobs.length;
      stats.lastResearched = rows.length; stats.researchedTotal += rows.length;
      stats.lastNamed = named; stats.namedTotal += named;
      if (typeof added === "number") stats.submittedTotal += added;
      stats.consecutiveFails = 0;
      console.log(`[worker] ${ts()} claimed ${jobs.length} → researched ${rows.length} (named ${named}) → submitted (new ${added})`);
    } catch (e) {
      stats.consecutiveFails++;
      stats.lastError = (e as Error).message;
      stats.lastErrorAt = Date.now();
      const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(stats.consecutiveFails, 5));
      console.error(`[worker] ${ts()} error: ${(e as Error).message} — backoff ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }
}

loop().catch((e) => { console.error(`[worker] fatal: ${(e as Error)?.message}`); process.exit(1); });
