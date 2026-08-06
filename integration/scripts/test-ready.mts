/**
 * Suite for the tool-readiness safeguard (2026-08-06).
 * Run: npx tsx scripts/test-ready.mts   (from integration/)
 *
 * The rule this pins: a tool that cannot work says so BEFORE the work starts,
 * and refuses the work if it is started anyway — instead of running and coming
 * back with nothing, which reads as a real empty result and sends the person
 * round the loop again.
 *
 * Half of that lives on the server (run for real here against a temp store) and
 * half in the client (asserted on the shipped source, same style as the break
 * layer's suite next door). The last block is a drift guard: the registry and
 * the app's own route table must agree, or the strip silently stops appearing.
 */
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "ready-"));
delete process.env.DATABASE_URL;
// Isolation ON: the workspace under test is a customer, so the operator's own
// env keys must never stand in for a connection it does not have.
process.env.HOUSE_WORKSPACE_ID = "ws_house";
delete process.env.ROS_READY_GATE;

const { toolReadiness, toolGate, allToolReadiness } = await import("../lib/ready/index.js");
const { saveKeys, markTested, clearKeys } = await import("../lib/connected/credentials.js");

const here = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(here, "..", "..", "assets", "js", "command.js"), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
}

const WS = "ws_customer";

/* --- the three states ----------------------------------------------------- */

const cold = await toolReadiness(WS, "vetting");
check("a tool with nothing connected is blocked", cold?.state === "blocked" && cold?.ready === false, cold?.state);
check("the message names the connection, not the env var",
  Boolean(cold && /Telnyx/i.test(cold.message) && !/[A-Z]{3,}_[A-Z_]+/.test(cold.message)), cold?.message);
check("the message says what stops working",
  Boolean(cold && /candidates are never called/.test(cold.message)), cold?.message);
check("blocked lists every missing connection", (cold?.blocked.length ?? 0) === 2, `${cold?.blocked.length}`);

await saveKeys(WS, "telnyx", { TELNYX_API_KEY: "x" }, ["TELNYX_API_KEY"]);
await saveKeys(WS, "ai", { ANTHROPIC_API_KEY: "x" }, ["ANTHROPIC_API_KEY"]);
const saved = await toolReadiness(WS, "vetting");
check("keys saved but untested is unverified, and work may still start",
  saved?.state === "unverified" && saved?.ready === true, saved?.state);
check("the unverified message warns it can still stop part-way",
  Boolean(saved && /never been tested/.test(saved.message)), saved?.message);

await markTested(WS, "telnyx", true);
await markTested(WS, "ai", true);
const green = await toolReadiness(WS, "vetting");
check("tested connections read ready with nothing to say",
  green?.state === "ready" && green?.message === "", `${green?.state} "${green?.message}"`);

// Learned live on 2026-08-06: the first audit called OS Text broken for two
// accounts that were texting fine, because sending lives in the engine and not
// in these tiles. It must stay out until the check can ask the engine itself.
check("OS Text is deliberately not gated on the integration tiles",
  (await toolReadiness(WS, "ostext" as never)) === null);

/* --- keys on the box beat a stale tile ------------------------------------ */

// The operator's own workspace reads the house env. A row that was once
// disconnected stays red there for ever, and reading colour instead of keys is
// what made the first live audit call the operator's own LinkedIn "not
// connected" while the automation was running fine.
process.env.UNIPILE_DSN = "api-test.unipile.com:1234";
process.env.UNIPILE_API_KEY = "test-token";
await clearKeys("ws_house", "unipile");            // disconnect -> stored red
const houseLi = await toolReadiness("ws_house", "linkedin");
check("a stale red tile does not block a tool whose keys are on the box",
  houseLi?.state === "unverified" && houseLi?.ready === true, houseLi?.state);
