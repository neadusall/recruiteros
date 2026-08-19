// Create the Lume CPA/Controller BD campaign for Ryan, on the portal, wired to the
// sourcing pool. Built APPROVED but autoRun=OFF: it enrolls + stacks prospects and
// sends NOTHING until the owner flips autoRun on (after seeing the rendered email).
// Defensive: backs up snap_core.json, validates, only then writes.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

const CORE = "/data/snap_core.json";
const BACKUP = "/data/snap_core.json.bak-cpa-campaign";
const WS = "ws_mqf6o989003";                 // Lume
const RYAN = "usr_mqf6o967002";
const CID = "cmp_lume_cpa_controller";
const now = new Date().toISOString();

if (!existsSync(CORE)) { console.error("snap_core.json not found"); process.exit(1); }
copyFileSync(CORE, BACKUP);
const core = JSON.parse(readFileSync(CORE, "utf8"));
if (!Array.isArray(core.campaigns)) { console.error("core.campaigns is not an array; aborting"); process.exit(1); }
const before = core.campaigns.length;

// Email 1 (Day 0): merge-filled per prospect at send time (no per-send LLM), so what is
// approved here is exactly what goes out. No em-dashes. Honest (no invented candidate).
const emailBody =
  "Hi {{firstName}}, I saw {{company}} is hiring a {{role}}. Lume focuses on accounting and finance recruiting, " +
  "and we often have pre-vetted {{role}} candidates ready before a search fully kicks off. " +
  "Would a short call this week be worth it to compare notes? Best, {{Your_Name}}, Lume Search Partners";

const campaign = {
  id: CID,
  workspaceId: WS,
  motion: "bd",
  name: "CPA / Controller BD - Ryan",
  goal: "Book intro calls with CFOs and VPs of Finance at US companies hiring a Controller or CPA.",
  icp: {
    accountProfile: "US companies actively hiring a Controller or CPA (accounting team scaling past capacity).",
    persona: "CFO / VP of Finance (the budget owner for the hire); founder/CEO at smaller companies.",
    disqualifiers: [],
  },
  signals: ["hiring_velocity"],
  channels: {},                              // email-only via Ryan's inbox pool
  methodology: "hiring_manager_outreach",
  voiceNoteThreshold: 80,
  dailyCap: 490,                              // Ryan's ceiling (245 boxes x 2/day)
  status: "active",
  createdAt: now,
  assignee: "Ryan Nead",
  senderAccount: "auto-rotate",
  mpcContext: { yourName: "Ryan Nead", industry: "Accounting & Finance" },
  model: {
    generatedAt: now,
    approvedAt: now,
    engine: "library",
    motion: "bd",
    persona: "CFO / VP of Finance",
    summary: "Day-0 MPC intro to the finance decision-maker at companies hiring a Controller/CPA. Video follow-up added once templates land.",
    touches: [
      {
        key: "em_day0",
        day: 0,
        channel: "email",
        label: "Day 0 - MPC intro (text)",
        subject: "quick thought on your {{role}} opening",
        body: emailBody,
      },
    ],
  },
  outreachApproved: true,
  sendQueue: false,                          // OFF: sendQueue would hold every email waiting for the Day-1 video
  autoRun: false,                            // OFF: stacks prospects, sends nothing, until the owner flips it on
  recruiterId: RYAN,
  updatedAt: now,
};

core.campaigns = core.campaigns.filter((c) => c && c.id !== CID);
core.campaigns.push(campaign);

// Validate we can re-serialize and re-parse before committing the write.
const out = JSON.stringify(core);
JSON.parse(out);
writeFileSync(CORE, out);

const check = JSON.parse(readFileSync(CORE, "utf8"));
console.log("campaigns before:", before, "after:", check.campaigns.length);
const mine = check.campaigns.find((c) => c.id === CID);
console.log("created:", mine ? "YES" : "NO");
if (mine) console.log("  name:", mine.name, "| recruiter:", mine.recruiterId, "| approved:", mine.outreachApproved, "| autoRun:", mine.autoRun, "| dailyCap:", mine.dailyCap, "| touches:", mine.model.touches.length);
console.log("backup at:", BACKUP);
