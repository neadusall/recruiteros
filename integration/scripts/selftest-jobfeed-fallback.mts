/* Does the RapidAPI key reach any job feed OTHER than the degraded JSearch search?
 * The code already supports a second provider shape (RAPID_JOBS_PROVIDER=active-ats).
 * A RapidAPI key only works on APIs the account is SUBSCRIBED to, so this reports
 * subscribed-and-working vs not-subscribed (403) vs subscribed-but-empty.
 * Run: npx tsx scripts/selftest-jobfeed-fallback.mts */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const KEY = process.env.RAPID_JOBS_KEY!;

const CANDIDATES: { host: string; path: string; qs: string; pick: (j: unknown) => number }[] = [
  { host: "active-jobs-db.p.rapidapi.com", path: "/active-ats-7d", qs: "title_filter=%22warehouse%20manager%22&location_filter=%22United%20States%22&limit=10",
    pick: (j) => Array.isArray(j) ? j.length : -1 },
  { host: "active-jobs-db.p.rapidapi.com", path: "/active-ats-24h", qs: "title_filter=%22nurse%22&location_filter=%22United%20States%22&limit=10",
    pick: (j) => Array.isArray(j) ? j.length : -1 },
  { host: "jsearch.p.rapidapi.com", path: "/search-v2", qs: "query=warehouse%20manager&country=us&num_pages=1",
    pick: (j) => (j as { data?: { jobs?: unknown[] } })?.data?.jobs?.length ?? -1 },
  { host: "linkedin-job-search-api.p.rapidapi.com", path: "/active-jb-7d", qs: "title_filter=%22nurse%22&location_filter=%22United%20States%22&limit=10",
    pick: (j) => Array.isArray(j) ? j.length : -1 },
  { host: "indeed12.p.rapidapi.com", path: "/jobs/search", qs: "query=warehouse%20manager&location=united%20states",
    pick: (j) => (j as { hits?: unknown[] })?.hits?.length ?? -1 },
];

for (const c of CANDIDATES) {
  try {
    const res = await fetch(`https://${c.host}${c.path}?${c.qs}`, {
      headers: { "X-RapidAPI-Key": KEY, "X-RapidAPI-Host": c.host, Accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
    const txt = await res.text();
    let j: unknown = null; try { j = JSON.parse(txt); } catch { /* keep raw */ }
    const n = j ? c.pick(j) : -1;
    const verdict = res.status === 403 ? "NOT SUBSCRIBED"
      : res.status === 404 ? "wrong endpoint"
      : !res.ok ? `HTTP ${res.status}`
      : n > 0 ? `WORKS — ${n} jobs`
      : n === 0 ? "subscribed but EMPTY"
      : "unexpected shape";
    console.log(`${String(res.status).padEnd(4)} ${verdict.padEnd(22)} ${c.host}${c.path}`);
    if (res.status !== 200 || n <= 0) console.log(`      ${txt.slice(0, 160)}`);
  } catch (e) {
    console.log(`ERR  ${(e as Error).message.slice(0, 40).padEnd(22)} ${c.host}${c.path}`);
  }
}
