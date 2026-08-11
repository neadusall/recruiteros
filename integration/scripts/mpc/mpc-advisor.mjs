// RecruitersOS · MPC · AI advisor (the "how to move the needle" layer).
//
// Reads the BD cockpit stats and asks Haiku for a few CONCRETE, prioritized moves to lift reply
// rate, then writes them to a snapshot the Dashboard reads. Statistically honest by instruction:
// on small samples it refuses to crown winners and instead says what to watch + the next data
// milestone. Runs daily (cheap), separate from the 20-min stats refresh, so advice is stable.
//
//   node scripts/mpc/mpc-advisor.mjs

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";

const STATS_FILE = process.env.MPC_STATS_FILE || "/data/snap_mpc_stats_v1.json";
const OUT_DIR = process.env.MPC_OUT_DIR || "/out";
const INBOX_FILE = process.env.MPC_INBOX_FILE || "/data/snap_inbox.json";

// REAL deliverability facts, so the advisor never GUESSES that a low reply rate is a spam/warm-up
// problem. Reads the actual send results (hard-failure rate, campaign age) + the inbox (bounce-like
// DSNs) + Smartlead warm-up reputation (if the key is present). No assumptions, just numbers.
async function deliverabilityFacts() {
  let total = 0, fails = 0, firstAt = null;
  if (existsSync(OUT_DIR)) {
    for (const f of readdirSync(OUT_DIR).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
      for (const line of readFileSync(`${OUT_DIR}/${f}`, "utf8").split("\n")) {
        const s = line.trim(); if (!s) continue;
        try { const r = JSON.parse(s); if (!r || !r.to_email) continue; total++; if (!(r.result && r.result.ok)) fails++; const at = r.at || ""; if (!firstAt || at < firstAt) firstAt = at; } catch { /* skip */ }
      }
    }
  }
  let bounces = 0;
  try {
    const ib = JSON.parse(readFileSync(INBOX_FILE, "utf8"));
    for (const x of (ib.items || [])) { const t = ((x.inbound || x).text || "").toLowerCase(); if (/delivery.*failed|undeliverable|mailbox.*full|does not exist|\b550\b/.test(t)) bounces++; }
  } catch { /* no inbox */ }
  let warmupReputation = null, mailboxesActive = null;
  const slKey = process.env.SMARTLEAD_API_KEY;
  if (slKey) {
    try {
      const reps = []; let active = 0;
      for (let off = 0; off < 2000; off += 100) {
        const r = await fetch(`https://server.smartlead.ai/api/v1/email-accounts/?api_key=${slKey}&offset=${off}&limit=100`, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) break; const d = await r.json(); if (!Array.isArray(d) || !d.length) break;
        for (const a of d) { if (!/lume/i.test(a.from_email || a.username || "")) continue; const w = a.warmup_details || {}; const rep = parseFloat(String(w.warmup_reputation || a.warmup_reputation || "").replace("%", "")); if (Number.isFinite(rep)) reps.push(rep); if (/active|warming|running/i.test(w.status || a.warmup_status || a.status || "")) active++; }
        if (d.length < 100) break;
      }
      if (reps.length) warmupReputation = Math.round(reps.reduce((s, x) => s + x, 0) / reps.length);
      mailboxesActive = active;
    } catch { /* smartlead unreachable; leave null */ }
  }
  const ageDays = firstAt ? Math.round((Date.now() - Date.parse(firstAt)) / 86_400_000 * 10) / 10 : null;
  return { total_sent: total, hard_failure_rate_pct: total ? Math.round(fails / total * 1000) / 10 : 0, bounce_like_in_inbox: bounces, campaign_age_days: ageDays, warmup_reputation_pct: warmupReputation, mailboxes_active_warming: mailboxesActive };
}
const OUT_FILE = process.env.MPC_ADVISOR_FILE || "/data/snap_mpc_advisor_v1.json";
const MODEL = process.env.MPC_ADVISOR_MODEL || "claude-haiku-4-5";

const SYSTEM = [
  "You are a sharp, no-nonsense cold-email BD analyst advising a recruiting firm running a finance-vertical cold-email campaign (marketing accounting/finance candidates to CFOs, Controllers and VPs of Finance at companies hiring for those roles). You are given the campaign's live KPIs. Return 2 to 4 PRIORITIZED, CONCRETE recommendations that would most improve reply rate and move the needle.",
  "",
  "BE STATISTICALLY HONEST. With small samples (a few hundred sends, or under ~5 replies per variant), do NOT declare a winning or losing variant, it is noise. Instead say what to watch and name the next data milestone (e.g. 'wait until ~300 sends/variant or 10+ total replies before ranking angles').",
  "DELIVERABILITY: you are given REAL facts (hard_failure_rate_pct, bounce_like_in_inbox, campaign_age_days, warmup_reputation_pct, mailboxes_active_warming). Reason ONLY from them. DO NOT claim a deliverability or warm-up problem unless the EVIDENCE shows it: hard_failure_rate_pct > 2%, bounces present, or warmup_reputation_pct clearly low (< 90). If failures are ~0%, bounces ~0, and warm-up reputation is high, deliverability is HEALTHY, say so plainly, and DO NOT recommend auditing warm-up. A young campaign (a few days old, a few hundred sends) simply cannot be judged on reply rate yet, attribute a low early reply rate to SAMPLE SIZE and normal ramp, not to a problem. Never post a deliverability assumption as fact.",
  "Each recommendation is an object: {priority: 'high'|'medium'|'low', kind: 'fix'|'growth', title: '<= 8 words, an action', detail: '1 to 2 sentences: why + exactly how'}. Prioritize deliverability and volume/pacing (kind=fix) when reply rate is under 1% and samples are thin; only recommend angle/copy shifts once data supports it.",
  "ALSO include 1 to 2 kind='growth' moves: market-aware ways to grow outbound and win more deals that the operator likely has not thought of. Draw on how the recruiting/staffing market actually works right now, e.g.: which ADJACENT industries are hiring accounting/finance heavily and worth spinning up a cohort for (SaaS, healthcare systems, PE-backed rollups, manufacturing, government contractors); a proven MULTI-TOUCH or channel tactic (email->LinkedIn connect->voice note; a 3-touch value-first sequence); a POSITIONING angle that earns replies (lead with a candidate they can't easily find, or a comp/market insight); or warming a fresh sending domain to unlock more capacity. Be concrete and specific, name the industry/tactic, not generic advice.",
  "Return STRICT JSON only: {\"recommendations\": [ ... ]}. No prose outside the JSON.",
].join("\n");

async function main() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) { console.error("ANTHROPIC_API_KEY not set"); process.exitCode = 1; return; }
  if (!existsSync(STATS_FILE)) { console.error("no stats snapshot yet; run mpc-stats first"); return; }
  const stats = JSON.parse(readFileSync(STATS_FILE, "utf8"));

  const deliverability = await deliverabilityFacts();
  const facts = {
    sent_total: stats.sentTotal, sent_today: stats.sentToday,
    replies_total: stats.repliesTotal, reply_rate_pct: stats.replyRate,
    replies_by_sentiment: stats.repliesBySentiment,
    variants: (stats.variants || []).map((v) => ({ angle: v.variant, sent: v.sent, replied: v.replied, rate_pct: v.rate })),
    clean_supply_ready: stats.supplyReady, free_boards: stats.freeBoards,
    deliverability, // REAL facts: failure rate, bounces, campaign age, warm-up reputation
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
