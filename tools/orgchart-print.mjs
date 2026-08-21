/**
 * Print the targeting org chart as a readable matrix.
 *
 *   node tools/orgchart-print.mjs                 # every function
 *   node tools/orgchart-print.mjs Finance Sales   # just these
 *
 * This is the recruiter-facing view of tools/orgchart.mjs: for any posted job, which seat gets the
 * cold email and the voice drop. Same module the sender uses, so the sheet cannot drift from the
 * behaviour.
 */

import { describe, TIERS, CHAIN, LEVEL_NAME } from "./orgchart.mjs";

// Parse flags first so a flag's VALUE is never mistaken for a function name: `--json out.json`
// used to leave "out.json" in the positional list, which asked describe() for a function that does
// not exist and threw before anything was written.
const argv = process.argv.slice(2);
let jsonOut = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--json") { jsonOut = argv[++i] || "/data/snap_mpc_orgchart_v1.json"; continue; }
  if (argv[i].startsWith("-")) continue;
  positional.push(argv[i]);
}
const rows = describe(positional.length ? positional : null);

const byFn = new Map();
for (const r of rows) {
  if (!byFn.has(r.functionGroup)) byFn.set(r.functionGroup, []);
  byFn.get(r.functionGroup).push(r);
}

const pad = (s, n) => String(s).padEnd(n);
const RULE = "─".repeat(108);

console.log("\nRECRUITERSOS · WHO GETS THE EMAIL AND THE VOICE DROP");
console.log(RULE);
console.log("The buyer is read from THREE things: the function of the posted job, how senior that");
console.log("job is, and how many layers the company has. The rule is always the same:");
console.log("");
console.log("    target = the lowest person who can still buy, in the req's own function,");
console.log("             capped by how many layers actually exist at that company size.");
console.log("");
for (const t of TIERS) console.log(`  ${pad(t.label, 22)} ${t.what}`);
console.log(RULE);

for (const [fn, list] of byFn) {
  console.log(`\n\n■ ${fn.toUpperCase()}`);
  const chain = CHAIN[fn] || {};
  console.log(`  chain of command:  ${["manager", "director", "vp", "clevel"].map((k) => (chain[k] || ["-"])[0]).join("  →  ")}`);
  console.log("  " + "-".repeat(104));
  console.log("  " + pad("IF THE POSTED JOB IS", 22) + pad("AND THE COMPANY IS", 25) + pad("SENIORITY BAND", 28) + "THEN CONTACT");
  console.log("  " + "-".repeat(104));
  for (const tier of TIERS) {
    const inTier = list.filter((r) => r.tier === tier.key);
    for (const r of inTier) {
      // The BAND is the part that actually changes between tiers, so it gets its own column: the
      // first two titles look identical across tiers and hide the fact that the ceiling moved.
      const band = r.buyerLevels.length === 1
        ? r.buyerLevels[0]
        : `${r.buyerLevels[0]} → ${r.buyerLevels[r.buyerLevels.length - 1]}`;
      const who = r.buyerTitles.slice(0, 2).join(" / ") + (r.ownerBuys ? ", or the owner" : "");
      console.log("  " + pad(`${r.reqLevelName}-level`, 22) + pad(tier.label, 25) + pad(band + (r.ownerBuys ? " + owner" : ""), 28) + who);
    }
    console.log("");
  }
}

console.log(RULE);
console.log("Never contacted for a normal req: anyone below Manager (they do not buy), a leader of a");
console.log("DIFFERENT function (a CTO does not buy an accounting hire), and above 250 employees the");
console.log("CEO, unless the req itself is a C-suite search or the owner search came back empty.");
console.log(RULE + "\n");

/* ── Publish for the portal ───────────────────────────────────────────────────────────────────
 * `--json <path>` writes the matrix as a snapshot the UI reads, rather than the UI re-implementing
 * the model in TypeScript and drifting from it. Same rule as the capacity and supply ledgers: the
 * module that ENFORCES the targeting is the one that publishes it.
 * ------------------------------------------------------------------------------------------ */
if (jsonOut) {
  const out = jsonOut;
  const fs = await import("node:fs");
  const payload = {
    version: 1,
    at: new Date().toISOString(),
    tiers: TIERS.map((t) => ({ key: t.key, label: t.label, what: t.what, ownerBuys: !!t.ownerBuys })),
    functions: [...byFn.keys()],
    rows,
  };
  fs.writeFileSync(out + ".tmp", JSON.stringify(payload));
  fs.renameSync(out + ".tmp", out);
  console.log(`org chart published -> ${out} (${rows.length} rows across ${byFn.size} functions)`);
}
