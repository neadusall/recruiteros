/*
 * News-signal discovery tests.
 *
 * The risk in this feature is concentrated in one place: pulling a real company name
 * out of a press headline. Everything downstream (dedupe, curation, the email) is only
 * as good as that extraction, and a wrong name means researching, emailing, and burning
 * a domain on a company that does not exist. So the bulk of these assertions are
 * adversarial headline shapes, including the ones that MUST yield nothing.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Point the durable store at a throwaway dir BEFORE anything imports lib/db, so the
// store tests never touch a real /data volume or a live Postgres.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ros-newssignals-"));
process.env.ROS_DATA_DIR = TMP;
delete process.env.DATABASE_URL;
process.env.SIGNAL_PITCH_AI = "0";   // keep the pitch tests deterministic and offline

const {
  extractCompany, extractFacts, parseAmount, buildReason, inferRoles,
  cleanHeadline, parseFeed, discoverFromNews, NEWS_SIGNALS, isRealRaise,
  isTitleCase, deTitleCase,
} = await import("../lib/signals/watch/newsDiscover");
const {
  composePitch, checkPitch, listPhrase, seatFor, observation, stakes,
  DEFAULT_PROFILE, profileComplete, saveDeskProfile, getDeskProfile,
  joinBeats, possessive,
} = await import("../lib/signals/watch/signalPitch");
const { companyKey } = await import("../lib/inmarket/jobFeed");
const { upsertWatchlist, listWatchlists } = await import("../lib/signals/watch/store");
const { classifyTitle } = await import("../lib/signals/filters");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}
function eq(actual: unknown, expected: unknown, name: string) {
  ok(actual === expected, name, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/* ------------------------------------------------------------------ */
/* 1. Headline cleaning                                                */
/* ------------------------------------------------------------------ */

eq(cleanHeadline("FleetLogs raises $60M - TechCrunch").text, "FleetLogs raises $60M", "strips Google News publisher suffix");
eq(cleanHeadline("FleetLogs raises $60M - TechCrunch").publisher, "TechCrunch", "captures the publisher");
eq(cleanHeadline("Exclusive: Freehand closes $30M").text, "Freehand closes $30M", "strips an Exclusive: tag");
eq(cleanHeadline("Breaking - Auger lands $90M").text, "Auger lands $90M", "a leading tag written with a dash is stripped as a tag, not read as a publisher");
eq(cleanHeadline("Breaking - Auger lands $90M").publisher, undefined, "a leading tag is never mistaken for the publisher");
eq(extractCompany("Breaking - Auger lands $90M"), "Auger", "and the company still extracts through it");
eq(cleanHeadline("Nimbus raises $5M - up 3x from last year").text, "Nimbus raises $5M - up 3x from last year", "numeric tail is content, not a publisher");

/* ------------------------------------------------------------------ */
/* 2. Company extraction — the shapes that MUST work                   */
/* ------------------------------------------------------------------ */

eq(extractCompany("FleetLogs raises $60M Series B to scale AI truck intelligence - TechCrunch"), "FleetLogs", "subject before raise verb");
eq(extractCompany("Supply chain startup Auger lands $90M led by Eclipse Ventures"), "Auger", "strips descriptor prefix");
eq(extractCompany("Exclusive: Freehand closes $30M Series B"), "Freehand", "strips exclusive tag then extracts");
eq(extractCompany("Battery Ventures leads $60M round in FleetLogs"), "FleetLogs", "investor-first shape takes the object");
eq(extractCompany("Acme Logistics Inc. secures $12M seed round"), "Acme Logistics", "drops the corporate suffix");
eq(extractCompany("Tilley appoints new chief revenue officer"), "Tilley", "exec-hire verb");
eq(extractCompany("AI-powered logistics platform Nimbus expands into Europe"), "Nimbus", "multi-word descriptor prefix");
eq(extractCompany("After a rocky year, Auger raises $90M"), "Auger", "lowercase lead-in does not glue onto the name");
eq(extractCompany("Verla Health raised $40 million to expand clinical staffing"), "Verla Health", "two-token proper name survives");

