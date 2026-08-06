/**
 * Regression tripwire for the WHOLE-PRESS crash net (2026-08-06).
 * Run from integration/:  npx tsx scripts/test-sourcing-chainnet.mts
 *
 * One press of Initiate Search is three requests — write the brief (only when the JD
 * box is empty), analyze it into a profile, then search — and until this change only
 * the third one ran behind a durable checkpoint. That left the two AI steps in front of
 * it with no net AND invisible to the deploy gate, which decides whether to hold a
 * container swap by counting checkpoints. On 2026-08-06 at 19:30 UTC a swap landed 26
 * seconds into Analyze: Caddy answered 502, no checkpoint existed, and the run existed
 * nowhere afterwards. The recruiter watched the bar stop at 67%.
 *
 * These checks pin the guarantee in both directions: every step of the press is inside
 * the net, and the net can never quietly outlive a press the server refused (which
 * would have the queue run and BILL for the search the refusal prevented).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { recoveryHeld } from "../lib/sourcing/nightQueue";

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, "..", "app", "api", "sourcing", "route.ts"), "utf8");
const queue = readFileSync(join(here, "..", "lib", "sourcing", "nightQueue.ts"), "utf8");
const client = readFileSync(join(here, "..", "..", "assets", "js", "command.js"), "utf8");
const mirror = readFileSync(join(here, "..", "public", "assets", "js", "command.js"), "utf8");

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}`);
  if (!ok) failed++;
}

/* --- the browser arms the net on the first press, not on the search ------- */

const handler = client.slice(client.indexOf('showProgress("Finding candidates"') - 4000,
                             client.indexOf("/* ---- Crash-recovery watch ----"));
const tokenAt = handler.indexOf('var recoveryToken = "rcv_"');
const draftAt = handler.indexOf('action: "draft"');
const planAt = handler.indexOf('action: "plan"');
const runAt = handler.indexOf('action: "run"');
check("the chain still runs brief -> analyze -> search",
  draftAt > -1 && planAt > -1 && runAt > -1 && draftAt < planAt && planAt < runAt);
check("the recovery token is minted BEFORE the first request of the press",
  tokenAt > -1 && tokenAt < draftAt);
