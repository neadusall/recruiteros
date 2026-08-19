// Create the Lume CPA/Controller campaign as a PROPER Map entry [id, campaign].
// The previous attempts pushed a bare object into a Map-of-pairs, so the app discarded
// it on load. This appends [CID, campaign] correctly so it persists. Backup + validate.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const CORE = "/data/snap_core.json";
copyFileSync(CORE, "/data/snap_core.json.bak-v2");
const core = JSON.parse(readFileSync(CORE, "utf8"));

const WS = "ws_mqf6o989003", RYAN = "usr_mqf6o967002", CID = "cmp_lume_cpa_controller";
const now = new Date().toISOString();

const SIG = "\n\nBest,\nRyan Nead\nLume Search Partners\n929-543-0608";
const campaign = {
  id: CID,
  workspaceId: WS,
  motion: "bd",
  name: "CPA / Controller BD - Ryan",
  goal: "Book intro calls with CFOs and VPs of Finance at US companies hiring a Controller or CPA.",
  icp: {
    accountProfile: "US companies actively hiring a Controller or CPA (accounting team scaling past capacity).",
    persona: "CFO / VP of Finance (budget owner for the hire); founder/CEO at smaller companies.",
    disqualifiers: [],
  },
  signals: ["hiring_velocity"],
  channels: {},
  methodology: "hiring_manager_outreach",
  voiceNoteThreshold: 80,
  dailyCap: 490,
  status: "active",
  createdAt: now,
  updatedAt: now,
  assignee: "Ryan Nead",
  senderAccount: "auto-rotate",
  recruiterId: RYAN,
  mpcContext: { yourName: "Ryan Nead", industry: "Accounting & Finance" },
  outreachApproved: true,
  autoRun: true,
  sendQueue: false,
  model: {
    generatedAt: now,
    approvedAt: now,
    engine: "mpc-library",
    motion: "bd",
    persona: "CFO / VP of Finance",
    summary: "Day-0 MPC intro to the finance decision-maker at companies hiring a Controller/CPA.",
    touches: [{
      key: "em_day0",
      day: 0,
      channel: "email",
      label: "Day 0 - MPC intro (text)",
      subject: "{a strong {{Open_Role}}, already vetted|already-vetted {{Open_Role}}, one person}",
      body: "Hi {{First_Name}}, one candidate, not a list. maps to your {{Open_Role}} almost too well. {{MH1}}, {{MH2}}, and already screened on comp and timing. wants {{Job_Location}}. worth a conversation?" + SIG,
    }],
  },
};

// Drop any prior malformed/bare or duplicate entries for this id, then append the pair.
core.campaigns = core.campaigns.filter((e) => {
  if (Array.isArray(e)) return e[0] !== CID;      // proper [id, obj] pair: keep unless our id
  return e && e.id !== CID;                        // stray bare object from an old attempt: drop ours
});
core.campaigns.push([CID, campaign]);

const out = JSON.stringify(core);
JSON.parse(out);
writeFileSync(CORE, out);

const check = JSON.parse(readFileSync(CORE, "utf8")).campaigns.find((e) => Array.isArray(e) && e[0] === CID);
console.log("campaigns now:", JSON.parse(out).campaigns.length);
console.log("added as Map entry:", check ? "YES" : "NO");
if (check) { const c = check[1]; console.log("  name:", c.name, "| recruiter:", c.recruiterId, "| autoRun:", c.autoRun, "| approved:", c.outreachApproved, "| touches:", c.model.touches.length); }
