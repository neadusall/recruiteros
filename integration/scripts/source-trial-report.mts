/*
 * Hire Signals (job feed) vs News signals, head to head on reply rate.
 *
 *   npx tsx scripts/source-trial-report.mts [--from 2026-08-10] [--to 2026-08-24] [--min 200]
 *
 * Reads the live curation store, so run it on the box (or with ROS_DATA_DIR / DATABASE_URL
 * pointed at prod data). Prints the funnel per arm and a verdict that refuses to name a
 * winner the sample cannot support.
 */
import { allCurated } from "../lib/inmarket/curation";
import { compareArms, ARMS, ARM_LABEL, requiredSendsPerArm } from "../lib/signals/watch/sourceTrial";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const report = compareArms(await allCurated(), {
  from: arg("from"),
  to: arg("to"),
  minSendsPerArm: arg("min") ? Number(arg("min")) : undefined,
});

const window = report.from || report.to ? ` ${report.from ?? "start"} to ${report.to ?? "now"}` : " all time";
console.log(`\nDISCOVERY SOURCE TRIAL${window}`);
console.log("=".repeat(78));

const rows = ARMS.map((a) => report.arms[a]);
const cols: Array<[string, (f: typeof rows[0]) => string | number]> = [
  ["companies", (f) => f.companies],
  ["prospects", (f) => f.prospects],
  ["contactable", (f) => f.contactable],
  ["sent", (f) => f.sent],
  ["opened", (f) => f.opened],
  ["replied", (f) => f.replied],
  ["reply %", (f) => f.replyRatePct],
  ["open %", (f) => f.openRatePct],
  ["bounce %", (f) => f.bounceRatePct],
  ["replies/100 co", (f) => f.repliesPerHundredCompanies],
];

console.log(`A = ${ARM_LABEL.jobs}\nB = ${ARM_LABEL.news}\n`);
console.log(`${"metric".padEnd(20)}${"A · Hire Signals".padStart(20)}${"B · News".padStart(20)}`);
console.log("-".repeat(60));
for (const [label, get] of cols) {
  console.log(`${label.padEnd(20)}${String(get(rows[0])).padStart(20)}${String(get(rows[1])).padStart(20)}`);
}

console.log("\nVERDICT: " + report.verdict.toUpperCase());
console.log(report.readout);

if (report.warnings.length) {
  console.log("\nWARNINGS");
  for (const w of report.warnings) console.log(`  - ${w}`);
}

console.log("\nWHAT IT WOULD TAKE (sends per arm, 80% power, p<0.05, 3.5% baseline)");
for (const [label, target] of [["detect 3.5% -> 4.5%", 0.045], ["detect 3.5% -> 5.0%", 0.05], ["detect 3.5% -> 7.0%", 0.07]] as Array<[string, number]>) {
  console.log(`  ${label.padEnd(22)} ${requiredSendsPerArm(0.035, target).toLocaleString()}`);
}
console.log(`  smallest difference this sample could resolve: ${Number.isFinite(report.detectableLiftPp) ? `${report.detectableLiftPp} points` : "n/a, an arm has no sends"}`);
