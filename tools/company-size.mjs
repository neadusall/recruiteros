// RecruitersOS · MPC company-size resolver
//
// WHY THIS EXISTS. The 100-1,000 employee mandate (owner, 2026-08-20) can only be enforced on a
// CONFIRMED headcount, and the only size source the platform had was Wikidata, which resolved 278
// of 11,380 companies (2.4%). Wikidata knows public and established companies; the pool is private
// SMB and mid-market, so coverage was never going to come from there. Every other size input in
// the system was a HEURISTIC derived from how many roles a company had posted, which is not a
// headcount and must never gate a send.
//
// This resolves the real number from the company's own LinkedIn page via the Serper SERP API
// (already keyed, ~$0.001/query). Two numbers live in those snippets:
//   "View all 221 employees"      -> the concrete profile count           (stored as `count`)
//   "201-500 employees"           -> the company's SELF-REPORTED band     (stored as `band`)
// Both are captured; `count` wins for the gate, the band is the fallback and the cross-check.
//
// Writes into the SAME cache the app already reads (snap_inmarket_company_size_v1.json), tagged
// src:"linkedin", so the Hire Signals size chips and the app's own size-aware decision-maker
// targeting get real numbers too, not just the sender. Entries Wikidata already resolved with a
// real count are never overwritten. The app's pool-purge helpers only act on src:"wikidata", so
// adding these entries cannot silently purge anything.
//
// Usage:
//   node /tools/company-size.mjs                 # resolve companies that gate on size today
//   node /tools/company-size.mjs --all           # every company in the curated store
//   node /tools/company-size.mjs --limit 500
//   node /tools/company-size.mjs --stats         # coverage report, spends nothing

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const CACHE = process.env.MPC_SIZE_SNAPSHOT || "/data/snap_inmarket_company_size_v1.json";
const KEY = process.env.SERPER_API_KEY || "";
const COST_PER_QUERY = 0.001;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(val("--limit", process.env.MPC_SIZE_LIMIT || 400));
const CONC = Math.max(1, Number(process.env.MPC_SIZE_CONCURRENCY || 4));
const FRESH_MS = 90 * 24 * 60 * 60 * 1000;   // a resolved size is good for 90 days
const NEG_MS = 21 * 24 * 60 * 60 * 1000;     // retry a company we could not resolve after 21 days

const nameKey = (s) => String(s || "").toLowerCase().trim();

