/**
 * Regression tripwire for the LinkedIn-URL search crash net (2026-07-31).
 * Run: npx tsx scripts/test-salesnav-recovery.mts   (from integration/)
 *
 * A JD Sourcing search started from a pasted LinkedIn URL runs for minutes and
 * writes nothing until it finishes. Before this net existed, an auto-deploy
 * recreating the app container mid-pull ate the whole search: the progress bar
 * stalled and no list was ever saved (a Lume search was lost exactly this way).
 * The JD-text search already ran behind a durable checkpoint; this suite pins
 * the same guarantees for the LinkedIn-URL path, source-shape style (same
 * approach as test-sourcing-promote / test-sourcing-nightqueue).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, "..", "app", "api", "sourcing", "route.ts"), "utf8");
const queue = readFileSync(join(here, "..", "lib", "sourcing", "nightQueue.ts"), "utf8");
const apply = readFileSync(join(here, "..", "lib", "sourcing", "salesNavApply.ts"), "utf8");
const client = readFileSync(join(here, "..", "..", "assets", "js", "command.js"), "utf8");

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}`);
  if (!ok) failed++;
}

/* --- the route arms the net before it starts, and stands it down after ---- */

const snavBranch = route.slice(route.indexOf('if (action === "salesNav")'));
const armAt = snavBranch.indexOf("addNightItem");
const pullAt = snavBranch.indexOf("runSalesNavSourcing");
check("salesNav arms a recovery checkpoint", armAt > -1);
check("the checkpoint is armed BEFORE the pull starts (no uncovered first seconds)",
  armAt > -1 && pullAt > -1 && armAt < pullAt);
check("the checkpoint carries the pasted URL, so a recovery can re-run the same search",
  /salesNav:\s*\{[\s\S]{0,200}url,/.test(snavBranch));
check("the checkpoint carries the destination list, so a recovery cannot fork a second one",
  /typedName:/.test(snavBranch) && /targetRunId:/.test(snavBranch));
check("the net stands down in a finally (a SAVED search's checkpoint is removed)",
  /\}\s*finally\s*\{[\s\S]{0,700}removeNightItem\(ws,\s*snRecoveryId\)/.test(snavBranch));
check("a refusal PARKS the checkpoint as a visible stopped item instead of deleting it (2026-08-05: a recruiter who navigated away mid-search got no list, no row, no error)",
  /snPark\(detail\)[\s\S]{0,200}empty_salesnav_run/.test(snavBranch) && /failNightItem/.test(snavBranch));
check("a crash parks it too, and parking clears the recovery marker so the queue never re-runs a search the server answered on purpose",
  /catch \(err\)[\s\S]{0,300}snPark\(/.test(snavBranch) && /recovery = undefined/.test(queue));

/* --- one shared lander, so a recovery never spawns a duplicate list ------- */

check("the route lands its result through the shared lander",
  /applySalesNavResult\(/.test(snavBranch));
check("the queue lands a recovered search through the SAME lander",
  /applySalesNavResult\(/.test(queue));
check("the lander resolves an existing list case-insensitively by name",
  /r\.name\.trim\(\)\.toLowerCase\(\)\s*===\s*typedName\.toLowerCase\(\)/.test(apply));
check("the lander merges with the Combine-lists dedupe (never a duplicate person)",
  /mergeSourcingRuns\(\[target,\s*incoming\]\)/.test(apply));

/* --- the queue actually re-runs a killed LinkedIn-URL search -------------- */

const searchStage = queue.slice(queue.indexOf('if (item.stage === "search")'));
const snavAt = searchStage.indexOf("item.salesNav?.url");
const jdBailAt = searchStage.indexOf("no job description on the queued search");
check("the search stage handles a LinkedIn-URL item", snavAt > -1);
check("it does so BEFORE the JD bail (a URL search carries no JD and must not error out)",
  snavAt > -1 && jdBailAt > -1 && snavAt < jdBailAt);
check("the recovered pull runs inside withWorkspaceCreds (Setup-pasted keys apply)",
  /withWorkspaceCreds\(ws,\s*\(\)\s*=>\s*runSalesNavSourcing\(/.test(queue));
check("a recovered search hands enrichment on to the normal chain",
  /applied\.run\.id[\s\S]{0,120}item\.stage\s*=\s*"kold"/.test(queue));
check("a recovery lands by URL too, so it cannot fork a list the dead request already saved",
  /preferUrlMatch:\s*true/.test(queue) && /opts\.preferUrlMatch/.test(apply));

/* --- attempts are bounded, so a deploy storm cannot loop a paid search ---- */

const attemptAt = searchStage.indexOf("item.searchAttempts =");
const attemptSaveAt = searchStage.indexOf("await save()");
check("each search attempt is stamped on the item", attemptAt > -1);
check("the stamp is persisted BEFORE the work (an attempt killed mid-pull still counts)",
  attemptAt > -1 && attemptSaveAt > attemptAt && attemptSaveAt < searchStage.indexOf("runSalesNavSourcing"));
check("a search interrupted too many times stops instead of re-running forever",
  /searchAttempts\s*>\s*MAX_SEARCH_ATTEMPTS[\s\S]{0,200}finish\(item,\s*"error"/.test(searchStage));

/* --- the tab hands a dead connection over instead of re-paying ------------ */

const snavFn = client.slice(client.indexOf("function runSalesNav()"), client.indexOf("function numVal("));
check("the client sends a recovery token with the search", /recoveryToken:\s*snavToken/.test(snavFn));
check("a dead connection is watched, not reported as a failure",
  /r\.status === 0[\s\S]{0,400}snavRecover\(\)/.test(snavFn));
check("the search POST is NOT blindly retried (that would re-pay for the whole search)",
  !/sendPatient\("\/sourcing", "POST", payload\)/.test(snavFn));
check("the recovery watch is the shared one the JD search uses",
  /watchRecovery\(\{\s*token:\s*snavToken/.test(snavFn));

console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
