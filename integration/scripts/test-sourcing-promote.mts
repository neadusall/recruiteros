/**
 * Regression tripwire for the promote dedupe branch (user mandate 2026-07-21).
 * Run: npx tsx scripts/test-sourcing-promote.mts   (from integration/)
 *
 * A top-up re-promote (autoflow after Enrich resume, overnight queue, Boost
 * phones) hits the dedupe branch for everyone already in the pipeline. The
 * blank-fill of email/phone/title/location there must be UNCONDITIONAL: gating
 * it on opts.retag (the pre-2026-07-21 shape) silently kept Boost-found phones
 * off the Candidates rows. Only the tag restamp is retag-scoped. The queries
 * run through the core repository, so this suite asserts the source shape,
 * same approach as the nightqueue guardrail checks.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "lib", "sourcing", "promote.ts"), "utf8");

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}`);
  if (!ok) failed++;
}

// The old gated shape must not come back: a block opened on opts.retag that
// contains the phone fill.
const gatedBlock = /if\s*\(opts\.retag\)\s*\{[\s\S]{0,600}existing\.phone\s*=/.test(src);
check("phone blank-fill is not gated behind opts.retag", !gatedBlock);

check("phone blank-fill present (fills blanks only)",
  /if\s*\(!existing\.phone\s*&&\s*c\.phone\)/.test(src));
check("email blank-fill present (fills blanks only)",
  /if\s*\(!existing\.email\s*&&\s*c\.email\)/.test(src));
check("phoneSource rides along with a filled phone",
  /existing\.phoneSource\s*=\s*c\.phoneSource/.test(src));
check("tag restamp stays combined-list-only (retag-scoped)",
  /opts\.retag\s*&&\s*existing\.category\s*!==\s*tag/.test(src));
check("dedupe hits still save when changed",
  /if\s*\(dirty\)\s*await\s*core\.saveProspect\(existing\)/.test(src));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall green");
