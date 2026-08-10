/* Vertical presets + per-industry funnel.
 *
 * Two things are being protected here.
 *
 * The PRESETS carry the three fields that decide whether a watchlist produces anything,
 * and every one of them was chosen off a measurement. A well-meaning edit that enables
 * product_launch, or drops targetRoles, silently degrades the arm without breaking it —
 * which is the worst kind of regression because nothing looks wrong.
 *
 * The per-industry FUNNEL exists to stop a desk reading a reply rate off forty sends. It
 * must report upstream screenability early and reply-readability late, and it must never
 * present a row as readable before it is.
 *
 * Run: npx tsx scripts/test-verticals.mts
 */
import { VERTICAL_PRESETS, presetByKey, presetToWatchlist } from "../lib/signals/watch/presets";
import { compareLists } from "../lib/signals/watch/sourceTrial";
import { NEWS_SIGNALS } from "../lib/signals/watch/newsDiscover";
import type { CuratedProspect } from "../lib/inmarket/curation";

let failures = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { console.log(`PASS ${label}`); return; }
  failures++;
  console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
}
function eq<T>(a: T, b: T, label: string): void { ok(a === b, label, `expected ${String(b)}, got ${String(a)}`); }

/* ------------------------------------------------------------------ */
/* 1. The presets                                                      */
/* ------------------------------------------------------------------ */

eq(VERTICAL_PRESETS.length, 6, "six verticals ship");
eq(new Set(VERTICAL_PRESETS.map((p) => p.key)).size, 6, "keys are unique");
eq(new Set(VERTICAL_PRESETS.map((p) => p.segment)).size, 6, "segments are unique — a duplicate would double-pitch every company it finds");
eq(VERTICAL_PRESETS.filter((p) => p.tier === "a").length, 3, "three are defensible on the current desk");

for (const p of VERTICAL_PRESETS) {
  ok(p.segment.trim().length > 0, `${p.key}: has a segment (a news list with none can never poll)`);
  ok(p.newsSignals.length >= 2, `${p.key}: hunts at least two signals`);
  ok(p.newsSignals.every((s) => (NEWS_SIGNALS as string[]).includes(s)),
     `${p.key}: every signal is one the discovery engine knows`, p.newsSignals.join(","));
  // THE tuning decision. product_launch was the highest-volume signal in the measurement
  // and carries the lowest intent score in newsDiscover; enabling it would lose the
  // head-to-head for a reason that has nothing to do with news being worse.
  ok(!p.newsSignals.includes("product_launch"),
     `${p.key}: product_launch stays off — highest volume, lowest intent`);
  // targetRoles overrides the inferred build-out. Three distinct roles is what makes
  // curation research three DIFFERENT bosses instead of three flavours of one.
  eq(p.targetRoles.length, 3, `${p.key}: names three roles, one per decision-maker`);
  eq(new Set(p.targetRoles).size, 3, `${p.key}: the three roles are distinct`);
  ok(p.rationale.length > 30, `${p.key}: carries a rationale someone can disagree with`);
}

/* Verticals the measurement rejected must not creep back in. */
const segments = VERTICAL_PRESETS.map((p) => p.segment.toLowerCase());
for (const dropped of ["chemical distribution", "building products distribution", "cold chain logistics", "revenue cycle management"]) {
  ok(!segments.includes(dropped), `"${dropped}" stays out — it was dropped on measured evidence`);
}

/* A preset must become a valid, conservative watchlist. */
const wl = presetToWatchlist(VERTICAL_PRESETS[0]);
eq(wl.source, "news", "a preset builds a news list");
eq(wl.segment, VERTICAL_PRESETS[0].segment, "the segment carries through");
ok((wl.everyMinutes ?? 0) >= 60, "a new vertical polls hourly, not every 15 minutes");
ok((wl.perPollCompanyCap ?? 999) <= 10, "and cannot dump hundreds of companies on its first run", String(wl.perPollCompanyCap));
eq(presetToWatchlist(VERTICAL_PRESETS[0], { active: false }).active, false, "overrides apply");
ok(!presetByKey("does_not_exist"), "an unknown key resolves to nothing rather than a default");

