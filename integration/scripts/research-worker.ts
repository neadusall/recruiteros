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

import { resolveDecisionMaker } from "../lib/inmarket/decisionMaker";
import { buildCuratedRow, type CuratedProspect } from "../lib/inmarket/curation";

interface Job { lead: { company: string; domain?: string; industry?: string; signalType?: string; reason?: string; score?: number; employeeCount?: number; roleDetails?: Array<{ title: string }>; roles?: string[]; sourceUrl?: string }; role: string }

const MAIN = (process.env.WORKER_MAIN_URL || "").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN || "";
const BATCH = Math.min(Math.max(Number(process.env.WORKER_BATCH) || 120, 1), 1000);
const CONCURRENCY = Math.min(Math.max(Number(process.env.WORKER_CONCURRENCY) || 8, 1), 24);
const IDLE_SLEEP_MS = Math.max(Number(process.env.WORKER_IDLE_SLEEP_MS) || 30_000, 5_000);
const HTTP_TIMEOUT_MS = 30_000;

if (!MAIN || !TOKEN) {
  console.error("[worker] set WORKER_MAIN_URL and WORKER_TOKEN. Exiting.");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();

async function callMain(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${MAIN}/api/in-market/worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
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
  console.log(`[worker] ${ts()} started → ${MAIN} (batch ${BATCH}, concurrency ${CONCURRENCY})`);
  let fails = 0;
  for (;;) {
    try {
      const claim = await callMain("claim", { limit: BATCH });
      const jobs = (Array.isArray(claim.jobs) ? claim.jobs : []) as Job[];
      if (!jobs.length) { await sleep(IDLE_SLEEP_MS); continue; }

      const rows = await research(jobs);
      let added: unknown = "?";
      if (rows.length) {
        const sub = await callMain("submit", { rows });
        added = sub.newlyAdded ?? "?";
      }
      const named = rows.filter((r) => r.managerName).length;
      console.log(`[worker] ${ts()} claimed ${jobs.length} → researched ${rows.length} (named ${named}) → submitted (new ${added})`);
      fails = 0;
    } catch (e) {
      fails++;
      const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(fails, 5));
      console.error(`[worker] ${ts()} error: ${(e as Error).message} — backoff ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }
}

loop().catch((e) => { console.error(`[worker] fatal: ${(e as Error)?.message}`); process.exit(1); });