delete process.env.UNIPILE_DSN;
delete process.env.UNIPILE_API_KEY;
const goneLi = await toolReadiness("ws_house", "linkedin");
check("with the keys actually gone, the same tool is blocked",
  goneLi?.state === "blocked", goneLi?.state);

/* --- shapes the registry has to get right --------------------------------- */

// helps[] must never block: a tool that works with less still works.
await saveKeys(WS, "rapidapi", { RAPIDAPI_KEY: "x" }, ["RAPIDAPI_KEY"]);
await markTested(WS, "rapidapi", true);
const signals = await toolReadiness(WS, "inmarket");
check("an optional helper missing degrades but never blocks",
  signals?.state === "ready" && signals.degraded.length > 0, `${signals?.state}/${signals?.degraded.length}`);

// anyOf[]: interchangeable providers, one is enough.
const drops = await toolReadiness(WS, "voicedrops");
check("interchangeable providers all missing blocks the tool",
  drops?.state === "blocked" && drops.blocked.some((d) => d.id === "elevenlabs"), drops?.state);
await saveKeys(WS, "cartesia", { CARTESIA_API_KEY: "x" }, ["CARTESIA_API_KEY"]);
await markTested(WS, "cartesia", true);
const drops2 = await toolReadiness(WS, "voicedrops");
check("one connected provider satisfies the alternatives", drops2?.ready === true, drops2?.state);

check("an unknown tool is not invented", (await toolReadiness(WS, "nope" as never)) === null);
check("every registered tool answers", (await allToolReadiness(WS)).length >= 10);

/* --- the API gate --------------------------------------------------------- */

const gate = await toolGate(WS, "jdsourcing");
check("a blocked tool is refused, not answered with an empty 200", gate?.status === 409, `${gate?.status}`);
const gateBody = gate ? await gate.json() : null;
check("the refusal names itself so the client can tell it from an error",
  gateBody?.error === "tool_not_connected" && Boolean(gateBody?.message), JSON.stringify(gateBody).slice(0, 120));
check("the refusal carries the missing connections by label",
  Array.isArray(gateBody?.missing) && gateBody.missing.length > 0 && Boolean(gateBody.missing[0].label));
check("a ready tool is not gated", (await toolGate(WS, "calls")) === null);

process.env.ROS_READY_GATE = "off";
check("the kill switch stands the gate down without a code change",
  (await toolGate(WS, "jdsourcing")) === null);
delete process.env.ROS_READY_GATE;

/* --- the client half ------------------------------------------------------ */

check("the strip is drawn on every navigation, before the tool renders",
  /renderReadyGate\(key\);\s*\n\s*r\.render\(view\)/.test(client));
check("a 409 becomes the setup notice instead of an error banner",
  (client.match(/r\.status !== 409 \|\| !readySetupNotice\(/g) || []).length === 2);
check("readiness never paints a break notice of its own (raw fetch, not api())",
  /function loadReadiness\([\s\S]{0,400}fetch\(API \+ "\/ready"/.test(client));
check("a refused run stops the progress bar rather than leaving it spinning",
  /readySetupNotice[\s\S]{0,2000}activeProgressFail\("Not connected"\)/.test(client));
check("the setup notice is filed for the owner under its own code",
  /code: "ROS-SETUP"/.test(client));
check("recruiters are told it is not their mistake",
  /not something you did/.test(client));

/* --- drift guard: registry vs the app's route table ----------------------- */

const registryKeys = (await allToolReadiness(WS)).map((t) => t.tool);
const wired = new Set(
  Array.from(client.matchAll(/tool: "([a-z]+)"/g)).map((m) => m[1]),
);
const unwired = registryKeys.filter((k) => !wired.has(k));
check("every tool in the registry is wired to its screen", unwired.length === 0, unwired.join(", "));
const stray = Array.from(wired).filter((k) => !registryKeys.includes(k as never));
check("no screen points at a tool the registry does not know", stray.length === 0, stray.join(", "));

console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
