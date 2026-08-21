/**
 * Post Recruiter, exercised against the real module.
 *
 * What this proves, in order of how expensive the bug would have been:
 *   - the activity-id date decode is right (it is the ONLY post-freshness gate,
 *     and a wrong shift silently passes every stale post),
 *   - the seller wall actually catches the recruiters and coaches that make up
 *     nine of every ten false positives in this lane,
 *   - copy can never imply we know somebody was laid off, and never carries a
 *     link, an address or an em-dash,
 *   - a connect note is trimmed to LinkedIn's ceiling on a sentence boundary,
 *   - the per-seat day and week walls hold, and the send seat is dealt on share
 *     of its own allowance rather than raw room.
 *
 * Run: npx tsx scripts/test-post-recruiter.mts
 */
import assert from "node:assert";
import {
  limitsFor, __postRecruiterTestHooks as h,
} from "../lib/linkedin/postRecruiter";

const WS = "ws_pr_test";
let failures = 0;
function check(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error("use checkAsync for async cases");
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

console.log("post recruiter");

/* ---------------- activity id -> date ---------------- */

check("activity ids decode to their real publish date", () => {
  // Every one of these was checked against the live post in August 2026.
  // Yasmine's body read "On Monday, June 29, 2026 I officially passed the BCBA
  // examination"; the id decodes two days later, which is when she posted it.
  const cases: Array<[string, string]> = [
    ["7477903689786023937", "2026-07-01"],
    ["7454083804182523905", "2026-04-26"],
    ["7305911761780523008", "2025-03-13"],
    ["6699406109066739713", "2020-08-12"],
    ["7204511535593836545", "2024-06-06"],
  ];
  for (const [id, expected] of cases) {
    const d = h.activityDate(id);
    assert.ok(d, `${id} did not decode`);
    assert.equal(d!.toISOString().slice(0, 10), expected, `${id} decoded to ${d!.toISOString()}`);
  }
});

check("garbage ids decode to null rather than a plausible date", () => {
  for (const bad of ["", "123", "notanid", "0", "99999999999999999999999"]) {
    assert.equal(h.activityDate(bad), null, `"${bad}" should not decode`);
  }
});

check("a decoded date is never in the future", () => {
  // A wrong bit shift shows up here first: shift too far the wrong way and
  // every post lands centuries out, which would pass a naive age check.
  const d = h.activityDate("7477903689786023937");
  assert.ok(d && d.getTime() <= Date.now(), "decoded a future date");
});

/* ---------------- the seller wall ---------------- */

check("the seller wall catches the people who hijack #opentowork", () => {
  // Every one of these is a real headline from the live 2026-08-21 sample that
  // came back under an #opentowork or open-to-work query and is NOT a candidate.
  const sellers = [
    "Principal Technical Recruiter | Talent Acquisition",
    "Executive Climate & Tech Career Coach",
    "I hire SDRs",
    "Helping candidates land roles | Staffing",
    "#1 AI & Automation Thought Leader",
    "Resume writer and job coach",
  ];
  for (const s of sellers) {
    assert.ok(h.sellerReason({ headline: s }), `should have been walled: ${s}`);
  }
});

check("the seller wall does not eat real candidates", () => {
  const candidates = [
    "Board Certified Behavior Analyst (BCBA) | Multilingual",
    "Principal Software Engineer | AI Systems Architect",
    "Speech-Language Pathologist specializing in AAC",
    "Revenue, partnerships and events leader across nonprofit and corporate",
    "M.Ed., BCBA, LBA",
  ];
  for (const s of candidates) {
    assert.equal(h.sellerReason({ headline: s }), null, `should have passed: ${s}`);
  }
});

check("job adverts wearing the hashtag are rejected on the post text", () => {
  assert.ok(h.sellerPostReason("We are hiring a BCBA in Dallas, apply now! #opentowork"));
  assert.ok(h.sellerPostReason("My client is looking for a Clinical Director. DM me your resume."));
  assert.equal(
    h.sellerPostReason("After four years I am back on the market and looking for my next BCBA role."),
    null,
  );
});

check("seeker language recognises how people actually write it", () => {
  const real = [
    "I am #OpenToWork after my position was eliminated last month.",
    "Recently laid off and actively seeking a new opportunity in Dallas.",
    "Looking for my next role as a Speech Language Pathologist.",
    "Impacted by the recent layoffs, would appreciate any leads.",
  ];
  for (const t of real) assert.ok(h.SEEKER_RE.test(t), `not recognised: ${t}`);
  assert.equal(h.SEEKER_RE.test("Great week for the team, we shipped the new release."), false);
});

/* ---------------- copy guards ---------------- */

check("copy can never imply we know they were laid off", () => {
  // The standing rule for this lane. The flag says "open to new roles"; it does
  // not say why, and guessing reads as surveillance to the one person least
  // able to shrug it off.
  const banned = [
    "Sorry to hear you were laid off, I have a role that might suit.",
    "Saw you were let go from Acme, let's talk.",
    "Now that you are between jobs, here is an opening.",
    "I know the redundancies hit your team hard.",
  ];
  for (const t of banned) {
    assert.ok(h.copyLeakReason(t), `should have been blocked: ${t}`);
  }
});

check("copy carrying a link, address or number is blocked", () => {
  assert.ok(h.copyLeakReason("Details at https://example.com/role"));
  assert.ok(h.copyLeakReason("Email me at ryan@lumesp.com"));
  assert.ok(h.copyLeakReason("Call me on 555 123 4567"));
  assert.ok(h.copyLeakReason("Grab a slot on my calendly"));
});

check("a clean note passes", () => {
  assert.equal(
    h.copyLeakReason("Hi Kelly, I saw you're open to new roles. I run a BCBA desk and have a search live in Savannah."),
    null,
  );
});

check("em-dashes never survive into outbound copy", () => {
  // House rule, and one the model reintroduces every time it writes a sentence.
  const folded = h.fold("Hi Kelly — I run a BCBA desk — happy to help.");
  assert.equal(folded.indexOf("—"), -1, folded);
  assert.equal(folded.indexOf("–"), -1, folded);
  assert.equal(h.fold("one -- two").indexOf("--"), -1);
});

check("a long note is trimmed on a sentence boundary, never mid-word", () => {
  const long = "Hi Kelly, I saw you are open to new roles. I run a Board Certified Behavior Analyst desk "
    + "and I have a search live in the Savannah area right now. It is a clinical leadership seat with a "
    + "caseload cap and a supervision budget, which is usually the part people ask about first.";
  const out = h.fit(long, 120);
  assert.ok(out, "returned nothing");
  assert.ok(out!.length <= 120, `too long: ${out!.length}`);
  assert.ok(/[.?!]$/.test(out!) || !/\s$/.test(out!), `ragged trim: "${out}"`);
  assert.ok(!out!.endsWith(" "), "trailing space");
});

/* ---------------- identity + dedupe ---------------- */

check("the same person resolves to one key however they were found", () => {
  const fromSearch = h.personKey({ slug: "kelly-adams-249456182", name: "Kelly Adams" });
  const fromPostUrl = h.personKey({ profileUrl: "https://www.linkedin.com/in/kelly-adams-249456182", name: "Kelly Adams" });
  assert.equal(fromSearch, fromPostUrl);
});

/* ---------------- fit scoring ---------------- */

check("fit rewards the title and the credential the desk asked for", () => {
  const hunt = {
    id: "h1", workspaceId: WS, label: "BCBA", keywords: "BCBA",
    titles: ["Board Certified Behavior Analyst"], credentials: ["BCBA"],
    active: true, createdAt: "", cursor: 0, screened: 0, reads: 0, confirmed: 0,
  };
  const strong = h.scoreFit(hunt, {
    headline: "Board Certified Behavior Analyst (BCBA)", credentials: ["BCBA"],
  });
  const weak = h.scoreFit(hunt, { headline: "Marketing Manager", credentials: [] });
  assert.ok(strong.fit >= 70, `strong scored ${strong.fit}`);
  assert.ok(weak.fit < 40, `weak scored ${weak.fit}`);
  assert.ok(strong.why.length > 0, "no reasons given");
});

check("a missing credential the desk demands pulls the score down", () => {
  const hunt = {
    id: "h2", workspaceId: WS, label: "RN", keywords: "nurse",
    titles: ["Registered Nurse"], credentials: ["RN"],
    active: true, createdAt: "", cursor: 0, screened: 0, reads: 0, confirmed: 0,
  };
  const titled = h.scoreFit(hunt, { headline: "Registered Nurse", credentials: [] });
  const both = h.scoreFit(hunt, { headline: "Registered Nurse", credentials: ["RN"] });
  assert.ok(both.fit > titled.fit, "credential added nothing");
});

/* ---------------- throttle ---------------- */

check("limits default to the documented numbers", () => {
  h.reset();
  const l = limitsFor(WS);
  assert.ok(l.perDay >= 1 && l.perDay <= 40);
  // The week must clear several days of the daily number, or the week silently
  // becomes the real limit instead of the day.
  assert.ok(l.perWeek >= l.perDay * 4, `week ${l.perWeek} vs day ${l.perDay}`);
});

check("the per-seat day allowance jitters but stays in band", () => {
  h.reset();
  const seen = new Set<number>();
  for (const d of ["2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22"]) {
    const a = h.allowanceFor(WS, "seat_a", d);
    seen.add(a);
    assert.ok(a >= 9 && a <= 15, `${d} allowance ${a} outside the +/-15% band of 12`);
  }
  assert.ok(seen.size > 1, "allowance never varied, so the jitter is dead");
});

check("two seats on the same day draw different allowances", () => {
  h.reset();
  const a = h.allowanceFor(WS, "seat_a", "2026-08-21");
  const b = h.allowanceFor(WS, "seat_b", "2026-08-21");
  const c = h.allowanceFor(WS, "seat_c", "2026-08-21");
  assert.ok(new Set([a, b, c]).size > 1, "every seat drew the same number");
});

check("the day wall holds and counts only CONFIRMED sends", () => {
  h.reset();
  const d = new Date().toISOString().slice(0, 10);
  const allowance = h.allowanceFor(WS, "seat_a", d);
  const st = h.state();
  st.sendLog[`${WS}::seat_a`] = Array.from({ length: allowance }, () => new Date().toISOString());
  assert.equal(h.seatRoom(WS, "seat_a"), 0, "a full seat still had room");
  st.sendLog[`${WS}::seat_a`] = [];
  assert.ok(h.seatRoom(WS, "seat_a") > 0, "an empty seat had no room");
});

check("queued reservations count against room, so the lane cannot over-commit", () => {
  h.reset();
  const st = h.state();
  const before = h.seatRoom(WS, "seat_a");
  st.leads.push({
    id: "l1", workspaceId: WS, huntId: "h1", accountId: "seat_a", name: "Test",
    credentials: [], openProfile: false, canInMail: false, source: "search",
    evidence: "", fit: 50, fitWhy: [], channel: "connect", status: "queued",
    createdAt: new Date().toISOString(),
  } as never);
  assert.equal(h.seatRoom(WS, "seat_a"), before - 1, "a reservation did not consume room");
});

check("the weekly ceiling is hard even when the day is clear", () => {
  h.reset();
  const st = h.state();
  // Written straight into state, not through setLimits: setLimits awaits
  // hydrate, so its effect lands a microtask later and this synchronous check
  // would read the old numbers and pass for the wrong reason.
  st.limits[WS] = { perDay: 12, perWeek: 20 };
  // Twenty sends spread over the last six days: today is empty, the week is not.
  st.sendLog[`${WS}::seat_a`] = Array.from({ length: 20 },
    (_, i) => new Date(Date.now() - (i % 6 + 1) * 86_400_000).toISOString());
  assert.equal(h.seatRoom(WS, "seat_a"), 0, "the week wall let a 21st through");
});

check("the send seat is dealt on share of its own allowance, not raw room", () => {
  h.reset();
  const d = new Date().toISOString().slice(0, 10);
  const st = h.state();
  const seats = ["seat_a", "seat_b"].map((accountId) => ({ accountId } as never));
  // Give the seat with the BIGGER allowance more sends already, so it has more
  // raw room left but a smaller share. Dealing on raw room picks it and starves
  // the other seat, which is the bug this replaced.
  const aA = h.allowanceFor(WS, "seat_a", d);
  const aB = h.allowanceFor(WS, "seat_b", d);
  const [big, small] = aA >= aB ? ["seat_a", "seat_b"] : ["seat_b", "seat_a"];
  st.sendLog[`${WS}::${big}`] = [new Date().toISOString()];
  const picked = h.pickSendSeat(WS, seats as never);
  assert.ok(picked, "no seat picked");
  assert.equal((picked as { accountId: string }).accountId, small,
    "picked the seat that had already sent");
});

check("a seat with no room is never picked", () => {
  h.reset();
  const d = new Date().toISOString().slice(0, 10);
  const st = h.state();
  for (const s of ["seat_a", "seat_b"]) {
    st.sendLog[`${WS}::${s}`] = Array.from({ length: h.allowanceFor(WS, s, d) }, () => new Date().toISOString());
  }
  assert.equal(h.pickSendSeat(WS, [{ accountId: "seat_a" }, { accountId: "seat_b" }] as never), null);
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
