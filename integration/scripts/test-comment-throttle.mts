/**
 * The public-comment lane's throttle, exercised against the real module.
 *
 * What this proves: the day allowance actually varies day to day and stays
 * inside the jitter band, the weekly ceiling is hard, the spacing gate holds
 * a second comment back, and the near-duplicate guard catches a reworded
 * repeat. Run: npx tsx scripts/test-comment-throttle.mts
 */
import assert from "node:assert";
import {
  commentThrottleFor, setCommentLimits, commentLimitsFor,
  __throttleTestHooks as hooks,
} from "../lib/linkedin/commentWatch";

const WS = "ws_throttle_test";
let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

console.log("comment throttle");

check("defaults are the documented ones", () => {
  const l = commentLimitsFor(WS);
  assert.equal(l.enabled, true);
  // Owner spec 2026-08-15: 8 to 10 a day. The week has to clear seven days of
  // that or it silently becomes the real limit instead of the day.
  assert.equal(l.perDay, 9);
  assert.equal(l.perWeek, 63);
});

check("the day allowance varies across days and stays in the jitter band", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 30; i++) {
    const day = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    const a = hooks.dayAllowanceFor(WS, day);
    assert.ok(a >= 8 && a <= 10, `allowance ${a} outside the asked-for 8 to 10 band`);
    seen.add(a);
  }
  // The band is the spec, so there are only three values to draw from; what
  // still matters is that the number is not the same every single day.
  assert.ok(seen.size >= 2, `only ${seen.size} distinct allowances in 30 days: not varied enough`);
});

check("the same day always returns the same allowance", () => {
  const a = hooks.dayAllowanceFor(WS, "2026-08-14");
  for (let i = 0; i < 20; i++) assert.equal(hooks.dayAllowanceFor(WS, "2026-08-14"), a);
});

check("a fresh workspace is clear to comment", () => {
  const t = commentThrottleFor(WS);
  assert.equal(t.blockedReason, undefined);
  assert.equal(t.todayUsed, 0);
});

check("one comment trips the spacing gate", () => {
  hooks.setLog(WS, [new Date().toISOString()]);
  const t = commentThrottleFor(WS);
  assert.ok(t.blockedReason && /Spacing/.test(t.blockedReason), `expected a spacing hold, got ${t.blockedReason}`);
  assert.ok(t.nextSlotAt, "spacing hold must say when the next slot opens");
  const gap = (new Date(t.nextSlotAt as string).getTime() - Date.now()) / 60_000;
  assert.ok(gap > 0 && gap <= 95, `next slot ${gap} minutes away, outside the 24 to 95 band`);
});

check("the day allowance is a wall, and it outranks the spacing message", () => {
  // Anchored at noon UTC so every entry lands on today's date whatever hour
  // the suite runs at; the day wall is checked before spacing, so a full day
  // must report the allowance, not a gap.
  const day = new Date().toISOString().slice(0, 10);
  const noon = Date.parse(`${day}T12:00:00.000Z`);
  const allowance = hooks.dayAllowanceFor(WS, day);
  hooks.setLog(WS, Array.from({ length: allowance }, (_, i) =>
    new Date(noon - (allowance - i) * 180_000).toISOString()));
  const t = commentThrottleFor(WS);
  assert.equal(t.todayUsed, allowance);
  assert.ok(t.blockedReason && /allowance is used/.test(t.blockedReason), `got ${t.blockedReason}`);
});

check("the weekly ceiling is hard and outranks the day", () => {
  // Spread across the last 6 days so no single day is over its allowance.
  const now = Date.now();
  hooks.setLog(WS, Array.from({ length: 63 }, (_, i) =>
    new Date(now - (i + 1) * 2 * 3_600_000).toISOString()));
  const t = commentThrottleFor(WS);
  assert.equal(t.weekUsed, 63);
  assert.ok(t.blockedReason && /Weekly/.test(t.blockedReason), `got ${t.blockedReason}`);
});

