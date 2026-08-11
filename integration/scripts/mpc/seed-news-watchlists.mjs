// Create the multi-vertical NEWS-signal watchlists in prod. Idempotent by id.
// Writes /data/snap_signals_watchlists_v1.json; the app normalizes rows on load.
// source:"news" lists poll free Google News RSS (funding / exec hires / expansion),
// synthesize the post-signal build-out roles, and hand leads to the same belt.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FILE = "/data/snap_signals_watchlists_v1.json";
const WS = "ws_mqf6o989003"; // Lume
const now = new Date().toISOString();

const SEGMENTS = [
  { id: "wl_news_saas",       name: "News · SaaS / software companies",      segment: "SaaS company" },
  { id: "wl_news_fintech",    name: "News · Fintech companies",              segment: "fintech company" },
  { id: "wl_news_mfg",        name: "News · Manufacturing companies",        segment: "manufacturing company" },
  { id: "wl_news_logistics",  name: "News · Logistics / supply chain",       segment: "logistics company" },
  { id: "wl_news_healthtech", name: "News · Healthcare / health tech",       segment: "healthcare technology company" },
  { id: "wl_news_construct",  name: "News · Construction / industrial",      segment: "construction company" },
  { id: "wl_news_ecom",       name: "News · Ecommerce / consumer brands",    segment: "ecommerce company" },
];

const lists = SEGMENTS.map((s) => ({
  id: s.id,
  workspaceId: WS,
  name: s.name,
  source: "news",
  segment: s.segment,
  newsSignals: ["funding_round", "exec_hire", "office_expansion"],
  newsWindowDays: 7,
  minAmountUsd: 5_000_000,          // ignore sub-$5M raises; too small to buy search
  perPollCompanyCap: 15,
  minScore: 0,
  limit: 25,
  active: true,
  everyMinutes: 60,                  // RSS is free but circuit-breaker guarded; hourly is plenty
  createdAt: now,
  updatedAt: now,
  stats: {},
}));

let list = [];
if (existsSync(FILE)) {
  try { const j = JSON.parse(readFileSync(FILE, "utf8")); if (Array.isArray(j)) list = j; } catch { /* start fresh */ }
}

let added = 0, updated = 0;
for (const wl of lists) {
  const idx = list.findIndex((w) => w && w.id === wl.id);
  if (idx >= 0) { list[idx] = { ...list[idx], ...wl, createdAt: list[idx].createdAt || wl.createdAt, stats: list[idx].stats || {} }; updated++; }
  else { list.push(wl); added++; }
}

writeFileSync(FILE, JSON.stringify(list, null, 2));
console.log(`news watchlists: +${added} added, ${updated} updated | file now has ${list.length} lists`);
for (const w of list) console.log("  -", w.source || "jobs", "|", w.name, "| active:", w.active !== false);