/* ------------------------------------------------------------------ */
/* 3. Company extraction — the shapes that MUST yield NOTHING          */
/* ------------------------------------------------------------------ */

eq(extractCompany("Eclipse Ventures raises $500M fund"), "", "a fund closing its own fund is not a lead");
eq(extractCompany("Sequoia Capital closes $2B growth fund"), "", "second fund-close shape rejected");
eq(extractCompany("They raised $10M last week"), "", "pronoun subject rejected");
eq(extractCompany("Raises abound in logistics this quarter"), "", "verb leading the headline has no subject");
eq(extractCompany("5 startups that raised big this month"), "", "listicle subject rejected");
eq(extractCompany(""), "", "empty headline is safe");
eq(extractCompany("the startup raised $4M"), "", "all-lowercase subject rejected");

/* ------------------------------------------------------------------ */
/* 3b. Regressions found on LIVE Google News headlines                 */
/* ------------------------------------------------------------------ */

// The appositive miss. This is a real headline and Auger is a real target; the
// "led by ..." aside pushed the proper-noun tail past the name and yielded nothing.
eq(extractCompany("Supply chain startup Auger, led by ex-Amazon operations chief, raises $50M and lands big customers - geekwire.com"),
   "Auger", "appositive clause does not hide the subject");
eq(extractCompany("After years in stealth, Nimbus Freight, backed by a16z, raises $20M"),
   "Nimbus Freight", "first clause wins over a later aside");

// Nationality words are part of real names. A blanket descriptor strip invented
// a company called "National Railway".
eq(extractCompany("Canadian National Railway raises its 2026 volume outlook"), "Canadian National Railway",
   "a nationality word inside a real name is kept");
eq(extractCompany("Israeli logistics startup Zim Labs raises $8M"), "Zim Labs",
   "but a nationality word IS stripped when a hard descriptor follows it");
eq(extractCompany("US logistics firm Redwood secures $40M"), "Redwood", "same rule, different prefix");

// Possessive localization split one company into two leads.
eq(extractCompany("Fort Worth's Conner Industries Names Retired General Blaine Holt to Board"),
   "Conner Industries", "possessive geographic prefix is stripped");
eq(companyKey(extractCompany("Fort Worth's Conner Industries Names Blaine Holt to Board")),
   companyKey("Conner Industries appoints Blaine D. Holt to board".split(" appoints")[0]),
   "so both outlets' versions collapse to ONE company key");

// "Raises" is overloaded. None of these are capital events.
ok(!isRealRaise("Canadian National Railway raises its 2026 volume outlook as freight demand firms"), "raising an outlook is not a raise");
ok(!isRealRaise("Acme raises prices on freight rates"), "raising prices is not a raise");
ok(!isRealRaise("Report raises concerns about supply chain software"), "raising concerns is not a raise");
ok(!isRealRaise("Maersk raises its full-year guidance"), "raising guidance is not a raise");
ok(isRealRaise("Freehand Raises $75M Series B To Automate Fortune 500 Supply Chain Spend"), "a dollar figure is a raise");
ok(isRealRaise("Auger raises funding to expand"), "explicit funding language with no figure is still a raise");
ok(isRealRaise("Nimbus closes seed round"), "a named round with no figure is a raise");

// A purpose clause must be a purpose, not an appointment target.
eq(extractFacts("Connor Industries appoints Blaine D. Holt to board of directors").purpose, undefined,
   "an appointment target is not read as a purpose clause");
eq(extractFacts("Freehand raises $75 mn to scale supply chain AI agents").purpose, "scale supply chain AI agents",
   "a real purpose clause still parses");

// Title Case lifted into the middle of a sentence is an instant automation tell.
ok(isTitleCase("Freehand Raises $75M Series B To Automate Fortune 500 Supply Chain Spend"), "title-case headline detected");
ok(!isTitleCase("Freehand raises $75 mn to scale supply chain AI agents"), "sentence-case headline is not title case");
eq(deTitleCase("Automate Fortune 500 Supply Chain Spend"), "automate Fortune 500 supply chain spend",
   "de-title-case keeps a proper noun that qualifies a number");