/* ------------------------------------------------------------------ */
/* 2. The per-industry funnel                                          */
/* ------------------------------------------------------------------ */

function row(over: Partial<CuratedProspect>): CuratedProspect {
  return {
    id: Math.random().toString(36).slice(2),
    company: "Acme", signalType: "funding_round", signalReason: "raised",
    role: "Operations Manager", function: "operations", score: 70,
    managerTitle: "VP Operations", managerTier: "named", status: "contactable",
    curatedAt: "2026-08-01T00:00:00.000Z", discoveredAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as CuratedProspect;
}

/* A vertical with plenty of research but few sends: screenable, NOT reply-readable.
 * This is the exact state every new vertical sits in for weeks, and the one where a
 * desk is most tempted to call a winner off noise. */
const early = compareLists(
  Array.from({ length: 60 }, (_, i) =>
    row({ company: `Co${i}`, discoverySource: "news", discoveryListId: "wl_auto",
          managerName: "A", likelyEmail: "a@b.com",
          ...(i < 40 ? { sentAt: "2026-08-02T00:00:00.000Z" } : {}),
          ...(i < 2 ? { repliedAt: "2026-08-03T00:00:00.000Z" } : {}) })),
  { minProspects: 30, minSends: 200, names: { wl_auto: "Industrial automation" } },
);
eq(early.length, 1, "one list, one row");
eq(early[0].screenable, true, "60 researched prospects is enough to screen the vertical");
eq(early[0].replyReadable, false, "40 sends is NOT enough to read a reply rate");
ok(early[0].readout.includes("Industrial automation"), "the row reads as a vertical, not an id", early[0].readout);
ok(early[0].readout.includes("NOT"), "and says plainly that reply rate is not readable yet", early[0].readout);
eq(early[0].companies, 60, "distinct companies are counted");
eq(early[0].arm, "news", "the arm is carried so volumes are never compared blind");

/* Barely started: not even screenable. */
const tiny = compareLists(
  Array.from({ length: 5 }, (_, i) => row({ company: `T${i}`, discoverySource: "jobs", discoveryListId: "wl_new" })),
  { minProspects: 30, names: { wl_new: "Aerospace" } },
);
eq(tiny[0].screenable, false, "five prospects is too early even to screen");
ok(tiny[0].readout.includes("too early"), "and says so", tiny[0].readout);

/* Mature: both readable. */
const mature = compareLists(
  Array.from({ length: 400 }, (_, i) =>
    row({ company: `M${i}`, discoverySource: "jobs", discoveryListId: "wl_3pl",
          managerName: "A", likelyEmail: "a@b.com", sentAt: "2026-08-02T00:00:00.000Z",
          ...(i < 20 ? { repliedAt: "2026-08-03T00:00:00.000Z" } : {}) })),
  { minProspects: 30, minSends: 200, names: { wl_3pl: "3PL" } },
);
eq(mature[0].replyReadable, true, "400 sends makes the reply rate readable");
eq(mature[0].replyRatePct, 5, "and the rate is computed correctly");

/* Rows with no list attribution cannot be assigned to a vertical, and must not become
 * a phantom bucket that outranks the real ones. */
const orphan = compareLists([row({ discoverySource: "news" }), row({ discoverySource: "jobs" })], {});
eq(orphan.length, 0, "prospects with no list are excluded, not bucketed");

/* Ordering: most evidence first. */
const ordered = compareLists([
  ...Array.from({ length: 10 }, (_, i) => row({ company: `S${i}`, discoverySource: "news", discoveryListId: "small" })),
  ...Array.from({ length: 50 }, (_, i) => row({ company: `B${i}`, discoverySource: "news", discoveryListId: "big" })),
], {});
eq(ordered[0].listId, "big", "the row with the most evidence leads");

eq(compareLists([], {}).length, 0, "an empty store is an empty report, not a crash");

console.log(failures ? `\n${failures} FAILURES` : "\nverticals and per-industry reporting are sound");
process.exit(failures ? 1 : 0);
