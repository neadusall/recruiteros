// RecruitersOS · MPC · AI advisor (the "how to move the needle" layer).
//
// Reads the BD cockpit stats and asks Haiku for a few CONCRETE, prioritized moves to lift reply
// rate, then writes them to a snapshot the Dashboard reads. Statistically honest by instruction:
// on small samples it refuses to crown winners and instead says what to watch + the next data
// milestone. Runs daily (cheap), separate from the 20-min stats refresh, so advice is stable.
//
//   node scripts/mpc/mpc-advisor.mjs

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const STATS_FILE = process.env.MPC_STATS_FILE || "/data/snap_mpc_stats_v1.json";
const OUT_FILE = process.env.MPC_ADVISOR_FILE || "/data/snap_mpc_advisor_v1.json";
const MODEL = process.env.MPC_ADVISOR_MODEL || "claude-haiku-4-5";

const SYSTEM = [
  "You are a sharp, no-nonsense cold-email BD analyst advising a recruiting firm running a finance-vertical cold-email campaign (marketing accounting/finance candidates to CFOs, Controllers and VPs of Finance at companies hiring for those roles). You are given the campaign's live KPIs. Return 2 to 4 PRIORITIZED, CONCRETE recommendations that would most improve reply rate and move the needle.",
  "",
  "BE STATISTICALLY HONEST. With small samples (a few hundred sends, or under ~5 replies per variant), do NOT declare a winning or losing variant, it is noise. Instead say what to watch and name the next data milestone (e.g. 'wait until ~300 sends/variant or 10+ total replies before ranking angles').",
  "Use real cold-email benchmarks: healthy finance cold-BD reply rates run ~1 to 4%. Below ~1% almost always means deliverability (domains still warming, spam placement) or a weak opener, NOT the offer. Factor in that the sending domains are actively warming on Smartlead.",
  "Each recommendation is an object: {priority: 'high'|'medium'|'low', title: '<= 8 words, an action', detail: '1 to 2 sentences: why + exactly how'}. Prioritize deliverability and volume/pacing when reply rate is under 1% and samples are thin; only recommend angle/copy shifts once data supports it.",
  "Return STRICT JSON only: {\"recommendations\": [ ... ]}. No prose outside the JSON.",
].join("\n");

async function main() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) { console.error("ANTHROPIC_API_KEY not set"); process.exitCode = 1; return; }
  if (!existsSync(STATS_FILE)) { console.error("no stats snapshot yet; run mpc-stats first"); return; }
  const stats = JSON.parse(readFileSync(STATS_FILE, "utf8"));

  const facts = {
    sent_total: stats.sentTotal, sent_today: stats.sentToday,
    replies_total: stats.repliesTotal, reply_rate_pct: stats.replyRate,
    replies_by_sentiment: stats.repliesBySentiment,
    variants: (stats.variants || []).map((v) => ({ angle: v.variant, sent: v.sent, replied: v.replied, rate_pct: v.rate })),
    clean_supply_ready: stats.supplyReady, free_boards: stats.freeBoards,
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 900, system: SYSTEM,
      messages: [{ role: "user", content: "Campaign KPIs:\n" + JSON.stringify(facts, null, 2) + "\n\nGive the recommendations as strict JSON." }],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) { console.error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exitCode = 1; return; }
  const data = await res.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  let recs = [];
  try { recs = (JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).recommendations) || []; }
  catch { console.error("could not parse advisor JSON"); process.exitCode = 1; return; }

  const out = {
    generatedAt: new Date().toISOString(),
    workspaceId: stats.workspaceId,
    basedOn: { sent: stats.sentTotal, replies: stats.repliesTotal, replyRate: stats.replyRate },
    recommendations: recs.slice(0, 4),
  };
  const tmp = OUT_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, OUT_FILE);
  console.log(`mpc-advisor -> ${out.recommendations.length} recommendations (based on ${stats.sentTotal} sent, ${stats.repliesTotal} replies)`);
  for (const r of out.recommendations) console.log(`  [${r.priority}] ${r.title}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
