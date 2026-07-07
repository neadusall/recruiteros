/**
 * Render-guard checks (run: npx tsx lib/copy/renderGuard.test.ts)
 *
 * The contract under test, end to end through the REAL render path (renderTouch):
 *   1. Every MPC Day-0 template + the Day-1 video follow-up, filled with COMPLETE data,
 *      renders clean and passes the guard — the "consistent and stable" guarantee that the
 *      approved library can never hold itself.
 *   2. A prospect with MISSING data points is HELD (never sent), with the exact tokens named.
 *   3. The video email is HELD when it talks about a video it doesn't carry, and passes when
 *      the video assets are attached.
 *   4. Structural debris (unresolved tokens) is held.
 *   5. A dash inside a merge VALUE (a company like "Coca-Cola") never holds a send, while a
 *      dash in the template's own words still does.
 */

import { renderTouch } from "../automation/model";
import { guardRenderedTouch } from "./renderGuard";
import { hasContactData } from "../sending/sendReady";
import { emailPayload } from "../channels";
import { MPC_TEMPLATES } from "../bd/mpc/templates";
import { templateOpener } from "../inmarket/videoOpener";
import type { CampaignModelTouch, Prospect } from "../core/types";

let fails = 0;
function ok(cond: boolean, label: string): void {
  console.log(`${cond ? "  ok" : "FAIL"}  ${label}`);
  if (!cond) fails++;
}

const touch = (t: { subject?: string; body: string; key?: string }): CampaignModelTouch =>
  ({ key: t.key || "t", day: 0, channel: "email", label: t.key || "t", subject: t.subject, body: t.body }) as CampaignModelTouch;

/** A prospect with every data point the MPC + video sequence needs. */
const FULL: Partial<Prospect> = {
  id: "p_test",
  firstName: "Marcus",
  fullName: "Marcus Webb",
  company: "Meridian Health Partners",
  title: "VP of Sales",
  location: "Raleigh, NC",
  email: "marcus.webb@meridianhealth.com",
  mpcContext: {
    placedRole: "Account Executive",
    placementLocation: "Charlotte, NC",
    competitor: "TeamHealth",
    industry: "healthcare",
    mustHaves: ["closed six figure ARR deals", "built the territory from zero"],
    metric: "142% to quota",
    gender: "f",
    yourName: "Ryan",
  },
} as Partial<Prospect>;

const VIDEO: Partial<Prospect> = {
  ...FULL,
  personalizedVideo: {
    videoKey: "vid_abc",
    watchUrl: "https://recruitersos.co/watch/abc?sig=x",
    gifUrl: "https://cdn.recruitersos.co/v/abc/teaser.gif",
    posterUrl: "https://cdn.recruitersos.co/v/abc/poster.jpg",
    roleTitle: "VP of Sales",
    at: new Date().toISOString(),
  },
} as Partial<Prospect>;

