/**
 * Regression tripwire: the JD search result never depends on the browser tab
 * (2026-08-05). Run: npx tsx scripts/test-sourcing-serversave.mts (from integration/)
 *
 * Before this, the live "run" action returned the finished candidates to the
 * browser and the BROWSER saved them with a second request: a tab closed or
 * reloaded mid-search meant the server finished the paid search, handed the
 * result to nobody, removed its crash-net checkpoint, and the run evaporated
 * with no list, no queue row, and no error anywhere. Same style as
 * test-salesnav-recovery: source-shape checks, so a refactor that quietly
 * reverts any of these rules fails loudly.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, "..", "app", "api", "sourcing", "route.ts"), "utf8");
const store = readFileSync(join(here, "..", "lib", "sourcing", "store.ts"), "utf8");
const client = readFileSync(join(here, "..", "..", "assets", "js", "command.js"), "utf8");

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}`);
  if (!ok) failed++;
}

/* --- the run action saves its own result ---------------------------------- */

const runBranch = route.slice(
  route.indexOf('if (action === "run")'),
  route.indexOf('if (action === "salesNav")'),
);
const discoveryAt = runBranch.indexOf("runDiscovery");
const saveAt = runBranch.indexOf("saveSourcingRun");
const answerAt = runBranch.indexOf("return ok({ icp, queries");
check("the run action saves the finished list SERVER-SIDE (a dead tab loses nothing)",
  saveAt > -1 && discoveryAt > -1 && saveAt > discoveryAt);
check("it saves BEFORE answering, and the answer carries the saved run for the client to adopt",
  answerAt > -1 && saveAt < answerAt && /run:\s*savedRun/.test(runBranch));
check("the saved run is stamped serverSavedAt (the double-save guard's marker)",
  /serverSavedAt:\s*nowIso\(\)/.test(runBranch));
check("a store hiccup during the server save falls back to the client save instead of a 500",
  /catch[\s\S]{0,200}server-side save failed, leaving it to the client/.test(runBranch));
check("the checkpoint stands down IMMEDIATELY after a durable save (not only in the finally)",
  /serverSavedAt:\s*nowIso\(\)[\s\S]{0,700}removeNightItem/.test(runBranch));

/* --- refusals and crashes stay visible when nobody is watching ------------ */

check("an empty run PARKS the checkpoint as a stopped item carrying the engine's reason",
  /failNightItem\(ws,\s*id,[\s\S]{0,200}stopReason/.test(runBranch));
check("a crash parks it too (the reason survives on the queue card)",
  /catch \(err\)[\s\S]{0,400}failNightItem/.test(runBranch));

/* --- an old cached client cannot create a duplicate list ------------------ */

const saveBranch = route.slice(
  route.indexOf('if (action === "save")'),
  route.indexOf('if (action === "promote")'),
);
check("a brand-new save matching a just-server-saved run returns THAT run (no duplicate list)",
  /serverSavedAt[\s\S]{0,400}return ok\(\{ run: twin \}\)/.test(saveBranch));
check("the guard requires the same name, same row count, and a recent server save",
  /r\.name\.trim\(\)\.toLowerCase\(\)/.test(saveBranch) &&
  /r\.candidates\.length ===/.test(saveBranch) &&
  /15 \* 60_000/.test(saveBranch));
check("the store persists the serverSavedAt stamp",
  /serverSavedAt:\s*input\.serverSavedAt/.test(store));

/* --- the updated client adopts the server's save -------------------------- */

check("the client remembers the run the server saved",
  /state\.serverRun\s*=\s*\(r\.data && r\.data\.run\)/.test(client));
check("and adopts it in the save step instead of saving a duplicate",
  /state\.serverRun && state\.serverRun\.id[\s\S]{0,200}savedId = state\.serverRun\.id/.test(client));

if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
