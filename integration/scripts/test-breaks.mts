/**
 * Suite for the break layer (2026-07-31).
 * Run: npx tsx scripts/test-breaks.mts   (from integration/)
 *
 * The rule this pins: nothing fails silently. A request that never lands, a
 * server that errors, a crash in the app itself — each one has to put a coded,
 * plain-English notice in front of the person and file the technical side where
 * it can be looked up. Half of that lives in the store (run for real here) and
 * half in the client (asserted on the shipped source, same style as the other
 * client-side guardrails).
 */
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "breaks-"));
delete process.env.DATABASE_URL;

const { recordBreak, listBreaks } = await import("../lib/breaks.js");

const here = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(here, "..", "..", "assets", "js", "command.js"), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
}

/* --- the store ----------------------------------------------------------- */

const filed = await recordBreak(
  { code: "ROS-SRV", where: "JD Sourcing", screen: "jdsourcing", path: "/sourcing", status: 500, detail: "boom", agent: "test" },
  { workspaceId: "ws_a", userEmail: "ariel@example.com" },
);
check("a break is filed with the code the person was shown", filed.code === "ROS-SRV");
check("identity comes from the session, never the client",
  filed.userEmail === "ariel@example.com" && filed.workspaceId === "ws_a");

await recordBreak({ code: "ROS-NET", path: "/candidates", status: 0 }, { workspaceId: "ws_b", userEmail: "other@example.com" });
const mine = await listBreaks(50, "ws_a");
check("a workspace sees only its own breaks", mine.length === 1 && mine[0].workspaceId === "ws_a", `${mine.length} rows`);
check("the owner view spans the box", (await listBreaks(50)).length === 2);
check("newest first", (await listBreaks(50))[0].code === "ROS-NET");

const junk = await recordBreak(
  { code: "x".repeat(500), detail: "y".repeat(5000), status: "not-a-number" },
  { workspaceId: "ws_a", userEmail: "ariel@example.com" },
);
check("oversized client input is clipped, never trusted", junk.code.length <= 24 && junk.detail.length <= 600);
check("a nonsense status becomes 0 rather than NaN", junk.status === 0, String(junk.status));

/* --- the client ----------------------------------------------------------- */

check("a read that fails reports instead of throwing a bare 0",
  /if \(!r\.ok \|\| d === null\) \{[\s\S]{0,400}reportBreak\(/.test(client));
check("a request that never lands reports too (the deploy case)",
  /reportBreak\("ROS-NET"[\s\S]{0,120}fetch failed/.test(client));
check("a server error on a write reports even when the call site says nothing",
  /if \(!r\.ok\) \{[\s\S]{0,200}breakCodeFor\(r\.status\)[\s\S]{0,120}reportBreak\(/.test(client));
check("a crash in the app itself reports", /addEventListener\("error"[\s\S]{0,200}ROS-APP/.test(client));
check("an unhandled rejection reports", /addEventListener\("unhandledrejection"/.test(client));
check("every notice carries a quotable code", /quote this when you report it/.test(client));
check("the technical detail is copyable, not on screen",
  /data-break-copy/.test(client) && /clipboard\.writeText/.test(client));
check("a break stops any progress bar still running",
  /activeProgressFail\("Stopped"\)/.test(client));
check("one outage is one notice, not fifty", /breakSeen\[key\][\s\S]{0,80}60000/.test(client));
check("filing a break can never itself break the screen",
  /keepalive: true[\s\S]{0,120}catch\(function \(\) \{ \}\)/.test(client));
check("a denial is named as a permission problem, not a crash",
  /"ROS-DENY": "Your account is not allowed/.test(client));

console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