eq(deTitleCase("Bring AI Automation to Freight Forwarding"), "bring AI automation to freight forwarding",
   "de-title-case keeps acronyms");
eq(extractFacts("Freehand Raises $75M Series B To Automate Fortune 500 Supply Chain Spend").purpose,
   "automate Fortune 500 supply chain spend", "a title-case purpose is normalized to prose");
eq(extractFacts("Freehand raises $75 mn to scale supply chain AI agents").purposeFromProse, true,
   "a sentence-case purpose is flagged as prose");
ok(!/ To | Automate | Supply Chain /.test(
     buildReason("funding_round", extractFacts("Freehand Raises $75M Series B To Automate Fortune 500 Supply Chain Spend"), "x")),
   "the reason line reads as prose, not as a headline");

// Board and leadership-team announcements get their own honest wording.
eq(buildReason("exec_hire", extractFacts("Conner Industries Appoints Blaine D. Holt to Board of Directors"), "x"),
   "just added a new board member", "a board seat is described as a board seat");
eq(buildReason("exec_hire", extractFacts("LSP44 Names Leadership Team Built From Inside the Operations It Serves"), "x"),
   "just expanded its leadership team", "a leadership-team addition is described as one");

/* ------------------------------------------------------------------ */
/* 4. Amount + fact parsing                                            */
/* ------------------------------------------------------------------ */

eq(parseAmount("raises $60M Series B").amountUsd, 60_000_000, "$60M parses");
eq(parseAmount("raises $60M Series B").amountText, "$60M", "$60M renders short");
eq(parseAmount("raised $1.2 billion").amountUsd, 1_200_000_000, "$1.2 billion parses");
eq(parseAmount("secured €45 million").amountUsd, 45_000_000, "euro amount parses at face value");
eq(parseAmount("hiring 60 people").amountUsd, undefined, "a bare number is not an amount");

const f1 = extractFacts("FleetLogs raises $60M Series B led by Battery Ventures to scale AI truck intelligence");
eq(f1.round, "Series B", "round parsed and normalized");
eq(f1.investor, "Battery Ventures", "lead investor parsed");
eq(f1.purpose, "scale AI truck intelligence", "purpose clause parsed");
eq(extractFacts("Auger closes seed round").round, "seed", "seed stays lowercase");
eq(extractFacts("Tilley names new chief revenue officer").execTitle, "chief revenue officer", "exec title parsed");

/* ------------------------------------------------------------------ */
/* 5. The reason line — this string becomes the email's Signal:        */
/* ------------------------------------------------------------------ */

const reason1 = buildReason("funding_round", f1, "FleetLogs raises $60M Series B led by Battery Ventures to scale AI truck intelligence");
eq(reason1, "just closed a $60M Series B led by Battery Ventures to scale AI truck intelligence", "full funding reason reads as a sentence");
ok(!/[–—]/.test(reason1), "reason carries no em or en dash (product-wide copy rule)");
ok(!/undefined|null|NaN/.test(reason1), "reason never leaks a placeholder");

const reasonBare = buildReason("funding_round", {}, "Auger raises funding");
eq(reasonBare, "just closed a new round", "reason degrades cleanly with no facts");
ok(!/[–—]/.test(buildReason("exec_hire", { execTitle: "CRO" }, "x")), "exec reason carries no dash");

for (const s of NEWS_SIGNALS) {
  const r = buildReason(s, {}, "Some Co does a thing");
  ok(r.length > 5 && !/[–—]/.test(r) && !/undefined/.test(r), `every signal type yields a clean reason: ${s}`);
}

/* ------------------------------------------------------------------ */
/* 6. Role synthesis — must give curateFromPool DISTINCT functions     */
/* ------------------------------------------------------------------ */

