/**
 * MPC variant bank tests: the generation gate (pure), the storage/selection path, and the
 * send-path contract (variant renders clean through renderTouch + the render guard, and any
 * miss falls back to null so the deterministic copy sends).
 * Run: npx tsx scripts/test-variant-bank.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the bank on a temp data dir, and make sure no test can reach the network.
process.env.ROS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ros-variant-bank-"));
delete process.env.ANTHROPIC_API_KEY;

const { MPC_TEMPLATES, SIGN } = await import("../lib/bd/mpc/templates");
const { bankKey, tokensOf, splitSignOff, openingFp, variantViolations, variantRender, bankPath, bankStatus, resetBankCache } =
  await import("../lib/bd/mpc/variantBank");
const { humanizerEnabled } = await import("../lib/bd/mpc/humanizer");

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const done = () => { passed++; console.log(`ok   ${name}`); };
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(done).catch((e) => { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; });
    done();
  } catch (e) { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; }
}

/* ------------------------- pure helpers ------------------------- */

test("every MPC template ends with the shared sign-off and splits cleanly", () => {
  for (const t of MPC_TEMPLATES) {
    const { core, sign } = splitSignOff(t.body);
    assert.equal(sign, SIGN, `${t.id}: sign-off recognized`);
    assert.equal(core + sign, t.body, `${t.id}: lossless split`);
    assert.ok(!/\{\{\s*Your_Name\s*\}\}/i.test(core), `${t.id}: core carries no sign-off token`);
  }
});

test("every template core passes its own gate (except the allowed source spintax)", () => {
  for (const t of MPC_TEMPLATES) {
    const { core } = splitSignOff(t.body);
    const v = variantViolations(core, core).filter((x) => x !== "stray_brace");
    assert.deepEqual(v, [], `${t.id}: ${v.join(", ")}`);
  }
});

test("tokensOf extracts the lowercase token set", () => {
  const s = tokensOf("Hi {{First_Name}}, your {{Open_Role}} and {{ Open_Role }} again");
  assert.deepEqual([...s].sort(), ["first_name", "open_role"]);
});

test("bankKey is stable and distinguishes edited templates", () => {
  const a = MPC_TEMPLATES[0].body;
  assert.equal(bankKey(a), bankKey(a));
  assert.notEqual(bankKey(a), bankKey(a + " "));
});

const SRC = splitSignOff(MPC_TEMPLATES.find((t) => t.id === "direct-2")!.body).core;
const GOOD =
  "Hi {{First_Name}}, quick one. i was filling {{A_Job_Title}} role in {{Near_City}} when i met {{P_obj}}, " +
  "and {{P_subj}} maps to your {{Open_Role}} seat almost exactly. {{MH1}}, {{MH2}}. open to a short conversation?";

test("gate accepts a clean rewrite", () => {
  assert.deepEqual(variantViolations(SRC, GOOD), []);
});

test("gate rejects the machine tells and the fabrications", () => {
  const cases: Array<[string, string]> = [
    ["banned phrase", GOOD.replace("quick one.", "i wanted to reach out.")],
    ["em-dash", GOOD.replace("quick one.", "quick one — really.")],
    ["dropped token", GOOD.replace("{{MH2}}", "more of the same")],
    ["invented token", GOOD.replace("{{MH2}}", "{{Metric}}")],
    ["two questions", GOOD.replace("quick one.", "got a minute?")],
    ["invented number", GOOD.replace("quick one.", "142% to quota.")],
    ["link", GOOD.replace("quick one.", "see https://example.com.")],
    ["stray spintax", GOOD.replace("quick one.", "{quick|fast} one.")],
    ["runaway length", GOOD + " " + "and another thing entirely that keeps going. ".repeat(12)],
    ["collapsed", "Hi {{First_Name}}?"],
  ];
  for (const [name, cand] of cases) {
    assert.ok(variantViolations(SRC, cand).length > 0, `${name} must be rejected`);
  }
});

test("openingFp skips the greeting and normalizes tokens", () => {
  assert.equal(openingFp("Hi {{First_Name}}, quick one. i was filling"), openingFp("hey {{First_Name}}, quick one! i was FILLING"));
  assert.notEqual(openingFp(GOOD), openingFp(SRC));
});

test("humanizer is demoted: off unless explicitly forced", () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.MPC_HUMANIZER;
  assert.equal(humanizerEnabled(), false, "default off even with a key");
  process.env.MPC_HUMANIZER = "force";
  assert.equal(humanizerEnabled(), true, "force turns it on");
  process.env.MPC_HUMANIZER = "0";
  assert.equal(humanizerEnabled(), false);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MPC_HUMANIZER;
});

/* ------------------------- send path ------------------------- */

