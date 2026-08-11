// RecruitersOS · MPC · ATS slug DISCOVERY (the "thousands of employers" engine).
//
// The free ATS boards (Greenhouse/Lever/Ashby/Workable/Recruitee) are unlimited; the only ceiling
// is how many REAL company slugs we know to probe. This tool discovers them at scale, for $0:
//   1) HARVEST candidate companies from free, keyless job aggregators (Remotive, Arbeitnow,
//      RemoteOK, We Work Remotely). Their apply URLs frequently point straight at an ATS board,
//      so we can extract a HIGH-CONFIDENCE slug directly. Company names become validate-candidates.
//   2) VALIDATE candidates by hitting the ATS board APIs (keyless) and keeping any that return jobs.
//   3) MERGE the winners into /data/snap_inmarket_ats_slugs_ext_v1.json, which the in-market engine
//      now folds into its free directory (atsDirectory.ts) within ~10 min. No code deploy per grow.
//
// Idempotent + additive: re-running only grows the set. Runs in the app container (has /data).
//
//   node scripts/mpc/discover-ats-slugs.mjs

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const OUT_FILE = process.env.ATS_EXT_FILE || "/data/snap_inmarket_ats_slugs_ext_v1.json";
const MAX_VALIDATE = Number(process.env.ATS_MAX_VALIDATE || 3000); // cap name-candidate probes per run
const CONC = Number(process.env.ATS_CONCURRENCY || 12);
const UA = { "user-agent": "Mozilla/5.0", Accept: "application/json, text/xml, */*" };

function slugify(name) {
  return String(name || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "").trim();
}

// Extract an ATS slug from an apply URL if it points at a known board (high confidence = real).
function slugFromUrl(u) {
  if (!u) return null;
  let m;
  if ((m = /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9][a-z0-9-]+)/i.exec(u))) return m[1].toLowerCase();
  if ((m = /\/\/([a-z0-9][a-z0-9-]+)\.greenhouse\.io/i.exec(u))) return m[1].toLowerCase();
  if ((m = /jobs\.lever\.co\/([a-z0-9][a-z0-9-]+)/i.exec(u))) return m[1].toLowerCase();
  if ((m = /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9-]+)/i.exec(u))) return m[1].toLowerCase();
  if ((m = /apply\.workable\.com\/([a-z0-9][a-z0-9-]+)/i.exec(u))) return m[1].toLowerCase();
  if ((m = /\/\/([a-z0-9][a-z0-9-]+)\.recruitee\.com/i.exec(u))) return m[1].toLowerCase();
  return null;
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.text();
}

const urlSlugs = new Set();   // high-confidence, from real apply links
const candidates = new Set(); // company slugs to validate

// Add both the name-slug and the domain-root as candidates (ATS slugs are usually one or the other).
function addCompany(name, domain) {
  const c = slugify(name); if (c.length >= 3) candidates.add(c);
  const root = String(domain || "").toLowerCase().replace(/^www\./, "").split(".")[0];
  if (root && /^[a-z0-9-]{3,}$/.test(root)) candidates.add(root);
}

// Harvest company names + domains from the app's OWN data on /data (thousands of real companies
// we already sourced). This is the biggest, most reliable candidate source and it's local + free.
function harvestLocal() {
  for (const file of ["/data/snap_inmarket_curation_v1.json", "/data/snap_inmarket_pool_v1.json"]) {
    try {
      if (!existsSync(file)) continue;
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
      walk(raw);
      const rows = arrs.sort((a, b) => b.length - a.length)[0] || [];
      for (const r of rows) { const p = r.lead || r; if (p && (p.company || p.companyName)) addCompany(p.company || p.companyName, p.domain); }
    } catch (e) { console.log(`local ${file}:`, e.message); }
  }
}

