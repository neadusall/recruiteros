/**
 * Copy fail-safe — regression suite.
 * Run: npx tsx lib/copy/guidelines.test.ts   (exits non-zero on failure)
 *
 * Guards three things:
 *   1. the scanner catches the exact copy the operator keeps rejecting,
 *   2. the review gate self-repairs and holds,
 *   3. the shipping SEED SCRIPTS + CONTENT LIBRARY contain no hollow/fabricated
 *      phrasing (so a future edit can't quietly re-introduce it).
 */

import { scanCopy } from "./guardrail";
import { reviewCopy } from "./review";
import { DEFAULT_VOICE_SCRIPTS } from "../voice/seedScripts";
import { SIGNAL_ANGLES } from "../content/library/signals";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ FAIL: ") + m); if (!c) fails++; };

/* 1. The scanner catches what the operator rejects. */
const rejected = "Hi Marcus, this is me with the firm. Came across your background from your time there, figured I'd reach out directly. I keep strong engineers warm. Worth a quick call?";
const r1 = scanCopy(rejected);
ok(!r1.ok, "rejected draft is flagged");
ok(r1.violations.some((v) => v.rule === "came_across_background"), "flags 'came across your background'");
ok(r1.violations.some((v) => v.rule === "reach_out_directly"), "flags 'figured I'd reach out directly'");
ok(r1.violations.some((v) => v.rule === "keep_warm"), "flags 'keep strong engineers warm'");

/* clean, honest, specific copy passes. */
const clean = "Hi Marcus, I came across the payments platform rebuild you led and it lines up with a mandate I'm running for a client. Worth fifteen minutes this week? If the timing's off, I'll leave it there.";
ok(scanCopy(clean).ok, "clean specific copy passes");

/* fabricated referral is gated by a real source. */
const referral = "Hi Marcus, you came recommended when I mentioned I needed a revenue leader.";
ok(!scanCopy(referral).ok, "fabricated referral flagged with no source");
ok(scanCopy(referral, { hasRealReferralSource: true }).ok, "referral allowed when a real source is attached");

/* dashes + emoji still caught. */
ok(!scanCopy("a senior full-stack lead").ok, "intra-word hyphen flagged");
ok(!scanCopy("great news 🎉").ok, "emoji flagged");

/* 2. The review gate: self-repair, then held. */
(async () => {
  let n = 0;
  const repairing = await reviewCopy(async () => {
    n++;
    return { body: n === 1 ? "wanted to reach out about the role" : "I came across the platform work you led; worth a quick call?" };
  }, { autoSend: false });
  ok(repairing.status === "repaired", "self-repairs a first bad draft to clean");

  const stuck = await reviewCopy(async () => ({ body: "just checking in, you came to mind" }), { autoSend: false, maxTries: 2 });
  ok(stuck.status === "held", "unfixable copy is held (never sent)");

  /* 3. Foundation regression: no hollow/fabricated phrasing in seeds + library.
     (Dashes are intentionally stripped at render, so we ignore format rules here.) */
  const FORMAT = new Set(["dash", "emoji", "hashtag"]);
  const dirtyOf = (text: string) => scanCopy(text).violations.filter((v) => !FORMAT.has(v.rule));

  let seedBad = 0;
  for (const s of DEFAULT_VOICE_SCRIPTS) {
    const bad = dirtyOf(s.template);
    if (bad.length) { seedBad++; console.log(`    seed "${s.id}": ${bad.map((b) => b.why).join("; ")}`); }
  }
  ok(seedBad === 0, "voice seed scripts have no hollow/fabricated phrasing");

  let libBad = 0;
  for (const [type, angle] of Object.entries(SIGNAL_ANGLES as Record<string, any>)) {
    for (const k of ["bd", "recruiting"]) {
      const text = angle?.[k];
      if (typeof text !== "string") continue;
      const bad = dirtyOf(text);
      if (bad.length) { libBad++; console.log(`    signal "${type}.${k}": ${bad.map((b) => b.why).join("; ")}`); }
    }
  }
  ok(libBad === 0, "content-library signal openers have no hollow/fabricated phrasing");

  console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})();