check("comments older than a week roll off the weekly count", () => {
  const old = Date.now() - 9 * 86_400_000;
  hooks.setLog(WS, Array.from({ length: 35 }, (_, i) => new Date(old - i * 3_600_000).toISOString()));
  const t = commentThrottleFor(WS);
  assert.equal(t.weekUsed, 0);
  assert.equal(t.blockedReason, undefined);
});

check("switching the lane off blocks everything", async () => {
  hooks.setLimits(WS, { enabled: false, perDay: 8, perWeek: 35 });
  const t = commentThrottleFor(WS);
  assert.equal(t.enabled, false);
  assert.ok(t.blockedReason && /switched off/.test(t.blockedReason));
  hooks.setLimits(WS, { enabled: true, perDay: 8, perWeek: 35 });
});

check("the near-duplicate guard catches a reworded repeat", () => {
  const posted = "Licensing is usually the bottleneck on these searches, not the clinical bar itself.";
  const reworded = "Licensing is usually the bottleneck on searches like these, not really the clinical bar.";
  const different = "Curious whether you are open to candidates relocating, or holding to the local market.";
  assert.equal(hooks.tooSimilar(reworded, [posted]), true, "reworded repeat slipped through");
  assert.equal(hooks.tooSimilar(different, [posted]), false, "a genuinely different comment was rejected");
});

check("a week cap below the day base is raised, never left unreachable", async () => {
  const l = await setCommentLimits(WS, { perDay: 10, perWeek: 3 });
  assert.ok(l.perWeek >= l.perDay, `perWeek ${l.perWeek} below perDay ${l.perDay}`);
});

/* ---------------------------------------------------------------------- *
 * Reservation is not a send (2026-08-21).
 *
 * The lane counted a comment the moment the LinkedIn engine ACCEPTED it, and
 * accepted means reserved: the engine schedules the action into the seat's
 * working-hours window and posts it later. Three of five seats spent a day
 * showing a full posted count on the card with nothing on LinkedIn at all.
 * These pin the split so it cannot come back.
 * ---------------------------------------------------------------------- */

const SEAT = "seat_test_1";
const nowIso = (): string => new Date().toISOString();
const resetSeat = (): void => {
  hooks.setLog(`${WS}::${SEAT}`, []);
  hooks.setReservations(WS, SEAT, []);
  hooks.setEngineRoom(WS, SEAT, null);
};

check("a reservation counts as committed but never as sent", () => {
  resetSeat();
  hooks.setReservations(WS, SEAT, [nowIso(), nowIso(), nowIso()]);
  const t = commentThrottleFor(WS, SEAT);
  assert.equal(t.todaySent, 0, "a reserved comment was reported as posted");
  assert.equal(t.todayQueued, 3);
  assert.equal(t.todayUsed, 3, "reservations must still count against the day");
});

check("a confirmed send counts as sent and as committed", () => {
  resetSeat();
  hooks.setLog(`${WS}::${SEAT}`, [nowIso(), nowIso()]);
  const t = commentThrottleFor(WS, SEAT);
  assert.equal(t.todaySent, 2);
  assert.equal(t.todayQueued, 0);
  assert.equal(t.todayUsed, 2);
});

check("reservations and sends together fill the day, so the lane cannot over-commit", () => {
  resetSeat();
  hooks.setLimits(WS, { enabled: true, perDay: 4, perWeek: 40 });
  hooks.setLog(`${WS}::${SEAT}`, [new Date(Date.now() - 6 * 3_600_000).toISOString()]);
  hooks.setReservations(WS, SEAT, [
    new Date(Date.now() - 5 * 3_600_000).toISOString(),
    new Date(Date.now() - 4 * 3_600_000).toISOString(),
    new Date(Date.now() - 3 * 3_600_000).toISOString(),
  ]);
  const t = commentThrottleFor(WS, SEAT);
  assert.equal(t.todaySent, 1);
  assert.equal(t.todayQueued, 3);
  assert.ok(t.blockedReason, "1 sent + 3 reserved against an allowance of 4 must block");
  assert.ok(/waiting in the engine/.test(t.blockedReason ?? ""),
    `the block must say what is actually happening, got: ${t.blockedReason}`);
  hooks.setLimits(WS, { enabled: true, perDay: 8, perWeek: 35 });
});