check("the brief request carries the net", /netFields\(\{ action: "draft"/.test(handler));
check("the analyze request carries the net", /netFields\(\{ action: "plan"/.test(handler));
check("the search request carries the SAME token (the server adopts, never arms twice)",
  /action: "run", recoveryToken: recoveryToken/.test(handler));
check("chain:true marks the one-press flow (a standalone Analyze must not arm a paid search)",
  /chain: true/.test(handler));
check("the dials ride along from the first request, not just the search",
  /cap: cap, minFit: minFit, freshOnly: fresh/.test(handler.slice(0, planAt)));
check("a dead connection at the brief step hands the tab to the recovery watch",
  /deadEnd\(r\)\) throw \{ recover:[\s\S]{0,200}Writing the brief/.test(handler));
check("a dead connection at the analyze step does too (THE 2026-08-06 hole)",
  /deadEnd\(r\)\) throw \{ recover:[\s\S]{0,240}stage: "Analyze"/.test(handler));
check("and the search step still does",
  /if \(deadEnd\(r\)\) \{[\s\S]{0,400}recover: \{ token: recoveryToken/.test(handler));
check("the served mirror carries the same code (integration/public is what prod serves)",
  mirror.includes("netFields(") && mirror.includes("chain: true"));

/* --- the server arms once per press and completes it as it goes ----------- */

check("one helper arms the chain's checkpoint", /async function armChainCheckpoint\(/.test(route));
check("it only arms for the one-press flow", /b\?\.chain !== true\) return ""/.test(route));
check("a later step of the same press finds the existing checkpoint instead of arming another",
  /findRecoveryCheckpoint\(ws, token\)[\s\S]{0,300}return existing\.id/.test(route));
const planBranch = route.slice(route.indexOf('if (action === "plan")'), route.indexOf('if (action === "engines")'));
check("analyze arms the net before it starts thinking",
  planBranch.indexOf("armChainCheckpoint") > -1 &&
  planBranch.indexOf("armChainCheckpoint") < planBranch.indexOf("await planSourcing"));
check("analyze hands its profile to the checkpoint (a recovery re-uses it, never re-derives)",
  /attachNightIcp\(ws, chainId, plan\.icp\)/.test(planBranch));
check("an analyze failure parks the reason instead of leaving a live net behind an answered request",
  /catch \(err\)[\s\S]{0,300}failNightItem\(ws, chainId,/.test(planBranch));
const draftBranch = route.slice(route.indexOf('if (action === "draft")'), route.indexOf('if (action === "refine")'));
check("the brief step arms the net too",
  draftBranch.indexOf("armChainCheckpoint") > -1 &&
  draftBranch.indexOf("armChainCheckpoint") < draftBranch.indexOf("draftJobDescription"));
check("the written brief is saved onto the checkpoint (a recovery searches the same text)",
  /updateRecoveryCheckpoint\(ws, chainId, \{ jd \}\)/.test(draftBranch));
const runBranch = route.slice(route.indexOf('if (action === "run")'), route.indexOf('if (action === "salesNav")'));
check("the search adopts the standing checkpoint and moves it onto the long fuse",
  /updateRecoveryCheckpoint\(ws, held\.id, \{[\s\S]{0,700}\}, "search"\)/.test(runBranch));
check("a search started without a standing checkpoint still arms one (older tabs keep their net)",
  /if \(recoveryToken && !recoveryId\) \{[\s\S]{0,200}addNightItem\(ws, \{/.test(runBranch));

/* --- a refused press must never leave a net standing --------------------- */

check("there is one way to stand a chain's net down with a reason on it",
  /async function stopChainCheckpoint\(/.test(route) && /failNightItem\(ws, held\.id, reason\)/.test(route));
check("the readiness refusal stands it down (else the queue runs the very search the gate blocked)",
  /const gate = await toolGate\(ws, "jdsourcing"\);[\s\S]{0,400}stopChainCheckpoint\(ws, b,[\s\S]{0,200}return gate;/.test(runBranch));
check("a search with no JD stands it down too",
  /if \(!b\?\.jd\) \{[\s\S]{0,300}stopChainCheckpoint\(ws, b,[\s\S]{0,200}missing_jd/.test(runBranch));

/* --- a recovered press finishes the whole chain, brief included ----------- */

const searchStage = queue.slice(queue.indexOf('if (item.stage === "search")'));
const briefAt = searchStage.indexOf("draftJobDescription(");
const jdBailAt = searchStage.indexOf("no job description on the queued search");
check("the queue writes the brief when the press died before one existed",
  briefAt > -1 && jdBailAt > -1 && briefAt < jdBailAt);
check("and a brief it cannot write stops the item honestly rather than searching blind",
  /the job brief could not be written/.test(queue));
check("the checkpoint carries the brief spec for exactly that case", /brief\?: \{ title\?: string/.test(queue));

/* --- the deploy gate now sees the whole press ---------------------------- */

check("a checkpoint knows which request holds it", /phase\?: "chain" \| "search"/.test(queue));
check("the chain phase has its own, much shorter fuse", /const CHAIN_DEADMAN_MS/.test(queue));

const armed = (agoMs: number, phase?: "chain" | "search") =>
  ({ recovery: { token: "t", bootId: "b", armedAt: new Date(Date.now() - agoMs).toISOString(), phase } });
const MIN = 60 * 1000;
check("a press in its brief/analyze steps counts as a live search (the deploy holds)",
  recoveryHeld(armed(30 * 1000, "chain"), "b", Date.now()) === true);
check("a tab that vanished mid-chain is taken over in minutes, not in three quarters of an hour",
  recoveryHeld(armed(6 * MIN, "chain"), "b", Date.now()) === false);
check("a real search in flight keeps the long fuse (never taken over underneath itself)",
  recoveryHeld(armed(20 * MIN, "search"), "b", Date.now()) === true);
check("an unmarked checkpoint (older row, mid-upgrade) keeps the long fuse",
  recoveryHeld(armed(20 * MIN), "b", Date.now()) === true);
check("a dead process's checkpoint is recoverable whatever the phase",
  recoveryHeld(armed(30 * 1000, "chain"), "other-boot", Date.now()) === false);
check("the adopting search re-stamps the clock, so the short fuse cannot follow it",
  /if \(phase\) item\.recovery\.phase = phase;[\s\S]{0,300}armedAt = nowIso\(\)/.test(queue));

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log("\nall checks passed");
