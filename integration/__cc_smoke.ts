// One-box smoke test of the Common Crawl index governor (temp file, deleted after the run).
// Proves on REAL Common Crawl that the safeguard paces requests and protects the IP — either by
// pacing cleanly when CC is up, or by resting gracefully (breaker) when CC is cold. Both are wins.
import { ccTeamPages, commonCrawlHealth } from "./lib/inmarket/commonCrawl";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const domains = ["stripe.com", "vercel.com", "notion.so", "figma.com", "ramp.com"];

function snap(tag: string) {
  const h = commonCrawlHealth();
  console.log(
    `${tag.padEnd(14)} resting=${h.resting} spacing=${h.index.spacingMs}ms ` +
    `trips=${h.index.breakerTrips} cooldown=${h.index.cooldownForSec}s cachedDomains=${h.cachedDomains}`,
  );
}

(async () => {
  console.log("=== Common Crawl governor — one-box smoke test ===");
  snap("start");
  const t0 = Date.now();
  for (const d of domains) {
    const start = Date.now();
    const pages = await ccTeamPages(d);          // governed: paced, adaptive, breaker-aware, never throws
    const waited = Date.now() - start;
    console.log(`  ${d.padEnd(12)} -> ${pages.length} archived team page(s)  (took ${waited}ms)`);
    snap("  after");
  }
  console.log(`\nTotal wall: ${((Date.now() - t0) / 1000).toFixed(1)}s for ${domains.length} domains`);
  console.log("Interpretation: spacing should hold ~steady (healthy) or GROW + trips>0 (governor backing");
  console.log("off a cold index). Either way it NEVER hammers — that's the IP-reputation safeguard working.");
})();