check("the engine's daily target clamps the lane's own allowance", () => {
  resetSeat();
  hooks.setLimits(WS, { enabled: true, perDay: 16, perWeek: 110 });
  hooks.setEngineRoom(WS, SEAT, { target: 6, ceiling: 20, committed: 0 });
  const t = commentThrottleFor(WS, SEAT);
  assert.equal(t.todayAllowance, 6, `asked for 16 against an engine target of 6, got ${t.todayAllowance}`);
  hooks.setLimits(WS, { enabled: true, perDay: 8, perWeek: 35 });
});

check("the engine's target and ceiling each block, and say which", () => {
  resetSeat();
  hooks.setEngineRoom(WS, SEAT, { target: 10, ceiling: 20, committed: 10 });
  const atTarget = commentThrottleFor(WS, SEAT);
  assert.ok(/daily target reached/.test(atTarget.blockedReason ?? ""),
    `expected the engine target block, got: ${atTarget.blockedReason}`);

  hooks.setEngineRoom(WS, SEAT, { target: 10, ceiling: 20, committed: 20 });
  const atCeiling = commentThrottleFor(WS, SEAT);
  assert.ok(/hard ceiling/.test(atCeiling.blockedReason ?? ""),
    `expected the engine ceiling block, got: ${atCeiling.blockedReason}`);
  resetSeat();
});

check("with no engine reading yet, the lane falls back to its own allowance", () => {
  resetSeat();
  const t = commentThrottleFor(WS, SEAT);
  assert.ok(t.todayAllowance >= 1, "a cold mirror must not zero the allowance and jam the lane");
  assert.equal(t.blockedReason, undefined);
});

/* ---------------------------------------------------------------------- *
 * The indexed pre-read screen and the profile-view walls (2026-08-21).
 *
 * 83% of profile views were being spent to discover we did not want the
 * person, and the whole burst landed on one seat because the send rota only
 * moved when a draft was created. These pin the screen's precision (it may
 * only veto on positive evidence) and the read rota's spread.
 * ---------------------------------------------------------------------- */

check("no indexed profile behind the slug is a veto", () => {
  assert.ok(hooks.preReadVeto({ found: false }), "an unresolvable slug must not cost a profile view");
});

check("a recruiter headline is a veto, read off the index alone", () => {
  const v = hooks.preReadVeto({
    found: true,
    headline: "Technical Recruiter at Apex Staffing Solutions",
    snippet: "Helping clients hire top talent across the US.",
  });
  assert.ok(v, "an agency-side poster must be walled before the read, not after");
});

check("a real buyer is NOT vetoed", () => {
  assert.equal(hooks.preReadVeto({
    found: true,
    headline: "Chief Financial Officer at Redwood Manufacturing",
    snippet: "Finance leader scaling mid-market manufacturers.",
  }), null, "a CFO was walled before the read - the screen is over-vetoing");
});

check("a thin hint falls through to the read, never vetoes", () => {
  assert.equal(hooks.preReadVeto({ found: true }), null, "absence of evidence became a veto");
  assert.equal(hooks.preReadVeto({ found: true, headline: "" }), null);
  assert.equal(hooks.preReadVeto({ found: true, headline: "Lil Snack" }), null,
    "a bare company name is not evidence of anything and must fall through");
});

check("the read rota deals one view per seat, in turn", () => {
  hooks.resetViews();
  const seats = ["s1", "s2", "s3"].map((accountId) => ({ accountId } as never));
  for (const s of seats) hooks.setEngineRoom(WS, (s as { accountId: string }).accountId,
    { target: 10, ceiling: 20, committed: 0, views: { target: 60, ceiling: 70, committed: 0 } });
  const picked = [0, 1, 2, 3].map((i) => hooks.pickReadSeat(WS, seats, i));
  assert.deepEqual(picked.map((x) => (x as { accountId: string } | null)?.accountId), ["s1", "s2", "s3", "s1"],
    "consecutive reads must move across seats, not stack on one");
  for (const s of seats) hooks.setEngineRoom(WS, (s as { accountId: string }).accountId, null);
});

