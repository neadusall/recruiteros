/* Live check against real Google News RSS. Network-dependent, so it is a manual
 * spot-check, not part of the deterministic suite. Run: npx tsx scripts/live-news-check.mts */
import { discoverFromNews } from "../lib/signals/watch/newsDiscover";

for (const segment of ["supply chain software", "freight technology"]) {
  const r = await discoverFromNews({ segment, signals: ["funding_round", "exec_hire"], windowDays: 30, limit: 12 });
  console.log(`\n=== ${segment} ===`);
  console.log(`queries=${r.queries} headlines=${r.headlines} named=${r.named} leads=${r.leads.length} warnings=${JSON.stringify(r.warnings)}`);
  for (const l of r.leads) {
    console.log(`  [${l.score}] ${l.company}  (${l.signalType})`);
    console.log(`        reason: ${l.reason}`);
    console.log(`        roles : ${(l.roles ?? []).join(", ")}`);
  }
}
