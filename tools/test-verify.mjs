// Tests for the pre-send verification belt. Plain node: node tools/test-verify.mjs
// Guards the contract the 8/19 incident broke: a catch-all or an unknown verdict is NEVER "proven",
// a row without a verifier's word is never trusted, and stale / contradicted proofs are re-checked.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretVerdict, verdictOfStatus, proofOf, isProvenStatus, loadVerifyCache, saveVerifyCache, verifyMany } from "./verify.mjs";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error(e && e.stack || e); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error(e && e.stack || e); process.exitCode = 1; }
}

const DAY = 86_400_000;
const now = Date.parse("2026-08-20T12:00:00Z");

test("only the verifier's positive status word proves a mailbox", () => {
  assert.equal(interpretVerdict({ status: "safe" }).verdict, "proven");
  assert.equal(interpretVerdict({ status: "valid" }).verdict, "proven");
  // flags alone never prove: free providers accept mail for users that do not exist
  assert.equal(interpretVerdict({ is_safe_to_send: true, is_deliverable: true }).verdict, "inconclusive");
  assert.equal(interpretVerdict({ status: "unknown" }).verdict, "inconclusive");
  assert.equal(interpretVerdict(null).verdict, "inconclusive");
});
test("catch-all is its own verdict even when the payload says safe (the 8/19 bug)", () => {
  assert.equal(interpretVerdict({ status: "safe", is_catch_all: true }).verdict, "catch_all");
  assert.equal(interpretVerdict({ status: "catch_all" }).verdict, "catch_all");
  assert.equal(interpretVerdict({ status: "accept-all", is_safe_to_send: true }).verdict, "catch_all");
});
test("dead verdicts: invalid / disabled / disposable / spamtrap / no MX", () => {
  for (const s of ["invalid", "disabled", "spamtrap", "undeliverable"]) assert.equal(interpretVerdict({ status: s }).verdict, "dead", s);
  assert.equal(interpretVerdict({ status: "safe", is_disposable: true }).verdict, "dead");
  assert.equal(interpretVerdict({ status: "safe", mx_accepts_mail: false }).verdict, "dead");
  assert.equal(interpretVerdict({ status: "safe", is_deliverable: false }).verdict, "dead");
});
test("role accounts are not people", () => {
  assert.equal(interpretVerdict({ status: "safe", is_role_account: true }).verdict, "role");
  assert.equal(interpretVerdict({ status: "role_account" }).verdict, "role");
});
test("verdictOfStatus reads persisted status words the same way", () => {
  assert.equal(verdictOfStatus("safe"), "proven");
  assert.equal(verdictOfStatus("Catch All"), "catch_all");
  assert.equal(verdictOfStatus("invalid"), "dead");
  assert.equal(verdictOfStatus(""), "inconclusive");
  assert.equal(verdictOfStatus("unknown"), "inconclusive");
  assert.ok(isProvenStatus("SAFE")); assert.ok(!isProvenStatus("catch_all"));
});

const cacheEmpty = { version: 1, entries: {} };
const row = (over = {}) => ({ likelyEmail: "a.b@acme.com", emailValidated: true, ...over });

test("a validated flag with no verifier word is UNPROVEN (the pre-fix population)", () => {
  assert.equal(proofOf(row(), cacheEmpty, { now }).state, "unproven");
});
test("a fresh store verdict proves; an old one is stale", () => {
  const fresh = proofOf(row({ emailVerifyStatus: "safe", validatedAt: new Date(now - 2 * DAY).toISOString() }), cacheEmpty, { now });
  assert.equal(fresh.state, "proven"); assert.equal(fresh.via, "store");
  const old = proofOf(row({ emailVerifyStatus: "safe", validatedAt: new Date(now - 40 * DAY).toISOString() }), cacheEmpty, { now });
  assert.equal(old.state, "stale");
  // a status with no timestamp at all counts as ancient
  assert.equal(proofOf(row({ emailVerifyStatus: "safe" }), cacheEmpty, { now }).state, "stale");
});
test("store says invalid but the flag says validated: the verdict wins (dead)", () => {
  assert.equal(proofOf(row({ emailVerifyStatus: "invalid", validatedAt: new Date(now - DAY).toISOString() }), cacheEmpty, { now }).state, "dead");
  assert.equal(proofOf(row({ emailVerifyStatus: "catch_all", validatedAt: new Date(now - DAY).toISOString() }), cacheEmpty, { now }).state, "catch_all");
});
test("the freshest verdict wins across store and cache, in both directions", () => {
  const cache = { version: 1, entries: { "a.b@acme.com": { at: new Date(now - DAY).toISOString(), verdict: "dead", status: "invalid" } } };
  const r = row({ emailVerifyStatus: "safe", validatedAt: new Date(now - 5 * DAY).toISOString() });
  assert.equal(proofOf(r, cache, { now }).state, "dead");
  const cache2 = { version: 1, entries: { "a.b@acme.com": { at: new Date(now - 10 * DAY).toISOString(), verdict: "dead", status: "invalid" } } };
  const p2 = proofOf(r, cache2, { now });
  assert.equal(p2.state, "proven"); assert.equal(p2.via, "store");
  const cache3 = { version: 1, entries: { "a.b@acme.com": { at: new Date(now - DAY).toISOString(), verdict: "proven", status: "safe" } } };
  const p3 = proofOf(row(), cache3, { now });
  assert.equal(p3.state, "proven"); assert.equal(p3.via, "cache");
});
test("cache save prunes old entries and survives a round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "belt-"));
  const file = join(dir, "cache.json");
  const cache = { version: 1, entries: {
    "keep@x.com": { at: new Date(now - DAY).toISOString(), verdict: "proven", status: "safe" },
    "old@x.com": { at: new Date(now - 120 * DAY).toISOString(), verdict: "proven", status: "safe" },
  } };
  saveVerifyCache(cache, file, { now });
  const back = loadVerifyCache(file);
  assert.ok(back.entries["keep@x.com"]); assert.ok(!back.entries["old@x.com"]);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).updatedAt);
});
await testAsync("verifyMany: transport errors are held (not cached as verdicts), payloads interpreted", async () => {
  const fakeFetch = async (url) => {
    const email = decodeURIComponent(new URL(url).searchParams.get("email"));
    if (email === "boom@x.com") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    if (email === "http@x.com") return { ok: false, status: 500 };
    return { ok: true, json: async () => (email === "ca@x.com" ? { status: "safe", is_catch_all: true } : { status: "safe" }) };
  };
  const res = await verifyMany(["ok@x.com", "ca@x.com", "boom@x.com", "http@x.com", "OK@x.com"], { fetch: fakeFetch, key: "k" });
  assert.equal(res.get("ok@x.com").verdict, "proven");
  assert.equal(res.get("ca@x.com").verdict, "catch_all");
  assert.equal(res.get("boom@x.com").error, "timeout");
  assert.equal(res.get("http@x.com").error, "http_500");
  assert.equal(res.size, 4, "deduped case-insensitively");
});

console.log("\n" + passed + " passed");
