/* ============================================================
   RecruitersOS · Hiring-signal harvester
   Pulls REAL open roles from public ATS boards (Greenhouse, Lever,
   Ashby), normalizes them into companies + hiring signals, rolls up
   per-company velocity, and writes a JSON database the app reads.

   Run:  node integration/scripts/harvest.mjs
   Out:  assets/data/hiring-signals.json   (companies that are hiring)

   No API keys. Wrong slugs 404 and are skipped. Be a good citizen:
   modest concurrency + per-request timeout.
   ============================================================ */

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GREENHOUSE, LEVER, ASHBY } from "./seed-slugs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "assets", "data", "hiring-signals.json");

const CONCURRENCY = 8;
const TIMEOUT_MS = 12000;
const NOW = new Date().toISOString();

/* ---------- tiny fetch-with-timeout + JSON ---------- */
async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json", "User-Agent": "RecruitersOS-harvester/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* ---------- per-provider board fetchers → normalized roles ---------- */
async function greenhouse(slug) {
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`);
  if (!d?.jobs?.length) return null;
  return {
    company: prettyName(slug), slug, ats: "Greenhouse",
    roles: d.jobs.map((j) => ({ id: String(j.id), title: j.title, location: j.location?.name, dept: j.departments?.[0]?.name, url: j.absolute_url, postedAt: j.updated_at })),
  };
}
async function lever(slug) {
  const d = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (!Array.isArray(d) || !d.length) return null;
  return {
    company: prettyName(slug), slug, ats: "Lever",
    roles: d.map((p) => ({ id: p.id, title: p.text, location: p.categories?.location, dept: p.categories?.team, url: p.hostedUrl, postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : NOW })),
  };
}
async function ashby(slug) {
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
  if (!d?.jobs?.length) return null;
  return {
    company: prettyName(slug), slug, ats: "Ashby",
    roles: d.jobs.map((j) => ({ id: j.id, title: j.title, location: j.location, dept: j.department, url: j.jobUrl, postedAt: j.publishedAt })),
  };
}

function prettyName(slug) {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ---------- best-effort industry tag (so industry search works) ---------- */
const INDUSTRY_MAP = {
  stripe: "Fintech", plaid: "Fintech", brex: "Fintech", ramp: "Fintech", mercury: "Fintech",
  affirm: "Fintech", sofi: "Fintech", chime: "Fintech", marqeta: "Fintech", upstart: "Fintech",
  robinhood: "Fintech", coinbase: "Cryptocurrency", carta: "Fintech", betterment: "Fintech",
  wealthfront: "Fintech", lithic: "Fintech", unit: "Fintech", increase: "Fintech", moov: "Fintech",
  databricks: "AI & Machine Learning", anthropic: "AI & Machine Learning", openai: "AI & Machine Learning",
  cohere: "AI & Machine Learning", huggingface: "AI & Machine Learning", scaleai: "AI & Machine Learning",
  perplexity: "AI & Machine Learning", glean: "AI & Machine Learning", mistral: "AI & Machine Learning",
  runway: "AI & Machine Learning", together: "AI & Machine Learning", baseten: "AI & Machine Learning",
  airbnb: "Travel", doordash: "Food & Beverage", instacart: "Grocery", faire: "E-commerce",
  flexport: "Logistics & Supply Chain", veho: "Logistics & Supply Chain", shippo: "Logistics & Supply Chain",
  whoop: "Health Tech", oura: "Health Tech", calm: "Digital Health", headspace: "Digital Health",
  noom: "Health Tech", ro: "Digital Health", hims: "Digital Health", cerebral: "Mental Health",
  tempus: "Health Tech", flatiron: "Health Tech", abridge: "Health Tech", commure: "Health Tech",
  snyk: "Cybersecurity", cloudflare: "Cybersecurity", vanta: "Cybersecurity", drata: "Cybersecurity",
  "1password": "Cybersecurity", tailscale: "Cybersecurity", teleport: "Cybersecurity", persona: "Cybersecurity",
  datadog: "SaaS", gitlab: "SaaS", hashicorp: "SaaS", retool: "SaaS", vercel: "SaaS", netlify: "SaaS",
  notion: "SaaS", figma: "SaaS", linear: "SaaS", airtable: "SaaS", asana: "SaaS", webflow: "SaaS",
  sourcegraph: "SaaS", supabase: "SaaS", replit: "SaaS", posthog: "SaaS", launchdarkly: "SaaS",
  rippling: "SaaS", gusto: "SaaS", deel: "SaaS", lattice: "SaaS", remote: "SaaS",
  fivetran: "Data & Analytics", dbt: "Data & Analytics", airbyte: "Data & Analytics",
  hex: "Data & Analytics", amplitude: "Data & Analytics", mixpanel: "Data & Analytics",
  pinterest: "Social Media", reddit: "Social Media", discord: "Social Media", substack: "Media",
  patreon: "Creator Economy", whatnot: "E-commerce", poshmark: "E-commerce", opendoor: "PropTech",
  compass: "Real Estate", anduril: "Defense", labelbox: "AI & Machine Learning",
};
function industryFor(slug, roles) {
  if (INDUSTRY_MAP[slug]) return INDUSTRY_MAP[slug];
  const hay = (slug + " " + roles.slice(0, 6).map((r) => r.title + " " + (r.dept || "")).join(" ")).toLowerCase();
  if (/health|clinical|patient|care|bio|pharma|medical/.test(hay)) return "Health Tech";
  if (/pay|bank|financ|lend|credit|trading|fintech|invoice/.test(hay)) return "Fintech";
  if (/security|cyber|compliance|fraud|threat/.test(hay)) return "Cybersecurity";
  if (/\bai\b|machine learning|\bml\b|model|data scien/.test(hay)) return "AI & Machine Learning";
  if (/data|analytics|warehouse|pipeline/.test(hay)) return "Data & Analytics";
  if (/logistics|supply|freight|delivery|fleet/.test(hay)) return "Logistics & Supply Chain";
  if (/retail|commerce|marketplace|shop|consumer/.test(hay)) return "E-commerce";
  if (/game|gaming|studio/.test(hay)) return "Gaming";
  if (/education|learning|student|course/.test(hay)) return "EdTech";
  return "SaaS";
}

/* ---------- concurrency pool ---------- */
async function pool(items, worker, n = CONCURRENCY) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

/* ---------- role → function / seniority (mirror filters.ts) ---------- */
function classify(title) {
  const t = (title || "").toLowerCase();
  const fn = /engineer|developer|devops|sre|platform|swe|software/.test(t) ? "engineering"
    : /product manager|product owner|head of product|product/.test(t) ? "product"
    : /data|machine learning|\bml\b|analytics|scientist/.test(t) ? "data"
    : /design|ux|ui|brand/.test(t) ? "design"
    : /sales|account executive|account exec|revenue|partnerships/.test(t) ? "sales"
    : /market|growth|demand gen|content|seo/.test(t) ? "marketing"
    : /recruit|talent|people|hr\b/.test(t) ? "people_hr"
    : /operations|ops\b|program|project manager/.test(t) ? "operations"
    : /ceo|cto|cfo|coo|chief|founder|vp |vice president|head of/.test(t) ? "executive" : "other";
  const sen = /chief|cto|ceo|cfo|coo|cmo|cro|cpo/.test(t) ? "c_level"
    : /\bvp\b|vice president/.test(t) ? "vp"
    : /director|head of/.test(t) ? "director"
    : /manager|lead|principal|staff/.test(t) ? "manager"
    : /senior|sr\.?/.test(t) ? "senior" : "mid";
  const decisionMaker = ["manager", "director", "vp", "c_level"].includes(sen);
  return { function: fn, seniority: sen, decisionMaker };
}

/* ---------- build signal records from one company's roles ---------- */
function toSignals(board) {
  const roles = board.roles.filter((r) => r.title);
  if (!roles.length) return [];
  const n = roles.length;
  // company-level type: a surge if many open roles, else individual postings.
  const baseType = n >= 4 ? "hiring_velocity" : "job_posting";
  const funcs = [...new Set(roles.map((r) => classify(r.title).function))];
  const score = Math.min(98, (n >= 4 ? 78 : 68) + Math.min(18, n));
  // one signal row per company (the company that is hiring), with role rollup,
  // plus we keep the individual roles for drill-down + per-role targeting.
  return [{
    type: baseType,
    motion: "business_dev",
    company: board.company,
    industry: industryFor(board.slug, roles),
    ats: board.ats,
    rolesOpen: n,
    functions: funcs,
    locations: [...new Set(roles.map((r) => r.location).filter(Boolean))].slice(0, 6),
    score,
    eventAt: roles.map((r) => r.postedAt).filter(Boolean).sort().slice(-1)[0] || NOW,
    sampleRoles: roles.slice(0, 30).map((r) => ({ title: r.title, location: r.location, dept: r.dept, url: r.url, ...classify(r.title) })),
  }];
}

/* ---------- main ---------- */
async function main() {
  const started = Date.now();
  const jobs = [
    ...GREENHOUSE.map((s) => ({ slug: s, fn: greenhouse })),
    ...LEVER.map((s) => ({ slug: s, fn: lever })),
    ...ASHBY.map((s) => ({ slug: s, fn: ashby })),
  ];
  console.log(`Harvesting ${jobs.length} boards (Greenhouse ${GREENHOUSE.length}, Lever ${LEVER.length}, Ashby ${ASHBY.length})...`);

  const boards = (await pool(jobs, (j) => j.fn(j.slug))).filter(Boolean);
  // de-dup companies by name (a slug may appear on >1 ATS list)
  const byCompany = new Map();
  for (const b of boards) {
    const key = b.company.toLowerCase();
    if (!byCompany.has(key) || byCompany.get(key).roles.length < b.roles.length) byCompany.set(key, b);
  }

  const signals = [...byCompany.values()].flatMap(toSignals).sort((a, b) => b.score - a.score);
  const totalRoles = signals.reduce((s, x) => s + x.rolesOpen, 0);

  const db = {
    generatedAt: NOW,
    source: "public ATS boards (Greenhouse, Lever, Ashby)",
    companies: signals.length,
    totalOpenRoles: totalRoles,
    signals,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(db, null, 2), "utf8");

  // Also seed the LIVE in-market pool the Command Center reads, so the harvest fills
  // the real app (not just the standalone campaign-builder). Writes the db file-backend
  // snapshot directly into ROS_DATA_DIR. Same store the accumulator grows from there on.
  const poolWritten = await writePoolSnapshot(signals, totalRoles);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n✓ ${signals.length} hiring companies, ${totalRoles} open roles, in ${secs}s`);
  console.log(`  Boards that responded: ${boards.length}/${jobs.length}`);
  console.log(`  Wrote ${OUT}`);
  if (poolWritten) console.log(`  Seeded live in-market pool → ${poolWritten}`);
  else console.log(`  (set ROS_DATA_DIR to also seed the live in-market pool)`);
  if (signals[0]) console.log(`  Top: ${signals.slice(0, 5).map((s) => `${s.company} (${s.rolesOpen})`).join(", ")}`);
}

