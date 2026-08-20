/**
 * Reoon verdict contract — behavior suite.
 * Run: npx tsx lib/inmarket/reoon.test.ts   (exits non-zero on failure)
 *
 * Guards the reading that the 8/19 incident got wrong: a catch-all acceptance is NEVER a
 * plain "valid" verdict, an unknown is never a verdict at all, and the verifier's own status
 * word always travels with the result so a bounce can be traced back to what it said.
 * Mirrors tools/test-verify.mjs (the host-side belt reads the same payloads the same way).
 */

import { ok, strictEqual } from "node:assert";
import { interpretReoonVerdict } from "./reoon";

let passed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error((e as Error).stack || e); process.exitCode = 1; }
}

test("safe -> valid, with the status word attached", () => {
  const v = interpretReoonVerdict({ status: "safe" });
  strictEqual(v.valid, true); strictEqual(v.catchAll, false); strictEqual(v.status, "safe");
});
test("catch-all is flagged catchAll even when marked safe (never collapses into a plain valid)", () => {
  for (const payload of [{ status: "safe", is_catch_all: true }, { status: "catch_all" }, { status: "accept-all", is_safe_to_send: true }]) {
    const v = interpretReoonVerdict(payload);
    strictEqual(v.catchAll, true, JSON.stringify(payload));
    ok(v.valid !== true || v.catchAll, "a catch-all can only be 'valid' together with catchAll:true");
  }
});
test("hard negatives win over everything", () => {
  strictEqual(interpretReoonVerdict({ status: "invalid" }).valid, false);
  strictEqual(interpretReoonVerdict({ status: "safe", is_disposable: true }).valid, false);
  strictEqual(interpretReoonVerdict({ status: "safe", is_deliverable: false }).valid, false);
  strictEqual(interpretReoonVerdict({ status: "spamtrap", is_catch_all: true }).valid, false);
});
test("unknown / empty / malformed are inconclusive (null), never a verdict", () => {
  strictEqual(interpretReoonVerdict({ status: "unknown" }).valid, null);
  strictEqual(interpretReoonVerdict({}).valid, null);
  strictEqual(interpretReoonVerdict(null).valid, null);
  strictEqual(interpretReoonVerdict("safe" as unknown).valid, null);
});
test("role accounts are excluded from 1:1 BD even when deliverable", () => {
  strictEqual(interpretReoonVerdict({ status: "safe", is_role_account: true }).valid, false);
});
test("status words are normalised for forensics", () => {
  strictEqual(interpretReoonVerdict({ status: "Catch All" }).status, "catch_all");
  strictEqual(interpretReoonVerdict({ result: "Safe" }).status, "safe");
});

console.log("\n" + passed + " passed");
