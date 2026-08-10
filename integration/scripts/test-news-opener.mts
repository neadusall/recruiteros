/* The news arm must never send a candidate pitch, and must never send filler.
 *
 * This is the regression guard for the gap that made the whole feature inert: signalPitch
 * composed a good email that nothing called, so a news prospect received the Day-0 MPC
 * opener — "I met someone sharper for your Operations Manager seat" — about a role the
 * company never posted. Everything here asserts the routing, not the prose.
 *
 * Run: npx tsx scripts/test-news-opener.mts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prospect } from "../lib/core/types";

// The desk profile is PERSISTED, and the send gate reads it back. With no snapshot volume
// the store is "none": the save succeeds, the read returns defaults, and every assertion
// here fails for a reason that has nothing to do with the opener. Point it at a scratch
// directory BEFORE the modules load, which also exercises the real file backend.
const DATA_DIR = mkdtempSync(join(tmpdir(), "ros-newsopener-"));
process.env.ROS_DATA_DIR = DATA_DIR;
process.env.SIGNAL_PITCH_AI = "0";

const { newsOpenerFor, isNewsArm } = await import("../lib/signals/watch/newsOpener");
const { saveDeskProfile } = await import("../lib/signals/watch/signalPitch");

let failures = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { console.log(`PASS ${label}`); return; }
  failures++;
  console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
}

const WS = "ws_test_newsopener";
await saveDeskProfile(WS, {
  firmName: "Lume",
  verticals: ["distribution", "warehousing", "logistics"],
  placesTitles: "the operations and supply chain leaders we bring",
  domainDifficulty: "regulated, complex product handling",
  positioning: "We work as an embedded partner, not a resume vendor.",
  ctaMinutes: 15,
});

function prospect(over: Partial<Prospect> = {}): Prospect {
  return {
    id: "pros_1", workspaceId: WS, campaignId: "cmp_1",
    fullName: "Graham Tilley", firstName: "Graham",
    email: "graham@tilley.com", company: "Tilley", title: "VP Operations",
    status: "queued", dripStage: null, warmth: 70, createdAt: "2026-08-01T00:00:00.000Z",
    discoverySource: "news",
    discoverySegment: "chemical distribution",
    discoveryRole: "Operations Manager",
    signalType: "funding_round",
    signalReason: "just closed a $60M Series B led by Battery Ventures to scale the network",
    ...over,
  } as Prospect;
}

/* 1. The happy path ------------------------------------------------------- */
const base = await newsOpenerFor(WS, prospect());
ok(!!base.opener, "a complete news prospect gets an opener", base.reason);
ok(!!base.opener && base.opener.body.includes("Tilley just closed a $60M Series B"),
   "beat 1 says the signal back as a fact", base.opener?.body);
ok(!!base.opener && /chemical distribution/.test(base.opener.body),
   "beat 2 names the segment the sweep was watching");
// The stakes beat is the FIRST paragraph. Check the seat there specifically: the desk
// profile's own "operations and supply chain leaders" line sits in the second paragraph
// and would satisfy a whole-body match no matter which seat was passed in.
const stakesPara = (body: string) => body.split("\n\n")[0];
ok(!!base.opener && /\boperations\b/.test(stakesPara(base.opener.body)),
   "the seat comes from the role THIS manager owns", base.opener?.body);
ok(!!base.opener && base.opener.body.includes("Lume"), "beat 3 names the desk");
ok(base.opener?.signal === "funding_round", "the angle is stamped for per-signal stats");

/* The claim that must never appear on this arm. */
ok(!!base.opener && !/\bi met\b|someone sharper|already vetted|one candidate/i.test(base.opener.body),
   "the news opener never markets a candidate", base.opener?.body);
ok(!!base.opener && !/\{\{|\}\}/.test(base.opener.body + base.opener.subject),
   "no merge token survives into a composed opener");

/* 2. Three managers at one company get three different seats -------------- */
const seats = ["Operations Manager", "Account Executive", "Software Engineer"].map((role, i) =>
  prospect({ id: `pros_${i + 10}`, discoveryRole: role, fullName: `Manager ${i}` }));
