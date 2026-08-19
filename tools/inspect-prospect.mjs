import { readFileSync } from "node:fs";
const core = JSON.parse(readFileSync("/data/snap_core.json", "utf8"));
// prospects container: find it + its format
for (const k of Object.keys(core)) {
  const v = core[k];
  if (Array.isArray(v) && v.length && Array.isArray(v[0]) && v[0][1] && (v[0][1].campaignId || v[0][1].email)) {
    console.log("prospects key:", k, "| count:", v.length, "| format: [id, obj] pairs");
    const p = v.find(e => e[1] && e[1].campaignId === "cmp_lume_cpa_controller");
    if (p) { console.log("sample prospect fields:", Object.keys(p[1]).join(",")); console.log("sample:", JSON.stringify(p[1]).slice(0, 500)); }
    break;
  }
  if (Array.isArray(v) && v.length && v[0] && (v[0].campaignId || v[0].email) && typeof v[0]==="object" && !Array.isArray(v[0])) {
    console.log("prospects key:", k, "| count:", v.length, "| format: flat objects");
    const p = v.find(x => x.campaignId === "cmp_lume_cpa_controller");
    if (p) { console.log("fields:", Object.keys(p).join(",")); console.log("sample:", JSON.stringify(p).slice(0,500)); }
    break;
  }
}
