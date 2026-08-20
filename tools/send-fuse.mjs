// RecruitersOS · MPC · send fuse CLI (evaluate / status / trip / clear). See fuse.mjs.
//
//   node send-fuse.mjs                 # evaluate against the latest ledgers + NDR sweep, write, notify on change
//   node send-fuse.mjs --status        # print the ledger
//   node send-fuse.mjs --trip "why"    # latch the fleet fuse by hand (scope: all cold sends, app lanes included)
//   node send-fuse.mjs --clear         # clear the fleet fuse (after a person has looked)
//   node send-fuse.mjs --release SRC   # release one source breaker early
//
// Runs in the tools container (mpc-monitor.sh before every send tick, mpc-ndr-sweep.sh after
// every sweep) and from the host via send-fuse.sh. Exit code 2 while the fleet fuse is tripped
// so shell callers can gate on it.
import { loadFuseLedger, writeFuseLedger, evaluateFuse, loadSentRows, loadNdr, ndrAgeHours, tripFleet, clearFleet, releaseSource, notifyOwner } from "./fuse.mjs";

const OUT = process.env.MPC_OUT_DIR || "/out";
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

function print(ledger) {
  const f = ledger.fleet || {};
  const w = ledger.window || {};
  console.log(`fleet fuse: ${f.tripped ? `TRIPPED since ${f.since} (${f.by}: ${f.reason})` : "armed"}${f.clearedAt ? ` | last cleared ${f.clearedAt} by ${f.clearedBy}` : ""}`);
  console.log(`window: ${w.available === false ? "bounce notices unavailable (sweep predates the fuse)" : `${w.bounces ?? "?"} bounces / ${w.sends ?? "?"} sends in ${w.windowH ?? 24}h = ${w.ratio == null ? "n/a" : (w.ratio * 100).toFixed(2) + "%"} (trip: >${(w.maxRatio ?? 0.05) * 100}% on ${w.minSends ?? 100}+ sends)`} | NDR data ${w.ndrAt || "missing"}`);
  const srcs = Object.entries(ledger.sources || {});
  if (!srcs.length) console.log("sources: no attributed sends yet");
  for (const [k, s] of srcs) console.log(`  source ${k.padEnd(20)} ${s.tier || ""} sent ${s.sent ?? 0} bounces ${s.bounces ?? 0}${s.ratio != null ? ` (${(s.ratio * 100).toFixed(1)}%)` : ""}${s.paused ? ` PAUSED until ${s.until} (${s.reason})` : ""}`);
  if (ledger.canary) console.log(`canary: ${ledger.canary.invalid}/${ledger.canary.sample} invalid at ${ledger.canary.at}${ledger.canary.tripped ? " TRIPPED" : ""}`);
  if (ledger.belt) console.log(`belt: ${JSON.stringify(ledger.belt)}`);
  for (const h of (ledger.history || []).slice(-5)) console.log(`  ${h.at} ${h.event} ${h.detail}`);
}

async function main() {
  let ledger = loadFuseLedger();
  if (flag("--status")) { print(ledger); process.exitCode = ledger.fleet.tripped ? 2 : 0; return; }
  if (flag("--trip")) {
    const why = val("--trip") || "manual trip";
    if (tripFleet(ledger, { by: "manual", reason: why, scope: "all" })) { writeFuseLedger(ledger); await notifyOwner([{ kind: "fleet_tripped", text: `FUSE TRIPPED BY HAND: ${why}. All cold sends (host lanes and app lanes) are stopped until cleared.` }]); console.log("fleet fuse tripped"); }
    else console.log("fleet fuse was already tripped");
    process.exitCode = 2; return;
  }
  if (flag("--clear")) {
    if (clearFleet(ledger, { by: process.env.USER || "owner" })) { writeFuseLedger(ledger); await notifyOwner([{ kind: "fleet_cleared", text: "FUSE CLEARED: cold sends resume on the next tick. Bounces seen before now no longer count toward a re-trip; a fresh spike trips it again." }]); console.log("fleet fuse cleared"); }
    else console.log("fleet fuse was not tripped");
    return;
  }
  if (flag("--release")) {
    const src = val("--release");
    if (releaseSource(ledger, src)) { writeFuseLedger(ledger); console.log(`source ${src} released`); } else console.log(`source ${src} is not paused`);
    return;
  }
  const ndr = loadNdr();
  const age = ndrAgeHours(ndr);
  const res = evaluateFuse({ ledger, sentRows: loadSentRows(OUT, 14), ndr });
  ledger = writeFuseLedger(res.ledger);
  for (const c of res.changes) console.log(`  ${c.text}`);
  if (age == null) console.log("note: no NDR sidecar; the fleet window cannot be measured (batch.mjs holds cold sends on missing/stale bounce data)");
  print(ledger);
  await notifyOwner(res.changes);
  process.exitCode = ledger.fleet.tripped ? 2 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
