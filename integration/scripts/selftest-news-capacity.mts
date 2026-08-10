/* How many curatable companies can the NEWS arm actually produce per sweep?
 * Free ($0, keyless), so this is safe to re-run. Retarget:
 *   SEGMENTS="a,b,c" WINDOW_DAYS=30 npx tsx scripts/selftest-news-capacity.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { discoverFromNews } = await import("../lib/signals/watch/newsDiscover");
import { companyKey } from "../lib/inmarket/jobFeed";

const SEGMENTS = (process.env.SEGMENTS || [
  "supply chain software", "logistics technology", "warehouse automation", "freight technology",
  "third party logistics", "cold chain logistics", "last mile delivery",
  "fleet management software", "industrial automation", "packaging manufacturing",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const SIGNALS = (process.env.NEWS_SIGNALS || "funding_round,exec_hire,office_expansion,acquisition,product_launch")
  .split(",").map((s) => s.trim()) as never[];
const WINDOW = Number(process.env.WINDOW_DAYS || 30);

let headlines = 0, named = 0, leads = 0;
const distinct = new Set<string>();
const bySignal = new Map<string, number>();
const t0 = Date.now();

for (const segment of SEGMENTS) {
  const r = await discoverFromNews({ segment, signals: SIGNALS, windowDays: WINDOW, limit: 40, timeboxMs: 60_000 });
  headlines += r.headlines; named += r.named; leads += r.leads.length;
  for (const l of r.leads) {
    distinct.add(companyKey(l.company || ""));
    const s = String((l as { signalType?: string }).signalType || "?");
    bySignal.set(s, (bySignal.get(s) || 0) + 1);
  }
  console.log(
    `${String(r.leads.length).padStart(3)} leads  ${String(r.named).padStart(3)}/${String(r.headlines).padStart(3)} named  ` +
    `${r.warnings.length ? "WARN " + r.warnings.join("; ") + "  " : ""}${segment}`
  );
}

console.log(`\n=== NEWS CAPACITY (${WINDOW}-day window, ${SEGMENTS.length} segments) ===`);
console.log(JSON.stringify({
  headlinesSeen: headlines,
  headlinesNamed: named,
  namedPct: headlines ? +((named / headlines) * 100).toFixed(1) : 0,
  leads,
  distinctCompanies: distinct.size,
  leadsPerSegment: +(leads / SEGMENTS.length).toFixed(1),
  bySignal: Object.fromEntries([...bySignal].sort((a, b) => b[1] - a[1])),
  elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  segmentsNeededFor200: distinct.size ? Math.ceil(200 / (distinct.size / SEGMENTS.length)) : null,
}, null, 2));