async function harvest() {
  harvestLocal();
  // YC public dataset (~5k companies, overwhelmingly on Greenhouse/Lever/Ashby) — keyless.
  try {
    const d = await getJson("https://yc-oss.github.io/api/companies/all.json");
    for (const c of (Array.isArray(d) ? d : [])) { addCompany(c.name, c.website); }
  } catch (e) { console.log("yc-oss:", e.message); }
  // Remotive (keyless JSON)
  try {
    const d = await getJson("https://remotive.com/api/remote-jobs");
    for (const j of (d.jobs || [])) { const s = slugFromUrl(j.url); if (s) urlSlugs.add(s); const c = slugify(j.company_name); if (c.length >= 3) candidates.add(c); }
  } catch (e) { console.log("remotive:", e.message); }
  // Arbeitnow (keyless JSON)
  try {
    const d = await getJson("https://www.arbeitnow.com/api/job-board-api");
    for (const j of (d.data || [])) { const s = slugFromUrl(j.url); if (s) urlSlugs.add(s); const c = slugify(j.company_name); if (c.length >= 3) candidates.add(c); }
  } catch (e) { console.log("arbeitnow:", e.message); }
  // RemoteOK (keyless JSON; first element is metadata)
  try {
    const d = await getJson("https://remoteok.com/api");
    for (const j of d) { if (!j || !j.company) continue; const s = slugFromUrl(j.apply_url || j.url); if (s) urlSlugs.add(s); const c = slugify(j.company); if (c.length >= 3) candidates.add(c); }
  } catch (e) { console.log("remoteok:", e.message); }
  // We Work Remotely RSS
  try {
    const xml = await getText("https://weworkremotely.com/remote-jobs.rss");
    for (const b of xml.split("<item>").slice(1)) {
      const link = (b.match(/<link>([^<]+)<\/link>/) || [])[1];
      const s = slugFromUrl(link); if (s) urlSlugs.add(s);
      const title = (b.match(/<title>([^<]+)<\/title>/) || [])[1] || "";
      const co = slugify(title.split(":")[0]); if (co.length >= 3) candidates.add(co);
    }
  } catch (e) { console.log("wwr:", e.message); }
}

// Validate a slug against the ATS board APIs (keyless). Real = a board returns >=1 job.
async function isRealBoard(slug) {
  const tries = [
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`,
    `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`,
    `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
  ];
  for (const u of tries) {
    try {
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(12_000) });
      if (!r.ok) continue;
      const d = await r.json().catch(() => null);
      if (!d) continue;
      const n = Array.isArray(d) ? d.length
        : Array.isArray(d.jobs) ? d.jobs.length
        : (d.data && Array.isArray(d.data.jobs)) ? d.data.jobs.length : 0;
      if (n > 0) return true;
    } catch { /* try next board shape */ }
  }
  return false;
}

async function main() {
  await harvest();
  console.log(`harvested: ${urlSlugs.size} high-confidence apply-URL slugs, ${candidates.size} name-candidates`);

  let existing = [];
  try { if (existsSync(OUT_FILE)) { const j = JSON.parse(readFileSync(OUT_FILE, "utf8")); if (Array.isArray(j)) existing = j; } } catch { /* start fresh */ }
  const known = new Set(existing.map((s) => String(s).toLowerCase()));
  const before = known.size;

  // Apply-URL slugs are already proven real (they came from live apply links) — accept directly.
  for (const s of urlSlugs) known.add(s);

  // Validate a capped batch of NEW name-candidates concurrently.
  const toCheck = [...candidates].filter((s) => s.length >= 3 && !known.has(s)).slice(0, MAX_VALIDATE);
  let validated = 0, i = 0;
  async function worker() { while (i < toCheck.length) { const s = toCheck[i++]; if (await isRealBoard(s)) { known.add(s); validated++; } } }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  const all = [...known].sort();
  const tmp = OUT_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(all));
  renameSync(tmp, OUT_FILE);
  console.log(`external directory: ${before} -> ${all.length} slugs (+${urlSlugs.size} url-direct, +${validated} validated). File: ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