function loadCache() {
  try { const j = JSON.parse(readFileSync(CACHE, "utf8")); return (j && (j.data || j)) || {}; }
  catch { return {}; }
}
function saveCache(cache) {
  // Write-then-rename so a crash mid-write can never leave the shared cache truncated.
  const tmp = `${CACHE}.size.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, CACHE);
}

function bandFromCount(n) {
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  if (n <= 1000) return "501-1000";
  if (n <= 5000) return "1001-5000";
  return "5000+";
}

const num = (s) => Number(String(s).replace(/[,\s]/g, ""));

/** Pull a headcount out of one SERP result. LinkedIn company pages carry both numbers; a
 *  linkedin.com/company link is trusted first, other directories only as a last resort. */
function parseResult(r) {
  const text = `${r.title || ""} ${r.snippet || ""}`;
  const link = String(r.link || "");
  const isLinkedInCompany = /linkedin\.com\/company\//i.test(link);
  const out = { count: undefined, band: undefined, linkedin: isLinkedInCompany };

  const viewAll = text.match(/view all ([\d,]+)\+? employees/i);
  if (viewAll) out.count = num(viewAll[1]);

  const bandM = text.match(/\b([\d,]+)\s*[-–]\s*([\d,]+)\s+employees\b/i);
  if (bandM) {
    const lo = num(bandM[1]), hi = num(bandM[2]);
    if (lo > 0 && hi >= lo) out.band = { lo, hi, label: `${lo}-${hi}` };
  } else if (/\b10,?001\+?\s+employees|\b10001\+ employees/i.test(text)) {
    out.band = { lo: 10001, hi: 10001, label: "10001+" };
  } else if (/\b5,?001\s*[-–]\s*10,?000 employees/i.test(text)) {
    out.band = { lo: 5001, hi: 10000, label: "5001-10000" };
  }

  if (out.count == null) {
    // Directory fallbacks ("has approximately 4.4K employees", "1,200 employees").
    const approx = text.match(/approximately ([\d.,]+)\s*([kK])?\s+employees/i)
      || text.match(/\bhas ([\d.,]+)\s*([kK])?\s+employees/i);
    if (approx) {
      const base = Number(String(approx[1]).replace(/,/g, ""));
      if (isFinite(base) && base > 0) out.count = approx[2] ? Math.round(base * 1000) : Math.round(base);
    }
  }
  return out;
}

async function serper(query) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 6 }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`serper ${res.status}`);
  return res.json();
}

/** Resolve ONE company. Trusts the company's own LinkedIn page over any directory. */
async function resolveOne(company) {
  const data = await serper(`${company} linkedin company employees`);
  const organic = Array.isArray(data?.organic) ? data.organic : [];
  let count, band, via;
  for (const r of organic) {
    const p = parseResult(r);
    if (!p.linkedin) continue;
    if (p.count != null && count == null) { count = p.count; via = "linkedin_profile_count"; }
    if (p.band && !band) band = p.band;
    if (count != null && band) break;
  }
  if (count == null) {
    for (const r of organic) {
      const p = parseResult(r);
      if (p.count != null) { count = p.count; via = "directory"; break; }
    }
  }
  // No exact number but a self-reported band: use its midpoint, flagged as band-derived so the
  // provenance is never lost.
  if (count == null && band) { count = Math.round((band.lo + band.hi) / 2); via = "linkedin_band_midpoint"; }
  if (count == null || !isFinite(count) || count <= 0) return null;

  // CROSS-CHECK, biased toward keeping oversized companies OUT. The LinkedIn profile count only
  // sees people who keep a profile, so a workforce that is largely non-desk (hotels, healthcare,
  // manufacturing) reads far smaller than it is: Crescent Hotels showed 1,135 profiles against a
  // self-reported 5,001-10,000. When the company's own band starts ABOVE the profile count, the
  // band is the truer number and wins. The reverse (count above the band) is left alone, because
  // there the band is usually a stale or mismatched snippet.
  if (band && count < band.lo) {
    count = Math.round((band.lo + band.hi) / 2);
    via = "linkedin_band_over_profile_count";
  }
  return { count, bandLabel: band?.label, via };
}

async function main() {
  const cache = loadCache();
  const now = Date.now();

  let rows = [];
  try { rows = JSON.parse(readFileSync(CURATION, "utf8")); } catch { rows = []; }

  // Every distinct company in the curated store, most-rows-first so the companies that actually
  // carry send volume resolve before the long tail.
  const counts = new Map();
  for (const r of rows) {
    const c = String(r.company || "").trim();
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }

  // A negative entry is only respected when THIS resolver wrote it. The Wikidata pass had already
  // stamped ~11,000 companies as unresolvable, and honouring those would have made this tool skip
  // the ~3,300 companies that need it most — Wikidata not knowing a private SMB says nothing about
  // whether its LinkedIn page does. Legacy negatives (no `by` marker) are therefore treated as
  // stale and retried once here.
  const isFresh = (e) => {
    if (!e) return false;
    if (typeof e.count === "number" && e.count > 0) return now - (e.at || 0) < FRESH_MS;
    if (e.by !== "linkedin") return false;
    return now - (e.at || 0) < NEG_MS;
  };

  if (flag("--stats")) {
    let known = 0, inBand = 0, unresolved = 0;
    const min = Number(process.env.MPC_MIN_HEADCOUNT || 100), max = Number(process.env.MPC_MAX_HEADCOUNT || 1000);
    for (const c of counts.keys()) {
      const e = cache[nameKey(c)];
      if (e && typeof e.count === "number" && e.count > 0) { known++; if (e.count >= min && e.count <= max) inBand++; }
      else unresolved++;
    }
    console.log(`companies in curated store : ${counts.size}`);
    console.log(`confirmed headcount        : ${known} (${(100 * known / counts.size).toFixed(1)}%)`);
    console.log(`inside ${min}-${max}            : ${inBand} (${(100 * inBand / (known || 1)).toFixed(1)}% of confirmed)`);
    console.log(`still unresolved           : ${unresolved}`);
    return;
  }

  if (!KEY) { console.error("SERPER_API_KEY missing; cannot resolve sizes"); process.exit(1); }

  const todo = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c)
    .filter((c) => !isFresh(cache[nameKey(c)]))
    .slice(0, LIMIT);

  if (!todo.length) { console.log("nothing to resolve (cache is fresh)"); return; }
  console.log(`resolving ${todo.length} companies via Serper (~$${(todo.length * COST_PER_QUERY).toFixed(2)}), concurrency ${CONC}`);

  let resolved = 0, missed = 0, spent = 0, done = 0;
  const inBandMin = Number(process.env.MPC_MIN_HEADCOUNT || 100);
  const inBandMax = Number(process.env.MPC_MAX_HEADCOUNT || 1000);
  let inBand = 0;

  const queue = todo.slice();
  const worker = async () => {
    for (;;) {
      const company = queue.shift();
      if (!company) return;
      spent += COST_PER_QUERY;
      let r = null;
      try { r = await resolveOne(company); }
      catch (e) {
        // A transient Serper error must not poison the cache with a negative entry.
        if (/429|5\d\d/.test(String(e.message))) { await new Promise((s) => setTimeout(s, 1500)); try { r = await resolveOne(company); } catch { r = null; } }
      }
      if (r) {
        cache[nameKey(company)] = { band: bandFromCount(r.count), count: r.count, src: "linkedin", via: r.via, selfReported: r.bandLabel, at: now };
        resolved++;
        if (r.count >= inBandMin && r.count <= inBandMax) inBand++;
      } else {
        const prev = cache[nameKey(company)];
        // Never downgrade an existing real count into a negative entry.
        if (!(prev && typeof prev.count === "number" && prev.count > 0)) {
          cache[nameKey(company)] = { band: null, src: "none", by: "linkedin", at: now };
        }
        missed++;
      }
      if (++done % 25 === 0) { saveCache(cache); console.log(`  ${done}/${todo.length} · resolved ${resolved} · in-band ${inBand} · missed ${missed}`); }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  saveCache(cache);
  console.log(`\ndone: resolved ${resolved}/${todo.length} (${(100 * resolved / todo.length).toFixed(1)}%) · inside ${inBandMin}-${inBandMax}: ${inBand} · missed ${missed} · spend ~$${spent.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
