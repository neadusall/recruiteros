/**
 * MPC variant bank CLI. The hourly /api/sending/cron drives the weekly refresh in prod; this is
 * the operator's manual handle for the same code path.
 *
 *   npx tsx scripts/mpc-variant-bank.mts            refresh if stale/incomplete, then print status
 *   npx tsx scripts/mpc-variant-bank.mts --force    regenerate every template now
 *   npx tsx scripts/mpc-variant-bank.mts --status   print status only (no generation, no key needed)
 *   npx tsx scripts/mpc-variant-bank.mts --show N   also print N sample variants per template
 *
 * Needs ANTHROPIC_API_KEY to generate. Writes <ROS_DATA_DIR|/data|.data>/mpc-variant-bank.json.
 */
import { refreshVariantBank, bankStatus, loadBank, bankKey } from "../lib/bd/mpc/variantBank";
import { MPC_TEMPLATES } from "../lib/bd/mpc/templates";

const args = process.argv.slice(2);
const force = args.includes("--force");
const statusOnly = args.includes("--status");
const showIdx = args.indexOf("--show");
const showN = showIdx >= 0 ? Math.max(1, Number(args[showIdx + 1]) || 2) : 0;

async function main() {
  if (!statusOnly) {
    const report = await refreshVariantBank({ force });
    if (report.skipped) console.log(`refresh: skipped (${report.skipped})`);
    else {
      console.log(`refresh: ${report.refreshed} templates regenerated, ${report.kept} variants kept, ${report.rejected} rejected by the gate, model ${report.model}`);
      for (const t of report.templates) {
        if (t.error) console.log(`  ${t.id}: ERROR ${t.error}`);
        else if (t.kept < 4) console.log(`  ${t.id}: only ${t.kept} kept (${t.rejected} rejected) - will retry next tick`);
      }
    }
  }

  const s = await bankStatus();
  console.log(`bank: ${s.path}`);
  console.log(`coverage: ${s.covered}/${s.templates} templates, ${s.variants} variants total, model ${s.model ?? "n/a"}, oldest ${s.oldest ?? "n/a"}`);
  if (s.covered < s.templates) {
    const bank = await loadBank();
    const missing = MPC_TEMPLATES.filter((t) => !bank?.entries[bankKey(t.body)]?.variants?.length).map((t) => t.id);
    console.log(`missing: ${missing.join(", ")}`);
  }

  if (showN) {
    const bank = await loadBank();
    for (const t of MPC_TEMPLATES) {
      const e = bank?.entries[bankKey(t.body)];
      if (!e) continue;
      console.log(`\n== ${t.id} (${e.variants.length} variants) ==`);
      for (const v of e.variants.slice(0, showN)) console.log(`  - ${v.split("\n")[0]}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
