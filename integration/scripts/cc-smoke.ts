/**
 * RecruitersOS · In-Market · Common Crawl governor smoke test
 *
 * Run this ON A WORKER/MAIN BOX to confirm the index governor is healthy FROM THAT BOX'S IP before
 * (or after) it starts curating — and to eyeball the real per-IP behaviour the index gives you:
 *
 *   npx tsx scripts/cc-smoke.ts
 *
 * Reading the output:
 *   • pages>0 on at least some domains + spacing steady at ~2000ms + trips=0  → HEALTHY: this IP gets
 *     clean index access. Good to curate. The named/hour you see at steady state is this box's B1.
 *   • everything 0 pages, ~10s/request, trips climbing → this IP is COLD with the index (throttled or
 *     a global CC slowdown). The governor degrades gracefully (rests, never hammers); naming falls back
 *     to the other free sources. If it persists, this IP needs to rest before it'll pull from CC.
 *
 * This NEVER touches the main server and scrapes only a handful of domains — safe to run anytime.
 */

import { ccTeamPages, commonCrawlHealth } from "../lib/inmarket/commonCrawl";

const DOMAINS = ["stripe.com", "vercel.com", "notion.so", "figma.com", "ramp.com"];

function snap(tag: string): void {
  const h = commonCrawlHealth();
  console.log(
    `${tag.padEnd(14)} resting=${h.resting} spacing=${h.index.spacingMs}ms ` +
    `trips=${h.index.breakerTrips} cooldown=${h.index.cooldownForSec}s cachedDomains=${h.cachedDomains}`,
  );
}

(async () => {
  console.log("=== Common Crawl governor smoke test (from this box's IP) ===");
  snap("start");
  const t0 = Date.now();
  let hits = 0;
  for (const d of DOMAINS) {
    const start = Date.now();
    const pages = await ccTeamPages(d);          // governed: paced, adaptive, breaker-aware, never throws
    if (pages.length) hits++;
    console.log(`  ${d.padEnd(12)} -> ${pages.length} archived team page(s)  (${Date.now() - start}ms)`);
    snap("  after");
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${hits}/${DOMAINS.length} domains returned archived pages in ${wall}s.`);
  console.log(hits ? "→ HEALTHY: this IP has clean index access." : "→ COLD: this IP isn't getting index results right now (governor rested it safely).");
})();