const roles1 = inferRoles("FleetLogs raises $60M to scale AI truck intelligence", f1);
ok(roles1.length === 3, "three roles inferred", roles1);
const fns = new Set(roles1.map((r) => classifyTitle(r).function));
eq(fns.size, 3, "the three roles classify into three DISTINCT functions (three decision-makers)");
ok(roles1.length > 0, "a funding headline always yields at least one role (curateFromPool drops roleless leads)");

const roles2 = inferRoles("Anything at all", {}, ["Director of Operations", "Plant Manager"]);
eq(roles2.join("|"), "Director of Operations|Plant Manager", "recruiter targetRoles override the inference");

const rolesEmpty = inferRoles("Quiet headline with no cues", {});
ok(rolesEmpty.length === 3, "a cue-less headline still gets the default build-out", rolesEmpty);

/* ------------------------------------------------------------------ */
/* 7. Company key parity — one company must not be pitched twice       */
/* ------------------------------------------------------------------ */

eq(companyKey("FleetLogs"), "jobfeed_fleetlogs", "company key keeps the historical namespace");
eq(companyKey("Acme Logistics"), companyKey("acme  logistics!"), "key normalizes punctuation and case");
ok(companyKey("FleetLogs").startsWith("jobfeed_"), "news leads land in the SAME seen-set namespace as job-feed leads");

/* ------------------------------------------------------------------ */
/* 8. Feed parsing                                                     */
/* ------------------------------------------------------------------ */

const xml = `<rss><channel>
<item><title>FleetLogs raises $60M Series B</title><link>https://x.test/1</link><pubDate>Tue, 04 Aug 2026 10:00:00 GMT</pubDate><source url="u">TechCrunch</source></item>
<item><title>Auger &amp; Co lands $90M</title><link>https://x.test/2</link></item>
<item><title>no link here</title></item>
</channel></rss>`;
const items = parseFeed(xml);
eq(items.length, 2, "items without a link are dropped");
eq(items[0].title, "FleetLogs raises $60M Series B", "title parsed");
eq(items[1].title, "Auger & Co lands $90M", "entities decoded");
eq(items[0].publisher, "TechCrunch", "source element parsed");
eq(parseFeed("").length, 0, "garbage XML yields no items, never throws");
eq(parseFeed("<html>not rss</html>").length, 0, "non-RSS yields no items");

/* ------------------------------------------------------------------ */
/* 9. Discovery guards (no network)                                    */
/* ------------------------------------------------------------------ */

const noSeg = await discoverFromNews({ segment: "  " });
eq(noSeg.leads.length, 0, "an empty segment discovers nothing");
ok(noSeg.warnings.length > 0, "an empty segment explains itself");

const timeboxed = await discoverFromNews({ segment: "supply chain software", timeboxMs: 3_000, limit: 1 });
ok(Array.isArray(timeboxed.leads), "discovery always returns an array, even when the feed is unreachable");
ok(timeboxed.leads.length <= 1, "limit is honored");

/* ------------------------------------------------------------------ */
/* 10. The pitch — the five beats                                      */
/* ------------------------------------------------------------------ */

eq(listPhrase(["distribution", "warehousing", "logistics"]), "distribution, warehousing, and logistics", "three-item list reads naturally");
eq(listPhrase(["distribution", "logistics"]), "distribution and logistics", "two-item list");
eq(listPhrase([]), "", "empty list is empty");
eq(seatFor(["Operations Manager"]), "operations", "seat derived from the inferred role");
eq(seatFor(["Account Executive"]), "revenue", "sales role maps to a revenue seat");
eq(seatFor([]), "leadership", "no role falls back to leadership");

const lazio = {
  firmName: "Lazio",
  verticals: ["distribution", "warehousing", "logistics"],
  placesTitles: "the operations and supply chain leaders we bring",
  domainDifficulty: "regulated, complex product handling",
  positioning: "We work as an embedded partner, not a resume vendor.",
  ctaMinutes: 15,
};
const pitch = composePitch({
  firstName: "Graham",
  company: "Tilley",
  reason: "is carrying more open operations roles than it has in months",
  segment: "chemical distribution",
  signal: "funding_round",
  roles: ["Operations Manager"],
  profile: lazio,
});

