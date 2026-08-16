/**
 * One-shot: enqueue the Healthcare Regional Marketing Director search into the
 * JD Sourcing overnight queue for the Lumesp workspace, with the exact dials a
 * UI-initiated run would carry (see docs/runbooks/healthcare-regional-marketing-
 * director-runbook.md for what the dials mean and why).
 *
 *   ROS_DATA_DIR=<app_data volume> npx tsx scripts/enqueue-hrmd-search.mts   (from integration/)
 *
 * MUST run with the app container STOPPED. The night queue snapshot is an
 * in-memory store the running app re-saves (see CLAUDE.md's hydration trap);
 * writing it from a second process while the app is up means one side's write
 * is silently lost. Stopped-app + fresh boot is the sanctioned write path: the
 * boot hydrates this item and the nightqueue timer (every 2 min) runs the
 * search INSIDE the app, where the workspace credentials and the autoflow
 * delivery live. This script never runs the search itself.
 *
 * The process.exit right after addNightItem resolves is deliberate:
 * addNightItem awaits save() and then fire-and-forgets tickNightQueue; exiting
 * immediately kills that tick before it can start the search in this host
 * process, which would otherwise race the restarted app for the stores.
 */
import { readFileSync } from "fs";
import { addNightItem } from "../lib/sourcing/nightQueue";

const BRIEF = new URL("../../docs/runbooks/healthcare-regional-marketing-director-brief.md", import.meta.url);
const md = readFileSync(BRIEF, "utf8");
// The paste-in body sits between the two horizontal rules, exactly what a
// recruiter would put in the JD box.
const body = md.split(/^---$/m).slice(1, -1).join("---").trim();
if (body.length < 4000) throw new Error(`brief body looks truncated: ${body.length} chars`);

// Same location suffix the UI's jdWithLoc() appends, so the parse hears the
// radius instruction the same way an interactive run would.
const jd = body +
  "\n\nBased in: Lawrence, KS (within ~250 miles, include ALL surrounding metros and cities within that drive, not just Lawrence, KS)";

const item = await addNightItem("ws_mqf6o989003", {
  kind: "search",
  name: "Healthcare Regional Marketing Director · Lawrence KS",
  jd,
  location: "Lawrence, KS +250mi", // the UI bakes the radius into the label; parseRadiusMi reads it back
  breadth: "wide",
  cap: 500,
  minFit: 45,
  freshOnly: false,
  radiusMi: 250,
  strictGeo: true,
  remote: false,
  outsideGeo: true, // "Also list out-of-area": the national tier arrives as a separate list
  createdBy: { userId: "usr_mqf6o967002", name: "Ryan", email: "ryan@lumesp.com" },
});

console.log("QUEUED", item.id, "|", item.name, "| stage:", item.stage);
process.exit(0);
