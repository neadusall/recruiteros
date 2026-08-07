/**
 * Regression suite for the In-Market paid NAMING search backend (lib/inmarket/webSearch.ts).
 *
 * What this guards, and why it matters: the free search scrapers are IP-throttled to death from
 * the app box, so this module is the ONLY thing that names a decision-maker for a company with no
 * public team page — which is the gate on a role earning an email, and therefore on video supply.
 * Two properties have to hold or it does damage instead of good:
 *
 *   1. PROVIDER ORDER — Serper is measurably cheaper AND better at `site:linkedin.com/in` than
 *      DataForSEO's live endpoint, so a box holding both credentials must pick Serper. Silently
 *      flipping that order is a 10–20x cost regression that nothing else would catch.
 *   2. THE SPEND CEILING IS REAL — naming retries every unnamed company on a 90-minute cycle and
 *      the in-process caches are wiped by every deploy, so an off-by-one here is an unbounded
 *      bill. The cap must hold exactly, survive a restart, and reset on a new UTC day.
 *
 * Run: npx tsx scripts/test-inmarket-websearch.mts   (from integration/)
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the snapshot store at a scratch dir BEFORE lib/db is imported, so the budget counter
// persists to a throwaway file instead of the real data volume.
process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "ros-websearch-"));

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else failures.push(name);
}

function clearProviders(): void {
  delete process.env.SERPER_API_KEY;
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  delete process.env.RAPID_WEBSEARCH_KEY;
  delete process.env.INMARKET_SEARCH_PROVIDER;
}

const ws = await import("../lib/inmarket/webSearch");

/* ---------------------------------------------------------------- */
/* 1. Provider selection                                             */
/* ---------------------------------------------------------------- */

clearProviders();
check("no credentials → no provider", ws.webSearchProvider() === null);
check("no credentials → not enabled", ws.webSearchEnabled() === false);

process.env.RAPID_WEBSEARCH_KEY = "k";
check("rapidapi alone is used", ws.webSearchProvider() === "rapidapi");

process.env.DATAFORSEO_LOGIN = "l";
process.env.DATAFORSEO_PASSWORD = "p";
check("dataforseo outranks rapidapi", ws.webSearchProvider() === "dataforseo");

process.env.SERPER_API_KEY = "s";
check("serper outranks dataforseo (cheaper AND better)", ws.webSearchProvider() === "serper");
check("any credential → enabled", ws.webSearchEnabled() === true);

// A half-configured DataForSEO account must not register as usable.
clearProviders();
process.env.DATAFORSEO_LOGIN = "l";
check("dataforseo login without password → unusable", ws.webSearchProvider() === null);

// Explicit pins.
clearProviders();
process.env.SERPER_API_KEY = "s";
process.env.DATAFORSEO_LOGIN = "l";
process.env.DATAFORSEO_PASSWORD = "p";
process.env.INMARKET_SEARCH_PROVIDER = "dataforseo";
check("pin overrides the default order", ws.webSearchProvider() === "dataforseo");
process.env.INMARKET_SEARCH_PROVIDER = "off";
check("pin 'off' disables the paid hop", ws.webSearchProvider() === null);
check("pin 'off' → not enabled", ws.webSearchEnabled() === false);
process.env.INMARKET_SEARCH_PROVIDER = "rapidapi";
check("pin to an unconfigured provider yields null (never a silent fallback)", ws.webSearchProvider() === null);
delete process.env.INMARKET_SEARCH_PROVIDER;

/* ---------------------------------------------------------------- */
/* 2. The daily ceiling                                              */
/* ---------------------------------------------------------------- */

delete process.env.INMARKET_SEARCH_DAILY_MAX;
check("default cap is 2000", ws.dailyQueryCap() === 2_000);
process.env.INMARKET_SEARCH_DAILY_MAX = "3";
check("cap honors the env override", ws.dailyQueryCap() === 3);
process.env.INMARKET_SEARCH_DAILY_MAX = "not-a-number";
check("a junk cap falls back to the default, never to unlimited", ws.dailyQueryCap() === 2_000);
process.env.INMARKET_SEARCH_DAILY_MAX = "0";
check("cap 0 is respected as a real zero", ws.dailyQueryCap() === 0);
check("cap 0 → not ready (never spends)", (await ws.webSearchReady()) === false);

// Spend exactly to the cap and confirm it stops there. Every provider call is stubbed, so this
// counts reservations without touching a vendor.
process.env.INMARKET_SEARCH_DAILY_MAX = "3";
const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = (async () => {
  calls++;
  return new Response(JSON.stringify({ organic: [{ title: "Jane Doe - VP Eng - Acme", link: "https://linkedin.com/in/jd" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

check("ready while budget remains", (await ws.webSearchReady()) === true);
const r1 = await ws.webSearchResults("q1");
check("a funded query returns parsed results", r1.length === 1 && r1[0].title.startsWith("Jane Doe"));
await ws.webSearchResults("q2");
await ws.webSearchResults("q3");
const spent = await ws.webSearchBudget();
check("budget counts every query", spent.used === 3 && spent.cap === 3);
check("exhausted budget → not ready (caller falls back to free)", (await ws.webSearchReady()) === false);

const overrun = await ws.webSearchResults("q4");
check("a query past the cap returns empty", overrun.length === 0);
check("a query past the cap never reaches the vendor", calls === 3);
const after = await ws.webSearchBudget();
check("a refused query does not inflate the counter", after.used === 3);

// An empty query is not chargeable.
calls = 0;
process.env.INMARKET_SEARCH_DAILY_MAX = "50";
await ws.webSearchResults("");
check("an empty query spends nothing", calls === 0 && (await ws.webSearchBudget()).used === 3);

// Titles helper drops blanks.
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ organic: [{ title: "A - B - C" }, { title: "" }, { link: "https://x" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
const titles = await ws.webSearchTitles("q");
check("titles helper returns only non-empty titles", titles.length === 1 && titles[0] === "A - B - C");

// A vendor error must degrade to empty, not throw — the caller treats [] as "no name found".
globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
const errored = await ws.webSearchResults("q");
check("a vendor 5xx degrades to empty rather than throwing", errored.length === 0);

globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
const threw = await ws.webSearchResults("q");
check("a network failure degrades to empty rather than throwing", threw.length === 0);

globalThis.fetch = realFetch;

/* ---------------------------------------------------------------- */

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) {
  console.error("FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
