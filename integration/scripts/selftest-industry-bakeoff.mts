/* Which industries should this desk actually work?
 *
 * Measures, per candidate industry, what the FREE news arm can reach: how many distinct
 * companies a single sweep discovers, how cleanly the extractor names them, and which
 * signals dominate. Funding + exec-hire are the two that convert (a raise means budget
 * and a board expecting headcount against it); product_launch and acquisition are softer.
 *
 * HONEST LIMIT: this measures BD-reachable SUPPLY — companies we can find and pitch. It
 * does NOT measure fill difficulty or fee quality, which need job-posting volume from the
 * job feed. Read it as "where can we get in front of buyers cheaply", not "what is easy
 * to fill". $0 and keyless, so re-run it freely.
 *
 * Run: npx tsx scripts/selftest-industry-bakeoff.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { discoverFromNews } = await import("../lib/signals/watch/newsDiscover");
import { companyKey } from "../lib/inmarket/jobFeed";

const INDUSTRIES = (process.env.INDUSTRIES || [
  "behavioral health", "home health care", "skilled nursing facilities", "medical device manufacturing",
  "accounting firms", "wealth management", "commercial insurance", "construction contractors",
  "civil engineering firms", "industrial manufacturing", "food and beverage manufacturing",
  "building products distribution", "third party logistics", "cybersecurity",
  "veterinary practices", "dental service organizations", "HVAC services",
  "environmental services", "utilities and energy services", "specialty pharmacy",
].join("|")).split("|").map((s) => s.trim()).filter(Boolean);

const WINDOW = Number(process.env.WINDOW_DAYS || 30);
const HOT = new Set(["funding_round", "exec_hire"]);   // the two that convert

interface Row {
  industry: string; companies: number; headlines: number; named: number; namedPct: number;
  hotPct: number; topSignal: string;
}
const rows: Row[] = [];

for (const industry of INDUSTRIES) {
  try {
    const r = await discoverFromNews({
      segment: industry,
      signals: ["funding_round", "exec_hire", "office_expansion", "acquisition", "product_launch"] as never,
      windowDays: WINDOW, limit: 40, timeboxMs: 45_000,
    });
    const distinct = new Set(r.leads.map((l) => companyKey(l.company || "")));
    const counts = new Map<string, number>();
    for (const l of r.leads) {
      const s = String((l as { signalType?: string }).signalType || "?");
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    const hot = r.leads.filter((l) => HOT.has(String((l as { signalType?: string }).signalType))).length;
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    rows.push({
      industry, companies: distinct.size, headlines: r.headlines, named: r.named,
      namedPct: r.headlines ? +((r.named / r.headlines) * 100).toFixed(0) : 0,
      hotPct: r.leads.length ? +((hot / r.leads.length) * 100).toFixed(0) : 0,
      topSignal: top ? `${top[0]} (${top[1]})` : "-",
    });
    console.log(`  done: ${industry.padEnd(34)} ${distinct.size} companies`);
  } catch (e) {
    console.log(`  FAIL: ${industry} — ${(e as Error).message}`);
  }
}

rows.sort((a, b) => (b.companies * (b.hotPct / 100 + 0.5)) - (a.companies * (a.hotPct / 100 + 0.5)));

console.log(`\n=== INDUSTRY BAKE-OFF (free news arm, ${WINDOW}-day window) ===`);
console.log(`${"industry".padEnd(34)} ${"cos".padStart(4)} ${"named%".padStart(7)} ${"hot%".padStart(5)}  top signal`);
console.log("-".repeat(86));
for (const r of rows) {
  console.log(`${r.industry.padEnd(34)} ${String(r.companies).padStart(4)} ${String(r.namedPct).padStart(6)}% ${String(r.hotPct).padStart(4)}%  ${r.topSignal}`);
}
const tot = rows.reduce((s, r) => s + r.companies, 0);
console.log(`\ntotal distinct-per-industry companies in one sweep: ${tot}`);
console.log(`hot% = share of leads that are funding or exec-hire (the two that convert).`);
console.log(`Ranked by companies weighted by hot% — reach x quality, not raw volume.`);
