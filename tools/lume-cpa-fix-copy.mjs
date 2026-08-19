// Replace the CPA/Controller campaign's Day-0 copy with a REAL MPC template from the 50,
// set Ryan's MPC context + signature (name, Lume, phone). Engine fills {{Open_Role}},
// {{MH1}}, {{MH2}}, {{Job_Location}} etc. per listing at send time; spintax {a|b} varies
// surface form per prospect. autoRun stays whatever it was (off). Backup + validate.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

const CORE = "/data/snap_core.json";
const BACKUP = "/data/snap_core.json.bak-fix-copy";
const CID = "cmp_lume_cpa_controller";

if (!existsSync(CORE)) { console.error("snap_core.json missing"); process.exit(1); }
copyFileSync(CORE, BACKUP);
const core = JSON.parse(readFileSync(CORE, "utf8"));
const c = (core.campaigns || []).find((x) => x && x.id === CID);
if (!c) { console.error("campaign not found:", CID); process.exit(1); }

// Real MPC template (direct-4 "already-vetted, one person" angle) + signature block.
// Tokens resolve per prospect: {{First_Name}} {{Open_Role}} {{MH1}} {{MH2}} {{Job_Location}}.
const SIG = "\n\nBest,\nRyan Nead\nLume Search Partners\n929-543-0608";
c.model = c.model || {};
c.model.engine = "mpc-library";
c.model.summary = "Day-0 MPC intro (marketing a placeable candidate into the opening), drawn from the 50-template bank; video follow-up added when templates land.";
c.model.touches = [
  {
    key: "em_day0",
    day: 0,
    channel: "email",
    label: "Day 0 - MPC intro (text)",
    subject: "{a strong {{Open_Role}}, already vetted|already-vetted {{Open_Role}}, one person}",
    body:
      "Hi {{First_Name}}, one candidate, not a list. maps to your {{Open_Role}} almost too well. " +
      "{{MH1}}, {{MH2}}, and already screened on comp and timing. wants {{Job_Location}}. worth a conversation?" + SIG,
  },
];
c.mpcContext = { ...(c.mpcContext || {}), yourName: "Ryan Nead", industry: "Accounting & Finance" };
c.outreachApproved = true;
c.autoRun = true;          // GO LIVE: autopilot sends Email 1 to enrolled prospects on the next tick
c.status = "active";
c.updatedAt = new Date().toISOString();

const out = JSON.stringify(core);
JSON.parse(out);
writeFileSync(CORE, out);

const check = JSON.parse(readFileSync(CORE, "utf8")).campaigns.find((x) => x.id === CID);
console.log("updated:", CID);
console.log("engine:", check.model.engine, "| touches:", check.model.touches.length, "| approved:", check.outreachApproved, "| autoRun:", check.autoRun);
console.log("subject:", check.model.touches[0].subject);
console.log("body:\n" + check.model.touches[0].body);
console.log("backup:", BACKUP);