const TEMPLATE = MPC_TEMPLATES.find((t) => t.id === "direct-2")!;
const VARIANTS = [
  GOOD,
  "Hi {{First_Name}}, wrapped {{A_Job_Title}} search in {{Near_City}} and {{P_obj}} stuck with me. {{P_subj}} reads like your {{Open_Role}} seat: {{MH1}}, {{MH2}}. want an intro?",
  "Hi {{First_Name}}, while filling {{A_Job_Title}} role in {{Near_City}} i met {{P_obj}}. {{P_subj}} fits your {{Open_Role}} opening cleanly, {{MH1}} and {{MH2}}. should i send the profile over?",
  "Hi {{First_Name}}, {{P_subj}} came out of my last {{A_Job_Title}} search in {{Near_City}} and i kept thinking about your {{Open_Role}} seat. {{MH1}}, {{MH2}}, and i can vouch for {{P_obj}}. worth a look?",
].map((c) => c + SIGN);

const PROSPECT = {
  id: "pr_test_1",
  firstName: "Dana",
  company: "Acme Health",
  title: "Sales Manager",
  location: "Austin, TX",
  warmth: 10,
  mpcContext: {
    placedRole: "Account Executive",
    placementLocation: "Dallas, TX",
    industry: "healthcare",
    mustHaves: ["carried a full desk", "closed multi-site deals"],
    metric: "142% to quota",
    gender: "f" as const,
    yourName: "Jordan",
  },
} as any;

const TOUCH = { key: "t1", day: 0, channel: "email" as const, label: "MPC direct-2", subject: TEMPLATE.subject, body: TEMPLATE.body };

function writeBank(variants: string[]) {
  mkdirSync(process.env.ROS_DATA_DIR!, { recursive: true });
  writeFileSync(bankPath(), JSON.stringify({
    version: 1, model: "test", generatedAt: new Date().toISOString(),
    entries: { [bankKey(TEMPLATE.body)]: { templateId: TEMPLATE.id, source: TEMPLATE.body, variants, generatedAt: new Date().toISOString() } },
  }), "utf8");
  resetBankCache();
}

await test("variantRender swaps in a fully rendered, guard-clean variant body", async () => {
  writeBank(VARIANTS);
  const r = await variantRender(TOUCH, PROSPECT, 1);
  assert.ok(r, "a variant rendered");
  assert.ok(!/\{\{|\}\}|[{}|]/.test(r!.body), "no token or spintax remnants");
  assert.ok(r!.body.includes("Dana"), "first name merged");
  assert.ok(/she\b|her\b/i.test(r!.body), "pronouns resolved from the real candidate");
  assert.ok(r!.body.includes("Jordan"), "sign-off carried through");
  assert.ok(!/—|–/.test(r!.body), "no em/en dash");
});

await test("variantRender is idempotent per prospect and varies across prospects", async () => {
  const a1 = await variantRender(TOUCH, PROSPECT, 1);
  const a2 = await variantRender(TOUCH, PROSPECT, 1);
  assert.equal(a1!.body, a2!.body, "same prospect, same variant");
  const seen = new Set<string>();
  for (let i = 0; i < 24; i++) {
    const r = await variantRender(TOUCH, { ...PROSPECT, id: `pr_test_${i}` }, 1);
    if (r) seen.add(r.body.split("\n")[0]);
  }
  assert.ok(seen.size >= 2, `distinct variants across prospects (saw ${seen.size})`);
});

await test("variantRender returns null when the bank has no entry (deterministic copy stands)", async () => {
  const other = { ...TOUCH, body: "Hi {{First_Name}}, something not in the bank. worth a conversation?" + SIGN };
  assert.equal(await variantRender(other, PROSPECT, 1), null);
});

await test("variantRender rejects guard-failing variants at send time (falls back to null)", async () => {
  // A variant referencing {{Competitor}} cannot render for this prospect (no competitor on the
  // lead), so the render guard holds it and selection walks on. With ONLY bad variants -> null,
  // and the deterministic copy stands.
  const bad = "Hi {{First_Name}}, i placed {{A_Job_Title}} at {{Competitor}} in {{Near_City}}. {{P_subj}} fits your {{Open_Role}}: {{MH1}}, {{MH2}}, met {{P_obj}} there. worth a conversation?" + SIGN;
  writeBank([bad, bad, bad, bad]);
  assert.equal(await variantRender(TOUCH, { ...PROSPECT, id: "pr_guard_test" }, 1), null);
});

await test("bankStatus reports coverage", async () => {
  const s = await bankStatus();
  assert.equal(s.templates, MPC_TEMPLATES.length);
  assert.ok(s.path.endsWith("mpc-variant-bank.json"));
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
