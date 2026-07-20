/**
 * RecruitersOS · JD Sourcing · regenerate lib/sourcing/usPlacesData.ts
 *
 * Merges two free GeoNames exports (both public-domain/CC-BY, no API key):
 *   1. export/zip/US.zip        -> US.txt         ZIP centroids; broad place-name coverage
 *   2. export/dump/cities1000.zip -> cities1000.txt  real municipalities + POPULATION
 *
 * Neither alone is enough: the ZIP file labels suburbs with their USPS parent city
 * ("Garfield Heights, OH" is filed under Cleveland), and the gazetteer misses
 * unincorporated place names recruiters still type. The union covers both.
 *
 * Usage:  node scripts/gen-us-places.mjs <dir-with-US.txt-and-cities1000.txt> <out.ts>
 */
import fs from "fs";

const dir = process.argv[2] || ".";
const out = process.argv[3] || "usPlacesData.ts";

/** state -> city -> { lat, lon, weight } ; weight = population, or a ZIP-count proxy. */
const byState = new Map();
const clean = (s) => s.toLowerCase().replace(/[|,:\n\t]/g, " ").replace(/\s+/g, " ").trim();

function put(st, city, lat, lon, weight, authoritative) {
  if (!city || !/^[A-Z]{2}$/.test(st) || !isFinite(lat) || !isFinite(lon)) return;
  if (!byState.has(st)) byState.set(st, new Map());
  const m = byState.get(st);
  const prev = m.get(city);
  // Gazetteer rows (authoritative: real municipality + census population) always win
  // over ZIP-centroid rows, which can be dragged off-center by a sprawling ZIP.
  if (prev && prev.authoritative && !authoritative) return;
  if (prev && !prev.authoritative && !authoritative) {
    prev.lat = (prev.lat * prev.n + lat) / (prev.n + 1);
    prev.lon = (prev.lon * prev.n + lon) / (prev.n + 1);
    prev.n++;
    prev.weight = prev.n * 1500;
    return;
  }
  m.set(city, { lat, lon, weight, n: 1, authoritative });
}

// 1. Municipalities (authoritative coordinates + population)
for (const ln of fs.readFileSync(`${dir}/cities1000.txt`, "utf8").split("\n")) {
  const f = ln.split("\t");
  if (f.length < 15 || f[8] !== "US") continue;
  const st = (f[10] || "").trim();
  const pop = parseInt(f[14], 10) || 0;
  put(st, clean(f[1]), parseFloat(f[4]), parseFloat(f[5]), Math.max(pop, 1000), true);
  // ASCII name, when it differs (accented places).
  const ascii = clean(f[2]);
  if (ascii && ascii !== clean(f[1])) put(st, ascii, parseFloat(f[4]), parseFloat(f[5]), Math.max(pop, 1000), true);
}

// 2. ZIP place names (coverage for everything the gazetteer skipped)
for (const ln of fs.readFileSync(`${dir}/US.txt`, "utf8").split("\n")) {
  const f = ln.split("\t");
  if (f.length < 12) continue;
  put((f[4] || "").trim(), clean(f[2]), parseFloat(f[9]), parseFloat(f[10]), 1500, false);
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
 * ${entries} unique "city + state" places merged from the GeoNames ZIP-centroid export and
 * the cities1000 municipality gazetteer. Each entry carries a coordinate and a weight
 * (census population where known, else a ZIP-count proxy) used to rank prominence and to
 * disambiguate a bare city name that exists in several states ("Springfield").
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
