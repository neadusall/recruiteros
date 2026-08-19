// EMERGENCY PAUSE: set autoRun=false on the CPA/Controller campaign so the autopilot
// skips it. Stops any send until targeting + MPC rendering are fixed.
import { readFileSync, writeFileSync } from "node:fs";
const CORE = "/data/snap_core.json", CID = "cmp_lume_cpa_controller";
const core = JSON.parse(readFileSync(CORE, "utf8"));
const e = core.campaigns.find(x => Array.isArray(x) && x[0] === CID);
if (!e) { console.log("campaign not found"); process.exit(1); }
e[1].autoRun = false;
e[1].status = "paused";
writeFileSync(CORE, JSON.stringify(core));
console.log("PAUSED:", e[1].name, "| autoRun:", e[1].autoRun, "| status:", e[1].status);