const composed = await Promise.all(seats.map((p) => newsOpenerFor(WS, p)));
ok(composed.every((c) => !!c.opener), "all three decision-makers get an opener");
const bodies = composed.map((c) => c.opener!.body);
ok(new Set(bodies).size === 3, "the three managers at one company get three different emails");
ok(/\boperations\b/.test(stakesPara(bodies[0]))
   && /\brevenue\b/.test(stakesPara(bodies[1]))
   && /\bengineering\b/.test(stakesPara(bodies[2])),
   "each names the seat that manager is accountable for",
   bodies.map(stakesPara).join("\n     ---\n     "));

/* 3. Holds — every one of these must refuse to send, not degrade ---------- */
const jobs = await newsOpenerFor(WS, prospect({ discoverySource: "jobs" }));
ok(jobs.hold === "not_news_arm", "a jobs-arm prospect is left to the MPC path");
ok(!isNewsArm(prospect({ discoverySource: "jobs" })), "isNewsArm is false for the jobs arm");

const noReason = await newsOpenerFor(WS, prospect({ signalReason: "" }));
ok(noReason.hold === "no_reason" && !noReason.opener, "no signal reason holds rather than inventing an observation");

const badSignal = await newsOpenerFor(WS, prospect({ signalType: "job_posting" }));
ok(badSignal.hold === "unknown_signal" && !badSignal.opener, "a non-news signal type holds");

const blankWs = await newsOpenerFor("ws_never_configured", prospect());
ok(blankWs.hold === "desk_profile_missing" && !blankWs.opener,
   "an unfilled desk profile holds instead of sending filler", blankWs.reason);
ok((blankWs.reason || "").includes("Signal Watchlists"),
   "and the hold says where to fix it", blankWs.reason);

/* 4. Board seats, at send time -------------------------------------------- */
const board = await newsOpenerFor(WS, prospect({
  signalType: "exec_hire",
  signalReason: "just added a new board member",
  newsFacts: { appointmentKind: "board" },
}));
ok(!!board.opener, "a board appointment still gets an opener");
ok(!!board.opener && !/rebuild the bench|new leader/i.test(board.opener.body + board.opener.subject),
   "and is never described as an operating hire", board.opener?.body);

/* 5. Stability ------------------------------------------------------------ */
const again = await newsOpenerFor(WS, prospect());
ok(again.opener?.body === base.opener?.body, "the same prospect re-renders the same email");

/* 6. The readiness gate must not make the arm inert ----------------------- */
/* A news company posted no role, so roleShot can never capture one and the personalized
 * video is never built. If the video gate applied to this arm, every news prospect would
 * sit at needs-assets forever and the arm would never send a single email — which reads
 * from the outside as a quiet market rather than a gate nobody could clear. */
const { prospectReadiness } = await import("../lib/sending/sendReady");
const verified = { emailVerification: { status: "valid" } } as Partial<Prospect>;

const newsNoVideo = prospectReadiness(prospect(verified));
ok(newsNoVideo.ready, "a news prospect with no video is still send-ready", JSON.stringify(newsNoVideo.missing));

const jobsNoVideo = prospectReadiness(prospect({ ...verified, discoverySource: "jobs", signalType: "job_posting" }));
ok(!jobsNoVideo.ready && jobsNoVideo.missing.includes("video"),
   "a jobs prospect with no video is NOT send-ready — that motion's second email IS the video",
   JSON.stringify(jobsNoVideo.missing));

const newsNoEmail = prospectReadiness(prospect());
ok(!newsNoEmail.ready && newsNoEmail.missing.includes("verified_email"),
   "the news arm still requires a verified address", JSON.stringify(newsNoEmail.missing));

const newsNoName = prospectReadiness(prospect({ ...verified, firstName: "there", fullName: "there" }));
ok(!newsNoName.ready && newsNoName.missing.includes("contact_data"),
   "and still requires a real first name", JSON.stringify(newsNoName.missing));

rmSync(DATA_DIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : "\nnews opener routes correctly");
process.exit(failures ? 1 : 0);