check("a seat out of profile-view room is skipped, and all-out stops the scan", () => {
  hooks.resetViews();
  const seats = ["s1", "s2"].map((accountId) => ({ accountId } as never));
  hooks.setEngineRoom(WS, "s1", { target: 10, ceiling: 20, committed: 0, views: { target: 5, ceiling: 70, committed: 5 } });
  hooks.setEngineRoom(WS, "s2", { target: 10, ceiling: 20, committed: 0, views: { target: 60, ceiling: 70, committed: 0 } });
  assert.equal((hooks.pickReadSeat(WS, seats, 0) as { accountId: string } | null)?.accountId, "s2",
    "a seat at its profile-view cap must be skipped");

  hooks.setEngineRoom(WS, "s2", { target: 10, ceiling: 20, committed: 0, views: { target: 5, ceiling: 70, committed: 5 } });
  assert.equal(hooks.pickReadSeat(WS, seats, 0), null, "no seat with room must end the scan, not borrow");
  for (const id of ["s1", "s2"]) hooks.setEngineRoom(WS, id, null);
});

check("views the lane spends itself count against the seat's room", () => {
  hooks.resetViews();
  const seats = [{ accountId: "s9" } as never];
  hooks.setEngineRoom(WS, "s9", { target: 10, ceiling: 20, committed: 0, views: { target: 3, ceiling: 70, committed: 0 } });
  assert.ok(hooks.seatMayRead(WS, "s9"));
  for (let i = 0; i < 3; i++) hooks.noteProfileView(WS, "s9");
  assert.equal(hooks.seatMayRead(WS, "s9"), false, "three views against a target of three must close the seat");
  assert.equal(hooks.pickReadSeat(WS, seats, 0), null);
  hooks.setEngineRoom(WS, "s9", null);
  hooks.resetViews();
});

check("with no engine mirror, reads are allowed exactly as before", () => {
  hooks.resetViews();
  assert.equal(hooks.seatMayRead(WS, "unknown_seat"), true, "a cold mirror must not block every read");
});

/* ---------------------------------------------------------------------- *
 * The voice (2026-08-21). The old rules literally instructed the model to
 * write "we keep seeing", and it opened nine of the last ten comments. These
 * pin the machine tells AND the thing that nearly shipped broken with them:
 * every spoken closing the new rules ask for failed the old INVITE_RE, and a
 * draft with no recognised invitation is DROPPED after one retry.
 * ---------------------------------------------------------------------- */

check("the machine tells are caught", () => {
  const tells = [
    "We keep seeing CFOs surprised by which one they actually get.",
    "Controllers with plant-floor fluency tend to sit inside mid-size manufacturers.",
    "In my experience the offer stage is where these stall.",
    "If a candid read on where those candidates sit would help, my inbox is open.",
    "Glad to compare notes, just say the word.",
  ];
  for (const t of tells) assert.ok(hooks.robotTellReason(t), `slipped through: ${t}`);
});

check("a comment that sounds spoken is not flagged", () => {
  const good = [
    "Medford's the whole search, not the title. Your pool is whoever's already inside a food plant within an hour. Want me to map it?",
    "Denver's thin for this one. The ones who move come out of PE-backed advisory. Want a couple of names?",
  ];
  for (const t of good) assert.equal(hooks.robotTellReason(t), null, `false positive: ${t}`);
});

check("a long comment with no contraction reads written, not spoken", () => {
  assert.ok(hooks.robotTellReason(
    "The comp band posted here narrows the pool before the search starts, because a finance leader who has navigated this cycle is priced above it today."));
});