ok(pitch.body.startsWith("Graham, Tilley is carrying more open operations roles"), "beat 1 opens on the name and the observation", pitch.body.slice(0, 60));
ok(pitch.body.includes("chemical distribution is not a space where you can drop just anyone into an operations seat"), "beat 2 names the segment and the seat");
ok(pitch.body.includes("Lazio recruits into distribution, warehousing, and logistics"), "beat 3 states the matching specialization");
ok(pitch.body.includes("regulated, complex product handling"), "beat 3 carries the domain difficulty");
ok(pitch.body.includes("We work as an embedded partner, not a resume vendor."), "beat 4 is the positioning line");
ok(pitch.body.includes("Worth 15 minutes"), "beat 5 is time-boxed");
ok(pitch.body.trim().endsWith("?"), "the email ends on a question");
ok(!/[–—]/.test(pitch.body), "pitch carries no em or en dash");
ok(!/\{\{|\}\}/.test(pitch.body), "pitch leaves no unrendered token");
ok(!/undefined|NaN/.test(pitch.body), "pitch leaks no placeholder");
eq(pitch.source, "template", "template is the deterministic floor");
ok(pitch.subject.includes("Tilley"), "subject names the company", pitch.subject);

const anon = composePitch({
  company: "Tilley", reason: "just closed a $60M Series B", segment: "chemical distribution",
  signal: "funding_round", roles: ["Operations Manager"], profile: lazio,
});
ok(anon.body.startsWith("Tilley just closed"), "no first name means no fake greeting", anon.body.slice(0, 40));

const bare = composePitch({
  company: "Tilley", reason: "just closed a $60M Series B", segment: "chemical distribution",
  signal: "funding_round", roles: ["Operations Manager"], profile: DEFAULT_PROFILE,
});
ok(!/undefined/.test(bare.body), "an unconfigured desk still renders a clean email");
ok(!bare.body.includes("recruits into ,"), "an unconfigured desk never renders an empty vertical list", bare.body);
eq(profileComplete(DEFAULT_PROFILE), false, "the default profile is not complete");
eq(profileComplete(lazio), true, "a filled profile is complete");

/* ---- copy defects caught by composing against LIVE discovered leads ---- */

// Two "and" clauses in one sentence read as a run-on.
eq(joinBeats("Acme just raised", "the market is hard"), "Acme just raised, and the market is hard", "single-clause stakes joins with and");
eq(joinBeats("Acme just raised", "a new leader rebuilds, and the market is hard"),
   "Acme just raised. A new leader rebuilds, and the market is hard",
   "a stakes line that already has an and becomes its own sentence");
const runOn = composePitch({
  company: "Freehand", reason: "just closed a $75M Series B", segment: "supply chain software",
  signal: "funding_round", roles: ["Operations Manager"], profile: lazio,
});
ok((runOn.body.split("\n\n")[0].match(/, and /g) ?? []).length <= 1, "the opening sentence never carries two and-clauses", runOn.body.split("\n\n")[0]);

// Possessive of a name ending in s.
eq(possessive("Freehand"), "Freehand's", "normal possessive");
eq(possessive("Conner Industries"), "Conner Industries'", "a trailing s takes the bare apostrophe");
ok(!composePitch({
  company: "Conner Industries", reason: "just added a new board member", segment: "supply chain software",
  signal: "exec_hire", roles: ["Account Executive"], profile: lazio,
}).subject.includes("Industries's"), "subject never writes Industries's");

// A board seat is not an operating hire.
const boardPitch = composePitch({
  company: "Conner Industries", reason: "just added a new board member", segment: "supply chain software",
  signal: "exec_hire", roles: ["Account Executive"], facts: { appointmentKind: "board" }, profile: lazio,
});
ok(!boardPitch.body.includes("rebuild the bench underneath them"), "a board appointment is not described as rebuilding a bench", boardPitch.body);
ok(!boardPitch.body.includes("under the new leader"), "and the ask does not assume a new operating leader");
const execPitch = composePitch({
  company: "Tilley", reason: "just brought in a new chief revenue officer", segment: "chemical distribution",
  signal: "exec_hire", roles: ["Account Executive"], profile: lazio,
});
ok(execPitch.body.includes("rebuild the bench underneath them"), "a real exec hire still gets the bench framing");