/* ---------- consolidate: map harvested signals → live in-market pool ---------- */
function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

async function writePoolSnapshot(signals, totalRoles) {
  const dataDir = process.env.ROS_DATA_DIR || join(__dirname, "..", ".data");
  const nowMs = Date.now();
  // Pool is curated to 100-5,000 employees (mid-market). We don't have exact headcounts at
  // harvest time, but a very high open-role count is a strong proxy for an enterprise over
  // the cap, so we pre-trim the obvious megacorps from the seed. Wikidata size resolution in
  // the accumulator then enforces the exact 100-5,000 band over the following cycles.
  const ENTERPRISE_ROLE_PROXY = 400;
  const banded = signals.filter((s) => (s.rolesOpen || 0) <= ENTERPRISE_ROLE_PROXY);
  // Map each harvested company → InMarketLead (shape in lib/inmarket/index.ts),
  // wrapped as a PoolEntry { lead, at, firstAt } (shape in lib/inmarket/pool.ts).
  const entries = banded.map((s) => {
    const roles = (s.sampleRoles || []);
    const lead = {
      id: `${(s.ats || "ats").toLowerCase()}_${slugify(s.company)}`,
      company: s.company,
      industry: s.industry,
      location: (s.locations || []).find((l) => /,\s*(US|USA)$|, [A-Z]{2}$|United States|Remote/.test(l || "")) || (s.locations || [])[0],
      reason: s.rolesOpen >= 4 ? `Posted ${s.rolesOpen} open roles` : `Hiring for ${roles[0]?.title || "open roles"}`,
      signalType: s.type,
      score: s.score,
      scoreReasons: [`${s.rolesOpen} open roles`, s.ats].filter(Boolean),
      roles: roles.map((r) => r.title).slice(0, 30),
      roleDetails: roles.map((r) => ({ title: r.title, postedAt: s.eventAt, location: r.location })),
      boardSource: s.ats,
      boardExpandedAt: new Date(nowMs).toISOString(),
      signalAt: s.eventAt,
      postedAt: s.eventAt,
      addedAt: new Date(nowMs).toISOString(),
      sourceUrl: roles[0]?.url,
    };
    return { lead, at: nowMs, firstAt: nowMs };
  });

  const bandedRoles = banded.reduce((sum, s) => sum + (s.rolesOpen || 0), 0);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const stats = { total: entries.length, positions: bandedRoles, lastAddedAt: new Date(nowMs).toISOString(), days: { [today]: entries.length } };

  // COMMITTED SEED — also write the leads to a bundled JSON the app imports at runtime, so a
  // fresh boot (no DB, no env, nothing run) still shows a full Hiring Signals tab. queryPool
  // falls back to this when the live pool is empty; the accumulator grows the real pool.
  const seedPath = join(__dirname, "..", "lib", "inmarket", "seed-pool.json");
  try {
    await writeFile(seedPath, JSON.stringify({ generatedAt: new Date(nowMs).toISOString(), positions: bandedRoles, leads: entries.map((e) => e.lead) }), "utf8");
  } catch { /* seed file is best-effort */ }

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "snap_inmarket_pool_v1.json"), JSON.stringify(entries), "utf8");
    await writeFile(join(dataDir, "snap_inmarket_pool_stats_v1.json"), JSON.stringify(stats), "utf8");
    return dataDir;
  } catch {
    return null;
  }
}

main().catch((e) => { console.error("harvest failed:", e); process.exit(1); });
