/* Every surface variant of the news pitch must be sendable.
 *
 * The five beats are pre-written, so a defect here is a defect in EVERY send that draws
 * that index — there is no per-send model to catch it. This walks the full cross product
 * (signal x appointment kind x each beat's variants) and holds each rendering to the same
 * gate the AI pass is held to, plus the grammar traps the deterministic path can hit on
 * its own: a doubled "and" run-on, "a operations", a possessive of a name ending in s.
 *
 * Run: npx tsx scripts/test-pitch-variants.mts
 */
import {
  composePitch, checkPitch, stakes, type DeskProfile,
} from "../lib/signals/watch/signalPitch";
import { NEWS_SIGNALS, type NewsSignal } from "../lib/signals/watch/newsDiscover";

let failures = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) return;
  failures++;
  console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
}

const LUME: DeskProfile = {
  firmName: "Lume",
  verticals: ["distribution", "warehousing", "logistics"],
  placesTitles: "the operations and supply chain leaders we bring",
  domainDifficulty: "regulated, complex product handling",
  positioning: "We work as an embedded partner, not a resume vendor.",
  ctaMinutes: 15,
};

/* Reason clauses as buildReason actually emits them, per signal. */
const REASON: Record<NewsSignal, string> = {
  funding_round: "just closed a $60M Series B led by Battery Ventures to scale the network",
  exec_hire: "just brought in a new chief revenue officer",
  office_expansion: "is opening a new location",
  acquisition: "is working through an acquisition",
  product_launch: "just launched something new",
};

const COMPANIES = ["Tilley", "Conner Industries", "Freehand"];
const ROLES = [["Operations Manager"], ["Account Executive"], ["Software Engineer"], []];
const KINDS: Array<"board" | "leadership_team" | undefined> = [undefined, "board", "leadership_team"];

let rendered = 0;
const subjects = new Set<string>();
const bodies = new Set<string>();

for (const signal of NEWS_SIGNALS) {
  for (const company of COMPANIES) {
    for (const roles of ROLES) {
      for (const kind of KINDS) {
        // 24 seeds is comfortably more than the beat counts (4 x 3 x 3 x 3), so every
        // index of every beat is exercised rather than sampled.
        for (let s = 0; s < 24; s++) {
          const input = {
            firstName: "Graham",
            company,
            reason: REASON[signal],
            segment: "chemical distribution",
            signal,
            roles,
            facts: kind ? { appointmentKind: kind } : undefined,
            profile: LUME,
            variantSeed: `p_${s}`,
          };
          const pitch = composePitch(input);
          rendered++;
          subjects.add(pitch.subject);
          bodies.add(pitch.body);

          const label = `${signal}/${company}/${kind ?? "operating"}/seed${s}`;

          // The same gate the AI rewrite is held to. If a pre-written variant cannot pass
          // it, the deterministic floor is not a floor.
          const verdict = checkPitch(pitch.body, input);
          ok(verdict.ok, `${label}: passes the pitch gate`, verdict.problems.join("; "));

          // Grammar traps the template path can hit without any model involved.
          const opener = pitch.body.split("\n\n")[0];
          ok((opener.match(/, and /g) ?? []).length <= 1, `${label}: opener has no double and-clause`, opener);
          ok(!/\ba (?:operations|account|engineering|a)\b/i.test(pitch.body), `${label}: article agrees with the seat`, pitch.body);
          ok(!/'s'|s's\b/.test(pitch.subject), `${label}: possessive is well formed`, pitch.subject);
          ok(!/undefined|NaN|\[object/.test(pitch.body + pitch.subject), `${label}: no placeholder leaked`);
          ok(pitch.subject.trim().length > 0 && pitch.subject.length <= 70, `${label}: subject is a usable length`, pitch.subject);
          ok(!/[–—]/.test(pitch.subject), `${label}: subject carries no dash`);

          // The claim that must never appear for a board seat, in any variant.
          if (kind === "board") {
            ok(!/rebuild the bench|bench underneath|under the new leader|new leader/i.test(pitch.body + pitch.subject),
               `${label}: a board appointment is never described as an operating hire`, pitch.body);
          }
        }
      }
    }
  }
}

/* A board seat must be safe at EVERY stakes index, not just the ones a seed happened to
 * pick. This is the assertion that would have caught a lead-in reintroduced by variant. */
for (let i = 0; i < 8; i++) {
  const board = stakes("chemical distribution", "revenue", "exec_hire", "board", i);
  ok(!/rebuild|new leader|bench/i.test(board), `stakes variant ${i}: board seat carries no operating claim`, board);
  const operating = stakes("chemical distribution", "revenue", "exec_hire", undefined, i);
  ok(/, and /.test(operating), `stakes variant ${i}: an operating exec hire keeps its lead-in`, operating);
}

/* Variation has to be real. If the seed barely moves the copy, the whole exercise is
 * decoration — so require a healthy spread of distinct bodies for one fixed company. */
const oneCompany = new Set(
  Array.from({ length: 200 }, (_, s) =>
    composePitch({
      firstName: "Graham", company: "Tilley", reason: REASON.funding_round,
      segment: "chemical distribution", signal: "funding_round",
      roles: ["Operations Manager"], profile: LUME, variantSeed: `seed_${s}`,
    }).body),
);
ok(oneCompany.size >= 20, `one company x one signal yields many surface forms (got ${oneCompany.size})`);

/* An unseeded call is the original wording — the contract the existing suite relies on. */
const unseeded = composePitch({
  firstName: "Graham", company: "Tilley",
  reason: "is carrying more open operations roles than it has in months",
  segment: "chemical distribution", signal: "funding_round",
  roles: ["Operations Manager"], profile: LUME,
});
ok(unseeded.body.includes("chemical distribution is not a space where you can drop just anyone into an operations seat"),
   "unseeded stakes is the original wording", unseeded.body);
ok(unseeded.body.includes("Lume recruits into distribution, warehousing, and logistics"), "unseeded proof is the original wording");
ok(unseeded.body.includes("Worth 15 minutes"), "unseeded ask is the original wording");

/* The same prospect must always render the same email. */
const a = composePitch({ company: "Tilley", reason: REASON.funding_round, segment: "x", signal: "funding_round", roles: [], profile: LUME, variantSeed: "p_stable" });
const b = composePitch({ company: "Tilley", reason: REASON.funding_round, segment: "x", signal: "funding_round", roles: [], profile: LUME, variantSeed: "p_stable" });
ok(a.body === b.body && a.subject === b.subject, "the same seed renders the same email every time");

console.log(`\n${rendered} pitch renderings checked`);
console.log(`distinct subjects: ${subjects.size}, distinct bodies: ${bodies.size}`);
console.log(failures ? `\n${failures} FAILURES` : "\nall pitch variants are sendable");
process.exit(failures ? 1 : 0);
