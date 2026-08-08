/* Is the job feed's emptiness query-specific, or is the feed flaky?
 * Repeats the SAME queries N times. Query-specific => a query is always 0 or always >0.
 * Flaky => the same query flips between runs. Run: npx tsx scripts/selftest-jobfeed-flake.mts */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { fetchJobFeedLeads } = await import("../lib/inmarket/jobFeed");

const QUERIES = ["software engineer", "sales director", "warehouse manager", "VP of Operations"];
const RUNS = Number(process.env.RUNS || 4);
const grid = new Map<string, number[]>();

for (let i = 0; i < RUNS; i++) {
  for (const q of QUERIES) {
    const leads = await fetchJobFeedLeads({ query: q, limit: 10 });
    if (!grid.has(q)) grid.set(q, []);
    grid.get(q)!.push(leads.length);
  }
}

console.log(`\nquery                    ${Array.from({ length: RUNS }, (_, i) => "run" + (i + 1)).join("  ")}   verdict`);
for (const [q, runs] of grid) {
  const nonZero = runs.filter((n) => n > 0).length;
  const verdict = nonZero === 0 ? "ALWAYS EMPTY"
    : nonZero === RUNS ? "always returns"
    : `FLAKY (${nonZero}/${RUNS} returned)`;
  console.log(`${q.padEnd(24)} ${runs.map((n) => String(n).padStart(4)).join("  ")}   ${verdict}`);
}
const all = [...grid.values()].flat();
console.log(`\nOverall: ${all.filter((n) => n > 0).length}/${all.length} calls returned jobs ` +
  `(${((all.filter((n) => n > 0).length / all.length) * 100).toFixed(0)}% hit rate)`);