check("SPOKEN closings count as invitations, or the new voice gets dropped", () => {
  const closings = [
    "Plant Controllers won't move for this. Want me to map who's actually in range?",
    "The ones who move come out of PE-backed advisory. Want a couple of names?",
    "FCF only wins after a margin scare. Curious what your board actually rewards.",
    "That line decides who applies. Happy to send how I'd word it.",
    "Two profiles apply and they look identical. Let me know if you want the question I use.",
    "Your real pool is smaller than the title suggests. I can send you the list if that helps.",
  ];
  for (const c of closings) {
    assert.ok(hooks.hasClosingInvite(c), `a valid spoken invitation was not recognised: ${c}`);
  }
});

check("an observation with no invitation at all is still refused", () => {
  assert.equal(hooks.hasClosingInvite(
    "Medford is the whole search here, not the title. Your pool is whoever is already inside a food plant."), false);
});

check("a long dash becomes a comma WITH its spacing", () => {
  // Live defect 2026-08-21: the bare swap produced "the model , it's".
  assert.equal(hooks.scrub("isn't the model \u2014 it's the assumptions"),
    "isn't the model, it's the assumptions");
  assert.equal(hooks.scrub("in New York \u2013 that conflict costs you"),
    "in New York, that conflict costs you");
  assert.equal(hooks.scrub("the model--the assumptions"), "the model, the assumptions");
  assert.ok(!/\s[,.;:!?]/.test(hooks.scrub("one \u2014 two \u2014 three")),
    "a space before punctuation survived scrub");
});

/* ---------------------------------------------------------------------- *
 * WHO IS THE POST ABOUT (2026-08-21).
 *
 * The live failure, verbatim: a recruiter told a technology journalist that
 * the comp bands in his article were compressing the candidate pool. He does
 * not hire anyone. The company he wrote about does, and never heard from us.
 * The intent score could not stop it - authority is a 15-point bonus out of
 * 100, so the post cleared the 60-point engage gate without it.
 * ---------------------------------------------------------------------- */

const AMBROOK_POST = "Exclusive: startup Ambrook has raised a $30M Series B led by Lachy Groom. "
  + "CEO Mackenzie Burnett tells Upstarts how she's bringing her expenses and bookkeeping software, "
  + "already a QuickBooks killer for farms, to more of the real economy, from general contractors to truckers. "
  + "Used by 8,000 farms and businesses, up from 2,500 a year ago.";

check("the journalist who wrote the funding story is walled", () => {
  const why = hooks.commentatorWall({
    title: "Founder and Editor",
    headline: "Founder and Editor of Upstarts Media",
    company: "Upstarts Media",
    postText: AMBROOK_POST,
  });
  assert.ok(why, "the exact live failure went through again");
  assert.ok(/reports on companies/.test(why ?? ""), `wrong reason: ${why}`);
});

check("the heat is filed against the company that raised, not the masthead", () => {
  assert.equal(hooks.subjectCompany(AMBROOK_POST), "Ambrook");
});

check("reporting grammar about someone else is walled even without a media title", () => {
  const why = hooks.commentatorWall({
    title: "Analyst",
    headline: "Analyst",
    company: "Someshop Research",
    postText: "Breaking: Northwind Logistics has raised a $40M Series C, according to people familiar.",
  });
  assert.ok(why, "third-party reporting slipped through");
});

check("a real buyer announcing their OWN news is never walled", () => {
  assert.equal(hooks.commentatorWall({
    title: "CFO",
    headline: "CFO at Redwood Manufacturing",
    company: "Redwood Manufacturing",
    postText: "We're hiring a Controller in Medford. Six-month contract to start, hands-on role.",
  }), null, "a genuine hiring post was walled");

  assert.equal(hooks.commentatorWall({
    title: "CEO",
    headline: "CEO at Ambrook",
    company: "Ambrook",
    postText: "We raised a $30M Series B and we're hiring across finance and ops.",
  }), null, "a founder announcing their own raise was walled");
});

check("an investor or partner title is NOT treated as press", () => {
  // A CFO at a fund is a real buyer; a false veto here costs a real lead.
  assert.equal(hooks.commentatorWall({
    title: "Partner",
    headline: "Partner at Cameron Ventures",
    company: "Cameron Ventures",
    postText: "We're growing the finance team and looking for a Controller.",
  }), null, "an investor was mistaken for a journalist");
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