(async () => {
  /* 1 — the whole approved library, fully filled, passes. */
  console.log("\nEvery MPC Day-0 template renders clean with full data:");
  let libBad = 0;
  for (const t of MPC_TEMPLATES) {
    const r = renderTouch(touch({ key: t.id, subject: t.subject, body: t.body }), FULL, { emailStep: 1 });
    const g = guardRenderedTouch({ channel: "email", emailStep: 1, subject: r.subject, body: r.body, tokens: r.tokens });
    if (!g.ok) {
      libBad++;
      console.log(`    "${t.id}": ${g.holds.map((h) => `${h.check} (${h.detail})`).join("; ")}`);
    }
  }
  ok(libBad === 0, `all ${MPC_TEMPLATES.length} MPC templates pass the guard`);

  const seq = templateOpener({ company: FULL.company!, roleTitle: FULL.title! });

  const r2 = renderTouch(touch({ key: "email_video", subject: seq.second.subject, body: seq.second.body }), VIDEO, { emailStep: 2 });
  const g2 = guardRenderedTouch({ channel: "email", emailStep: 2, subject: r2.subject, body: r2.body, tokens: r2.tokens });
  if (!g2.ok) console.log("    video follow-up holds:", g2.holds);
  ok(g2.ok, "the Day-1 video follow-up passes with video attached");
  ok(/<img /.test(r2.body) && /https:\/\//.test(r2.body), "video email carries the clickable thumbnail embed");
  // The thumbnail (screenshot + PiP bubble) must be CLICKABLE: the <img> sits inside an <a> whose
  // href is this prospect's personalized watch link (with the view-attribution params).
  const embedAnchor = r2.body.match(/<a href="([^"]+)"[^>]*>\s*<img /);
  ok(!!embedAnchor, "the thumbnail image is wrapped in a link");
  ok(!!embedAnchor && embedAnchor[1].startsWith(VIDEO.personalizedVideo!.watchUrl), "the thumbnail link goes to the prospect's watch page");
  ok(!!embedAnchor && embedAnchor[1].includes("rcpt=p_test"), "the watch link carries the prospect's view attribution");

  // The guard makes clickability a hard rule: a dead (unlinked) image holds the send.
  const dead = guardRenderedTouch({
    channel: "email", emailStep: 2,
    subject: "re: the role",
    body: `Hi Ana, i recorded a quick video for you.\n<img src="https://cdn.recruitersos.co/x.gif" />\nworth a look? Thanks, Ryan`,
    tokens: { firstname: "Ana" },
  });
  ok(dead.holds.some((h) => h.check === "unlinked_image"), "an unlinked thumbnail image is held");

  // The delivered payload keeps its formatting: \n become <br> in the html part, and the
  // text/plain part swaps the embed for the watch link.
  const payload = emailPayload(r2.body);
  ok(payload.html.includes("<br>") && !/\n<br>/.test("") && payload.html.includes("<table"), "html payload keeps paragraphs and the video card");
  ok(payload.text.includes("Watch the video:") && payload.text.includes(VIDEO.personalizedVideo!.watchUrl), "text/plain alternative carries the watch link");
  ok(!/<[a-z]/i.test(payload.text), "text/plain alternative has no leftover markup");

  /* 2 — missing data points hold the send and name the tokens. */
  const sparse = renderTouch(touch({ subject: "{{company}} + your search", body: "Hi {{firstName}}, saw {{company}} is {{signal}}. worth a conversation? Thanks, Ryan" }), {} as Partial<Prospect>, { emailStep: 1 });
  const gs = guardRenderedTouch({ channel: "email", emailStep: 1, subject: sparse.subject, body: sparse.body, tokens: sparse.tokens });
  ok(!gs.ok, "a data-poor prospect is held, not sent");
  ok(gs.holds.some((h) => h.check === "missing_data" && h.detail.includes("firstname")), "the hold names the missing first name");
  ok(gs.holds.some((h) => h.check === "missing_data" && h.detail.includes("company")), "the hold names the missing company");

  /* 3 — the video email never sends without its video. */
  const noVid = renderTouch(touch({ key: "email_video", subject: seq.second.subject, body: seq.second.body }), FULL, { emailStep: 2 });
  const gn = guardRenderedTouch({ channel: "email", emailStep: 2, subject: noVid.subject, body: noVid.body, tokens: noVid.tokens });
  ok(!gn.ok, "video follow-up without a video is held");
  ok(gn.holds.some((h) => h.check === "video_missing" || (h.check === "missing_data" && h.detail.includes("videoembed"))), "the hold says the video is missing");

  /* 4 — structural debris is held. */
  const broken = renderTouch(touch({ subject: "hello", body: "Hi {{firstName}}, about {{ first name }} your opening. worth a conversation? Thanks, Ryan" }), FULL, { emailStep: 1 });
  const gb = guardRenderedTouch({ channel: "email", emailStep: 1, subject: broken.subject, body: broken.body, tokens: broken.tokens });
  ok(gb.holds.some((h) => h.check === "unresolved_token"), "a literal {{...}} surviving into the copy is held");

  /* 5 — dashes in DATA pass; dashes in the TEMPLATE hold. */
  const coke = renderTouch(touch({ subject: "{{company}} search", body: "Hi {{firstName}}, saw {{company}} is {{signal}}. worth a conversation? Thanks, Ryan" }),
    { firstName: "Ana", company: "Coca-Cola", signalReason: "hiring a VP of Sales" } as Partial<Prospect>, { emailStep: 1 });
  const gc = guardRenderedTouch({ channel: "email", emailStep: 1, subject: coke.subject, body: coke.body, tokens: coke.tokens });
  if (!gc.ok) console.log("    coca-cola holds:", gc.holds);
  ok(gc.ok, "a hyphen inside a company name never holds the send");

  const dashy = renderTouch(touch({ subject: "hello", body: "Hi {{firstName}}, a well-vetted rep for {{company}}. worth a conversation? Thanks, Ryan" }),
    { firstName: "Ana", company: "Acme", signalReason: "x" } as Partial<Prospect>, { emailStep: 1 });
  const gd = guardRenderedTouch({ channel: "email", emailStep: 1, subject: dashy.subject, body: dashy.body, tokens: dashy.tokens });
  ok(!gd.ok && gd.holds.some((h) => h.check === "guardrail"), "a dash in the template's own words still holds");

  /* 6 — the staging gate approximation. */
  ok(hasContactData({ firstName: "Marcus", company: "Meridian", title: "COO" } as Prospect), "contact data gate passes a complete prospect");
  ok(!hasContactData({ firstName: "there", company: "Meridian", title: "COO" } as Prospect), "contact data gate rejects the 'there' fallback");
  ok(!hasContactData({ firstName: "Marcus", company: "", title: "COO" } as Prospect), "contact data gate rejects a missing company");

  console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})();
