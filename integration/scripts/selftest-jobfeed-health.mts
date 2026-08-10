/* Proves the job feed can tell an outage from a quiet market.
 * Run: npx tsx scripts/selftest-jobfeed-health.mts */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { fetchJobFeedLeads, jobFeedHealth } = await import("../lib/inmarket/jobFeed");

console.log("before:", JSON.stringify(jobFeedHealth()));
const QUERIES = (process.env.QUERIES || "nurse,software engineer,warehouse manager,sales director,controller,recruiter,accountant,project manager,truck driver,data analyst")
  .split(",").map((s) => s.trim()).filter(Boolean);
for (const query of QUERIES) {
  const leads = await fetchJobFeedLeads({ query, limit: 10 });
  const h = jobFeedHealth();
  console.log(`"${query}": leads=${leads.length} consecutiveEmpty=${h.consecutiveEmpty} suspectOutage=${h.suspectOutage}`);
}
console.log("\nFINAL:", JSON.stringify(jobFeedHealth(), null, 2));
