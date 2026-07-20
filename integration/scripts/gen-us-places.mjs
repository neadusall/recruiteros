/**
 * RecruitersOS · JD Sourcing · regenerate lib/sourcing/usPlacesData.ts
 *
 * Builds the US place table the radius filter measures against, from free GeoNames
 * exports (public domain / CC-BY, no API key). Run it from a directory holding:
 *
 *   export/dump/cities1000.zip  -> cities1000.txt   municipalities WITH census population
 *   export/dump/US.zip          -> dump/US.txt      the full gazetteer (every populated place)
 *   export/zip/US.zip           -> US.txt           ZIP centroids
 *
 *   node scripts/gen-us-places.mjs <dir> <out.ts>
 *
 * THREE TIERS, highest wins, never averaged across tiers — mixing a precise municipal
 * coordinate with a sprawling ZIP centroid drags the point off the actual town:
 *
 *   1. cities1000  — real municipality + population. Best coordinate, real weight.
 *   2. full dump   — every P-class populated place. This is the COVERAGE tier: it is
 *                    the only source for towns whose population field is 0, e.g.
 *                    Manalapan, NJ, which cities1000 drops and which recruiters
 *                    absolutely do type. Low weight so it never wins a name contest
 *                    against a real city.
 *   3. ZIP file    — USPS place names. Catches unincorporated names the gazetteer
 *                    skips, but files suburbs under their parent city, so it is last.
 *
 * The weight is a prominence proxy used to disambiguate a bare city name that exists in
 * several states ("Springfield"), and to rank query/chip targets. It is NOT a filter.
 */
import fs from "fs";

const dir = process.argv[2] || ".";
const out = process.argv[3] || "usPlacesData.ts";

/** state -> city -> { lat, lon, weight, tier, n } */
const byState = new Map();

// Must match geoRadius.ts norm() EXACTLY or lookups silently miss: norm strips every
// character outside [a-z0-9 -] to a space, so "Coeur d'Alene" is queried as
// "coeur d alene" and the table has to store it under that spelling too.
const clean = (s) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();

/** tier: 1 = municipality (best), 2 = gazetteer coverage, 3 = ZIP centroid (last). */
function put(st, city, lat, lon, weight, tier) {
  if (!city || !/^[A-Z]{2}$/.test(st) || !isFinite(lat) || !isFinite(lon)) return;
  if (!byState.has(st)) byState.set(st, new Map());
  const m = byState.get(st);
  const prev = m.get(city);
  if (!prev) { m.set(city, { lat, lon, weight, tier, n: 1 }); return; }
  if (tier < prev.tier) { m.set(city, { lat, lon, weight, tier, n: 1 }); return; } // better tier wins outright
  if (tier > prev.tier) return;                                                    // worse tier never overwrites
  // Same tier: average the coordinates (several ZIPs for one town) and keep the
  // strongest weight seen.
  prev.lat = (prev.lat * prev.n + lat) / (prev.n + 1);
  prev.lon = (prev.lon * prev.n + lon) / (prev.n + 1);
  prev.n++;
  prev.weight = Math.max(prev.weight, weight);
}

// --- Tier 1: municipalities with population ---------------------------------
for (const ln of fs.readFileSync(`${dir}/cities1000.txt`, "utf8").split("\n")) {
  const f = ln.split("\t");
  if (f.length < 15 || f[8] !== "US") continue;
  const st = (f[10] || "").trim();
  const pop = parseInt(f[14], 10) || 0;
  const lat = parseFloat(f[4]), lon = parseFloat(f[5]);
  put(st, clean(f[1]), lat, lon, Math.max(pop, 1000), 1);
  const ascii = clean(f[2]);
  if (ascii && ascii !== clean(f[1])) put(st, ascii, lat, lon, Math.max(pop, 1000), 1);
}

// --- Tier 2: every populated place in the full gazetteer ---------------------
// Feature class P only (PPL, PPLA, PPLL, ...). Excludes streams, schools, parks and
// the ~2M other features that would balloon the table without naming a place anyone
// puts on a profile.
for (const ln of fs.readFileSync(`${dir}/dump/US.txt`, "utf8").split("\n")) {
  const f = ln.split("\t");
  // Class P = populated places. PPLQ (abandoned) and PPLH (historical) are places
  // nobody lives in any more, so matching a candidate to one is always wrong.
  if (f.length < 15 || f[6] !== "P" || f[7] === "PPLQ" || f[7] === "PPLH") continue;
  const st = (f[10] || "").trim();
  const pop = parseInt(f[14], 10) || 0;
  put(st, clean(f[1]), parseFloat(f[4]), parseFloat(f[5]), Math.max(pop, 200), 2);
}

// --- Tier 3: ZIP centroids ---------------------------------------------------
for (const ln of fs.readFileSync(`${dir}/US.txt`, "utf8").split("\n")) {
  const f = ln.split("\t");
  if (f.length < 12) continue;
  put((f[4] || "").trim(), clean(f[2]), parseFloat(f[9]), parseFloat(f[10]), 500, 3);
}

let entries = 0;
const parts = [];
for (const st of [...byState.keys()].sort()) {
  const items = [...byState.get(st).entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([c, r]) => { entries++; return `${c},${r.lat.toFixed(3)},${r.lon.toFixed(3)},${Math.round(r.weight)}`; });
  parts.push(st + ":" + items.join("|"));
}
const blob = parts.join("\n");
fs.writeFileSync(out, `/**
 * RecruitersOS · JD Sourcing · US place coordinate table (GENERATED — do not hand-edit)
 *
 * ${entries} unique "city + state" places, merged from three GeoNames exports: the
 * cities1000 municipality gazetteer (population), the full US gazetteer's populated
 * places (coverage for towns whose population field is 0), and the ZIP-centroid export
 * (USPS place names). Each entry carries a coordinate and a weight — census population
 * where known, else a tier default — used to rank prominence and to disambiguate a bare
 * city name that exists in several states ("Springfield").
 *
 * Stored as one string on purpose: ~${Math.round(blob.length / 1024)}KB of source that parses
 * lazily into a Map on first geocode, rather than ${entries} object literals the bundler
 * would have to walk. Regenerate with scripts/gen-us-places.mjs.
 *
 * Format: one line per state — "ST:city,lat,lon,weight|city,lat,lon,weight|..."
 */

export const US_PLACES_BLOB = ${JSON.stringify(blob)};

export const US_PLACE_COUNT = ${entries};
`);
console.log("entries", entries, "bytes", blob.length);