/* ------------------------------------------------------------------ */
/* 11. Pitch hygiene gate — what the AI pass may not do                */
/* ------------------------------------------------------------------ */

const pin = {
  company: "Tilley", reason: "x", segment: "chemical distribution",
  signal: "funding_round" as const, roles: ["Operations Manager"], profile: lazio,
};
ok(checkPitch(pitch.body, pin).ok, "the template pitch passes its own gate", checkPitch(pitch.body, pin).problems);
ok(!checkPitch("", pin).ok, "empty body rejected");
ok(!checkPitch(pitch.body.replace("months, and", "months — and"), pin).ok, "an em dash is rejected");
ok(!checkPitch(pitch.body.replace("Tilley", "Acme"), pin).ok, "dropping the company name is rejected");
ok(!checkPitch(pitch.body.replace("?", "."), pin).ok, "losing the question is rejected");
ok(!checkPitch("Too short.", pin).ok, "a too-short rewrite is rejected");
ok(!checkPitch(`${pitch.body} I have a candidate ready for you now.`, pin).ok, "claiming a candidate in hand is rejected");
ok(!checkPitch(`${pitch.body} {{firstName}}`, pin).ok, "an unrendered merge token is rejected");
ok(!checkPitch(pitch.body + " " + "word ".repeat(120), pin).ok, "a too-long rewrite is rejected");

/* ------------------------------------------------------------------ */
/* 12. Store: news lists persist, old rows keep their behavior         */
/* ------------------------------------------------------------------ */

const jobList = await upsertWatchlist("ws_test", { name: "Old style", query: "VP Sales" });
eq(jobList.source, "jobs", "a list saved without a source defaults to jobs (back-compat)");

const newsList = await upsertWatchlist("ws_test", {
  name: "Supply chain raises",
  source: "news",
  segment: "supply chain software",
  newsSignals: ["funding_round", "exec_hire", "funding_round"],
  newsWindowDays: 14,
  minAmountUsd: 5_000_000,
  targetRoles: ["Director of Operations"],
});
eq(newsList.source, "news", "a news list persists its source");
eq(newsList.segment, "supply chain software", "segment persists");
eq(newsList.newsSignals?.length, 2, "duplicate signals are collapsed");
eq(newsList.newsWindowDays, 14, "window persists");
eq(newsList.minAmountUsd, 5_000_000, "minimum raise persists");
eq(newsList.targetRoles?.join(), "Director of Operations", "target roles persist");

const clamped = await upsertWatchlist("ws_test", { name: "Clamp me", source: "news", segment: "x", newsWindowDays: 9999 });
eq(clamped.newsWindowDays, 90, "an absurd window is clamped, not accepted");

const zeroFloor = await upsertWatchlist("ws_test", { name: "No floor", source: "news", segment: "x", minAmountUsd: 0 });
eq(zeroFloor.minAmountUsd, undefined, "a zero floor means no floor, not a broken filter");

const mine = await listWatchlists("ws_test");
ok(mine.length >= 4, "lists are scoped and retrievable", mine.length);
eq((await listWatchlists("ws_other")).length, 0, "another workspace sees none of them");

/* ---- desk profile round-trips per workspace ---- */
await saveDeskProfile("ws_test", lazio);
const back = await getDeskProfile("ws_test");
eq(back.firmName, "Lazio", "desk profile round-trips");
eq(back.verticals.join(), "distribution,warehousing,logistics", "verticals round-trip");
eq((await getDeskProfile("ws_untouched")).firmName, DEFAULT_PROFILE.firmName, "an unconfigured workspace gets defaults, not a crash");
eq((await saveDeskProfile("ws_test", { ctaMinutes: 999 })).ctaMinutes, 15, "an out-of-range CTA falls back to the default");

/* ------------------------------------------------------------------ */

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
