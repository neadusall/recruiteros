/**
 * Copy-hygiene gate for every HARDCODED outreach template (the LLM paths are gated at
 * runtime by the humanizer's naturalness gate; this covers the deterministic pool):
 *   - no banned template phrase (the same BANNED_PHRASES the humanizer enforces)
 *   - no em/en dash anywhere (standing house ban)
 *   - no fake-reply "re:" subject on a first-contact template
 *   - spintax expands cleanly: no stray braces or pipes survive, every branch renders
 *   - every video follow-up carries {{videoembed}} on its own line + the sign-off spin
 * Run: npx tsx scripts/test-copy-hygiene.mts
 */
import assert from "node:assert/strict";
import { MPC_TEMPLATES } from "../lib/bd/mpc/templates";
import { VIDEO_FOLLOWUPS } from "../lib/inmarket/videoOpener";
import { BANNED_PHRASES } from "../lib/bd/mpc/humanizer";
import { expandSpintax } from "../lib/copy/spintax";

let passed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; }
}

/** All surface forms a template can render as: expand spintax under many seeds, then
 *  blank the merge tokens (they're filled later and can't introduce template phrases). */
function surfaces(text: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < 40; i++) out.add(expandSpintax(text, `hygiene-${i}`));
  return [...out].map((s) => s.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, "x"));
}

const ALL: Array<{ id: string; subject: string; body: string; video: boolean }> = [
  ...MPC_TEMPLATES.map((t) => ({ id: `mpc:${t.id}`, subject: t.subject, body: t.body, video: false })),
  ...VIDEO_FOLLOWUPS.map((t, i) => ({ id: `video:${i + 1}`, subject: t.subject, body: t.body, video: true })),
];

for (const t of ALL) {
  test(`${t.id}: no banned phrase in any rendered surface`, () => {
    for (const s of [...surfaces(t.subject), ...surfaces(t.body)]) {
      const hay = s.toLowerCase();
      for (const p of BANNED_PHRASES) assert.ok(!hay.includes(p), `banned "${p}" in: ${s.slice(0, 120)}`);
    }
  });
  test(`${t.id}: no em/en dash`, () => {
    assert.ok(!/[—–]/.test(t.subject + t.body), "em/en dash found");
  });
  test(`${t.id}: no fake-reply subject`, () => {
    for (const s of surfaces(t.subject)) assert.ok(!/^\s*re\s*:/i.test(s), `fake "re:" subject: ${s}`);
  });
  test(`${t.id}: spintax expands clean (no stray braces/pipes)`, () => {
    for (const s of [...surfaces(t.subject), ...surfaces(t.body)]) {
      assert.ok(!/[{}|]/.test(s), `spintax remnant in: ${s.slice(0, 160)}`);
    }
  });
  if (t.video) {
    test(`${t.id}: {{videoembed}} on its own line + sign-off`, () => {
      assert.ok(/\n\{\{videoembed\}\}\n/.test(t.body), "videoembed must sit on its own line");
      assert.ok(/\{(Thanks\|Best|Best\|Thanks)\}, \{\{Your_Name\}\}/.test(t.body), "sign-off spin missing");
    });
  }
}

test("video follow-up pool has >= 10 variants", () => {
  assert.ok(VIDEO_FOLLOWUPS.length >= 10, `only ${VIDEO_FOLLOWUPS.length}`);
});
test("every MPC subject varies (spintax present)", () => {
  for (const t of MPC_TEMPLATES) {
    const distinct = new Set(surfaces(t.subject));
    assert.ok(distinct.size >= 2, `static subject on ${t.id}: ${t.subject}`);
  }
});

process.on("beforeExit", () => {
  console.log(process.exitCode ? `FAILED (passed ${passed})` : `all ${passed} passed`);
});
