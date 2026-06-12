/**
 * Outreach Statistics — correctness suite.
 * No repo test runner is configured, so this is a self-contained assertion
 * script. Run it with:  npx tsx lib/analytics/outreach.test.ts
 * Exits non-zero on the first failed assertion; prints "ALL PASS" otherwise.
 *
 * It seeds a known population through the in-memory core and asserts the model
 * indicates correctly: funnel monotonicity, rate bounds, group-vs-rest
 * significance, time-window gating of stale bookings, and winner promotion.
 */

import { devCore } from "../core/repository";
import { buildOutreachStats } from "./outreach";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { console.log("  ✓ " + msg); }
  else { console.error("  ✗ FAIL: " + msg); failures++; }
}

const ISO = (d: Date) => d.toISOString();
const now = new Date();
const daysAgo = (n: number) => ISO(new Date(now.getTime() - n * 86_400_000));

async function seed(ws: string) {
  const core = devCore();
  await core.saveCampaign({
    id: "cmp", workspaceId: ws, motion: "recruiting", name: "Test", goal: "g",
    icp: { accountProfile: "", persona: "", disqualifiers: [] }, signals: [], channels: {},
    methodology: "seven_touch_drip", voiceNoteThreshold: 80, dailyCap: 25, status: "active", createdAt: daysAgo(60),
  } as any);

  // Variant A: strong (50% booked-in-window, + some non-positive replies).
  // Variant B: weak (10% booked, + a few non-positive replies).
  let i = 0;
  function add(variant: string, status: string, bookedAt: string | undefined) {
    const id = "p" + (i++);
    core.saveProspect({
      id, workspaceId: ws, campaignId: "cmp", motion: "recruiting", ownerId: "u1",
      fullName: "P " + id, firstName: "P", title: "VP of Engineering", company: "Northwind fintech",
      status, dripStage: 1, warmth: 70, bookedAt, createdAt: daysAgo(5),
    } as any);
    core.recordActivity({
      id: "a" + id, workspaceId: ws, prospectId: id, channel: "email", type: "email_sent",
      summary: "Email", at: daysAgo(3), campaignId: "cmp", variant, touch: "Signal Opener",
    } as any);
  }
  // A: 40 prospects -> 20 booked (in window), 5 nurture (replied, not positive), 15 in_sequence.
  for (let k = 0; k < 20; k++) add("msg-a-direct", "booked", daysAgo(2));
  for (let k = 0; k < 5; k++) add("msg-a-direct", "nurture", undefined);
  for (let k = 0; k < 15; k++) add("msg-a-direct", "in_sequence", undefined);
  // B: 40 prospects -> 4 booked, 6 closed_lost (replied, not positive), 30 in_sequence.
  for (let k = 0; k < 4; k++) add("msg-b-curiosity", "booked", daysAgo(2));
  for (let k = 0; k < 6; k++) add("msg-b-curiosity", "closed_lost", undefined);
  for (let k = 0; k < 30; k++) add("msg-b-curiosity", "in_sequence", undefined);
  // One STALE booking in A: booked long before the window -> must NOT count as booked/positive now.
  add("msg-a-direct", "booked", daysAgo(200));
}

(async () => {
  const ws = "ws_stats_test";
  await seed(ws);
  const s = await buildOutreachStats(ws, { motion: "recruiting", sinceDays: 30 });

  console.log("totals:", JSON.stringify(s.totals));

  // Volume + funnel.
  ok(s.totals.prospectsContacted === 81, "contacted = 81 (all sent in window, incl. stale-booked)");
  ok(s.totals.touchesSent === 81, "touchesSent = 81");
  ok(s.totals.booked === 24, "booked = 24 (stale booking outside window excluded)");
  ok(s.totals.positive === 24, "positive = 24 (booked-in-window only)");
  // The stale-booked prospect DID reply (status "booked" implies a past reply), so
  // it counts as engaged/replied even though its booking is outside the window.
  ok(s.totals.replied === 36, "replied = 36 (24 booked + 5 nurture + 6 closed_lost + 1 stale-booked = engaged)");
  const f = s.funnel.map((x) => x.value);
  ok(f.every((v, i) => i === 0 || v <= f[i - 1]), "funnel is monotonic non-increasing: " + f.join(">="));

  // Rate bounds everywhere.
  const allRates = [s.totals.replyRate, s.totals.positiveRate, s.totals.bookRate]
    .concat(s.byVariant.map((v) => v.positiveRate))
    .concat(s.byChannel.map((c) => c.replyRate));
  ok(allRates.every((r) => r >= 0 && r <= 100), "every rate is within [0,100]");

  // Variant comparison + significance (group vs rest).
  const A = s.byVariant.find((v) => v.key === "msg-a-direct")!;
  const B = s.byVariant.find((v) => v.key === "msg-b-curiosity")!;
  ok(!!A && !!B, "both variants present in byVariant");
  ok(A.positiveRate > B.positiveRate, "A positiveRate (" + A.positiveRate + ") > B (" + B.positiveRate + ")");
  ok(A.confident === true, "A is flagged confident (significant vs rest)");
  ok(B.confident === false, "B is NOT flagged confident");
  ok(A.lift > 0 && B.lift < 0, "lift signs correct (A>0, B<0)");

  // Channel attribution.
  const email = s.byChannel.find((c) => c.channel === "email")!;
  ok(!!email && email.sent === 81, "email channel sent = 81");

  // Recommendations promote the confident winner.
  const vrec = s.recommendations.find((r) => r.kind === "variant");
  ok(!!vrec && vrec.confident === true && vrec.apply!.winningVariant === "msg-a-direct", "variant recommendation is the confident winner A");

  // Honesty meta.
  ok(s.meta.lowVolume === false, "lowVolume false at n=81");
  ok(s.meta.minForConfidence >= 15, "minForConfidence exposed");

  // Low-volume guard: a tiny separate workspace must NOT flag confidence.
  const ws2 = "ws_tiny";
  const core = devCore();
  for (let k = 0; k < 5; k++) {
    core.saveProspect({ id: "t" + k, workspaceId: ws2, campaignId: "x", motion: "recruiting", fullName: "T", firstName: "T", title: "VP Sales", company: "Acme saas", status: k < 3 ? "booked" : "in_sequence", dripStage: 1, warmth: 60, bookedAt: daysAgo(1), createdAt: daysAgo(2) } as any);
    core.recordActivity({ id: "ta" + k, workspaceId: ws2, prospectId: "t" + k, channel: "email", type: "email_sent", summary: "e", at: daysAgo(1), variant: "tiny", touch: "Signal Opener" } as any);
  }
  const s2 = await buildOutreachStats(ws2, { motion: "recruiting", sinceDays: 30 });
  ok(s2.meta.lowVolume === true, "tiny workspace flagged lowVolume");
  ok(s2.byVariant.every((v) => v.confident === false), "no confident flags under the volume bar");

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THREW:", e); process.exit(1); });
