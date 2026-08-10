/*
 * Discovery-source trial tests.
 *
 * Two things have to be right or the trial is worse than useless, because it would look
 * authoritative while being wrong:
 *   1. ATTRIBUTION is first-touch and never moves. If a refresh from the other arm can
 *      re-credit a company, the trial scores its own bookkeeping.
 *   2. The VERDICT refuses to name a winner the sample cannot support. A 2-of-40 vs
 *      4-of-40 split must read as noise, not as "news wins".
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ros-sourcetrial-"));
process.env.ROS_DATA_DIR = TMP;
delete process.env.DATABASE_URL;

const {
  compareArms, funnelFor, significance, requiredSendsPerArm, detectableLiftPp, ARM_LABEL,
} = await import("../lib/signals/watch/sourceTrial");
type Row = import("../lib/inmarket/curation").CuratedProspect;

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}
function eq(a: unknown, b: unknown, name: string) {
  ok(a === b, name, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/** Build n rows in one arm with a given number of sends and replies. */
function rows(arm: "jobs" | "news", opts: { n: number; sent: number; replied: number; opened?: number; bounced?: number; at?: string }): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < opts.n; i++) {
    out.push({
      id: `${arm}_${i}`,
      company: `${arm} Co ${i}`,
      signalType: arm === "news" ? "funding_round" : "job_posting",
      signalReason: "x",
      role: "Operations Manager",
      function: "operations",
      score: 70,
      managerTitle: "VP Operations",
      managerName: "A Person",
      managerTier: "named",
      likelyEmail: `a${i}@x.test`,
      status: "contactable",
      curatedAt: opts.at ?? "2026-08-10T12:00:00.000Z",
      discoveredAt: opts.at ?? "2026-08-10T12:00:00.000Z",
      discoverySource: arm,
      discoveryListId: `wl_${arm}`,
      sentAt: i < opts.sent ? "2026-08-11T12:00:00.000Z" : undefined,
      openedAt: i < (opts.opened ?? 0) ? "2026-08-11T13:00:00.000Z" : undefined,
      repliedAt: i < opts.replied ? "2026-08-12T12:00:00.000Z" : undefined,
      bouncedAt: i >= opts.n - (opts.bounced ?? 0) ? "2026-08-11T12:30:00.000Z" : undefined,
    } as Row);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. Funnel counting                                                  */
/* ------------------------------------------------------------------ */

const f = funnelFor(rows("news", { n: 100, sent: 80, replied: 8, opened: 30 }), "news");
eq(f.prospects, 100, "counts prospects in the arm");
eq(f.companies, 100, "counts distinct companies");
eq(f.sent, 80, "counts sends");
eq(f.replied, 8, "counts replies");
eq(f.replyRatePct, 10, "reply rate is replies over SENDS, not over prospects");
eq(f.openRatePct, 37.5, "open rate is over sends");
eq(f.repliesPerHundredCompanies, 8, "volume-inclusive yield is per company discovered");

const mixed = [...rows("jobs", { n: 10, sent: 10, replied: 1 }), ...rows("news", { n: 5, sent: 5, replied: 2 })];
eq(funnelFor(mixed, "jobs").prospects, 10, "an arm only counts its own rows");
eq(funnelFor(mixed, "news").prospects, 5, "and the other arm counts its own");

// Two prospects at the SAME company are two prospects but one company.
const dupCo = rows("news", { n: 2, sent: 2, replied: 0 }).map((r) => ({ ...r, company: "Same Co" }));
eq(funnelFor(dupCo, "news").companies, 1, "two decision-makers at one company is ONE company");
eq(funnelFor(dupCo, "news").prospects, 2, "but still two prospects");

/* ------------------------------------------------------------------ */
/* 2. The verdict refuses to be fooled                                 */
/* ------------------------------------------------------------------ */

// The classic early-days trap: 2/40 vs 4/40 looks like a doubling. It is noise.
const early = compareArms(
  [...rows("jobs", { n: 40, sent: 40, replied: 2 }), ...rows("news", { n: 40, sent: 40, replied: 4 })],
  { minSendsPerArm: 200 },
);
eq(early.verdict, "insufficient_data", "40 sends per arm cannot name a winner even at a 2x observed gap");
ok(!early.significance.significant, "and the difference is not significant");
ok(early.readout.includes("Too early"), "the readout says so in plain English", early.readout);
ok(early.readable === false, "readable is false below the floor");

// Same rates, real volume: a genuine, separable difference.
const real = compareArms(
  [...rows("jobs", { n: 3000, sent: 3000, replied: 105 }),   // 3.5%
   ...rows("news", { n: 3000, sent: 3000, replied: 210 })],  // 7.0%
  { minSendsPerArm: 200 },
);
eq(real.verdict, "news", "a 3.5 vs 7.0 split at 3,000 sends per arm IS callable");
ok(real.significance.significant, "and it clears p<0.05");
ok(real.significance.p < 0.001, "with a small p", real.significance.p);
eq(real.significance.liftPp, 3.5, "absolute lift in percentage points");
eq(real.significance.liftRelPct, 100, "relative lift is 100%");

// Identical performance at high volume reads as a tie, not a coin-flip winner.
const tie = compareArms(
  [...rows("jobs", { n: 2000, sent: 2000, replied: 70 }), ...rows("news", { n: 2000, sent: 2000, replied: 70 })],
  { minSendsPerArm: 200 },
);
eq(tie.verdict, "tie", "identical rates at volume is a tie");
ok(tie.readout.includes("indistinguishable"), "and says the approaches are indistinguishable");

// Direction: the job arm can win too.
const jobsWin = compareArms(
  [...rows("jobs", { n: 3000, sent: 3000, replied: 210 }), ...rows("news", { n: 3000, sent: 3000, replied: 105 })],
  { minSendsPerArm: 200 },
);
eq(jobsWin.verdict, "jobs", "the verdict is not biased toward the new thing");

/* ------------------------------------------------------------------ */
/* 3. Honesty about what the sample can resolve                        */
/* ------------------------------------------------------------------ */

const need45 = requiredSendsPerArm(0.035, 0.045);
const need50 = requiredSendsPerArm(0.035, 0.05);
const need70 = requiredSendsPerArm(0.035, 0.07);
ok(need45 > need50 && need50 > need70, "a smaller difference needs a bigger sample", { need45, need50, need70 });
ok(need50 > 2000 && need50 < 4000, "3.5% vs 5.0% needs roughly 2,800 per arm", need50);
ok(need70 > 400 && need70 < 900, "3.5% vs 7.0% needs roughly 640 per arm", need70);
eq(requiredSendsPerArm(0.035, 0.035), Infinity, "no difference needs an infinite sample");

ok(detectableLiftPp(funnelFor(rows("jobs", { n: 40, sent: 40, replied: 2 }), "jobs"),
                    funnelFor(rows("news", { n: 40, sent: 40, replied: 4 }), "news"), 0.035) > 5,
   "at 40 sends per arm only a huge difference is visible");
ok(detectableLiftPp(funnelFor(rows("jobs", { n: 3000, sent: 3000, replied: 105 }), "jobs"),
                    funnelFor(rows("news", { n: 3000, sent: 3000, replied: 210 }), "news"), 0.035) < 1.5,
   "at 3,000 sends per arm a sub-point difference is visible");

ok((early.sendsStillNeededPerArm ?? 0) > 0, "an unresolved trial says how many more sends it needs", early.sendsStillNeededPerArm);
eq(compareArms([], { minSendsPerArm: 200 }).verdict, "insufficient_data", "an empty store is insufficient, not a tie");
eq(compareArms([], {}).arms.jobs.replyRatePct, 0, "no divide-by-zero on an empty arm");

/* ------------------------------------------------------------------ */
/* 4. Warnings that protect the read                                   */
/* ------------------------------------------------------------------ */

const lopsided = compareArms(
  [...rows("jobs", { n: 1000, sent: 1000, replied: 35 }), ...rows("news", { n: 50, sent: 50, replied: 2 })],
  { minSendsPerArm: 10 },
);
ok(lopsided.warnings.some((w) => w.includes("lopsided")), "a 20x volume gap is called out", lopsided.warnings);

const bouncy = compareArms(
  [...rows("jobs", { n: 500, sent: 500, replied: 20 }), ...rows("news", { n: 500, sent: 500, replied: 40, bounced: 50 })],
  { minSendsPerArm: 10 },
);
ok(bouncy.warnings.some((w) => w.includes("bouncing")), "an arm buying replies with bounces is called out", bouncy.warnings);

const unattributed = compareArms(
  [...rows("jobs", { n: 10, sent: 10, replied: 1 }),
   ...rows("news", { n: 10, sent: 10, replied: 1 }).map((r) => ({ ...r, discoverySource: undefined }))],
  { minSendsPerArm: 5 },
);
eq(unattributed.unattributedProspects, 10, "rows with no attribution are counted, not silently dropped");
ok(unattributed.warnings.some((w) => w.includes("no discovery attribution")), "and flagged");
eq(unattributed.arms.news.prospects, 0, "an unattributed row joins NEITHER arm");

/* ------------------------------------------------------------------ */
/* 5. Time window is on DISCOVERY, not on send                         */
/* ------------------------------------------------------------------ */

const older = rows("jobs", { n: 10, sent: 10, replied: 5, at: "2026-08-01T12:00:00.000Z" });
const newer = rows("news", { n: 10, sent: 10, replied: 1, at: "2026-08-12T12:00:00.000Z" });
const windowed = compareArms([...older, ...newer], { from: "2026-08-10", minSendsPerArm: 1 });
eq(windowed.arms.jobs.prospects, 0, "rows discovered before the window are excluded");
eq(windowed.arms.news.prospects, 10, "rows discovered inside it are kept");
const allTime = compareArms([...older, ...newer], { minSendsPerArm: 1 });
eq(allTime.arms.jobs.prospects, 10, "no window means everything counts");

/* ------------------------------------------------------------------ */
/* 6. FIRST-TOUCH attribution through the real curation upsert         */
/* ------------------------------------------------------------------ */
/* The trial is only worth reading if a company keeps the arm that found it. This
 * exercises the real mergeCuratedRows path, not a mock of it. */

const { mergeCuratedRows, allCurated } = await import("../lib/inmarket/curation");

const base: Row = {
  id: "cur_firsttouch", company: "Freehand", signalType: "funding_round", signalReason: "just closed a $75M Series B",
  role: "Operations Manager", function: "operations", score: 90,
  managerTitle: "VP Operations", managerName: "A Person", managerTier: "named",
  likelyEmail: "a@freehand.test", status: "contactable",
  curatedAt: "2026-08-10T12:00:00.000Z", discoveredAt: "2026-08-10T12:00:00.000Z",
  discoverySource: "news", discoveryListId: "wl_news",
} as Row;

await mergeCuratedRows([base]);
eq((await allCurated()).find((r) => r.id === "cur_firsttouch")?.discoverySource, "news", "first insert records the arm");

// The job feed later re-curates the same company. It must NOT steal the credit.
await mergeCuratedRows([{ ...base, signalType: "job_posting", discoverySource: "jobs", discoveryListId: "wl_jobs", discoveredAt: "2026-08-14T12:00:00.000Z" } as Row]);
const after = (await allCurated()).find((r) => r.id === "cur_firsttouch");
eq(after?.discoverySource, "news", "a later re-curate by the OTHER arm does not move attribution");
eq(after?.discoveryListId, "wl_news", "nor the list id");
eq(after?.discoveredAt, "2026-08-10T12:00:00.000Z", "nor the discovery timestamp");
eq(after?.signalType, "job_posting", "while genuinely refreshable fields DO update");

// A row that predates the trial gains attribution when an arm first curates it.
await mergeCuratedRows([{ ...base, id: "cur_legacy", discoverySource: undefined, discoveryListId: undefined, discoveredAt: undefined } as Row]);
eq((await allCurated()).find((r) => r.id === "cur_legacy")?.discoverySource, undefined, "a legacy row starts unattributed");
await mergeCuratedRows([{ ...base, id: "cur_legacy", discoverySource: "jobs", discoveryListId: "wl_jobs" } as Row]);
eq((await allCurated()).find((r) => r.id === "cur_legacy")?.discoverySource, "jobs", "and is claimed by whichever arm curates it first");

/* ------------------------------------------------------------------ */

eq(ARM_LABEL.jobs, "Hire Signals (job feed)", "the job arm is labelled as the product calls it");

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
