/**
 * Regression suite: the DataForSEO operator-surcharge dodge + the naming failover guards.
 *
 *   npx tsx scripts/test-serp-rewrite.mts        (from integration/)
 *
 * Pins the three behaviors that money depends on:
 *   1. rewriteSiteOperators — site: operators become quoted phrases (DataForSEO bills 5x for
 *      the operator; the quoted form measured identical rows at 1/5th the bill, 2026-08-14);
 *   2. matchesSitePrefixes — the post-filter that stands in for the operator's guarantee;
 *   3. missSuppressed + the provider ladder — the guards that stop the 90-minute naming cycle
 *      from re-buying known misses and keep naming alive when a provider runs out of credits
 *      (on 2026-08-13, 6,673 queries were spent re-asking a dry provider for nothing).
 */

import { rewriteSiteOperators, matchesSitePrefixes } from "../lib/serpRewrite";
import { missSuppressed, webSearchProviderOrder, webSearchProvider } from "../lib/inmarket/webSearch";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, note = ""): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${note ? ` — ${note}` : ""}`); }
}

/* --- 1. the rewrite ------------------------------------------------------ */

const r1 = rewriteSiteOperators('site:linkedin.com/in "VP of Engineering" "Datadog"');
check("site: becomes a quoted phrase", r1.query === '"linkedin.com/in" "VP of Engineering" "Datadog"', r1.query);
check("the demanded prefix is reported for post-filtering", r1.sitePrefixes.length === 1 && r1.sitePrefixes[0] === "linkedin.com/in");
check("a rewritten query says so", r1.changed === true);

const r2 = rewriteSiteOperators('"Director of Operations" "Gusto" hiring');
check("a query with no site: passes through untouched", r2.query === '"Director of Operations" "Gusto" hiring' && !r2.changed);

const r3 = rewriteSiteOperators("site:https://www.linkedin.com/in/ recruiter");
check("protocol and www noise are stripped from the operator", r3.sitePrefixes[0] === "linkedin.com/in", JSON.stringify(r3));

const r4 = rewriteSiteOperators('site:linkedin.com/in site:linkedin.com/pub "Jane"');
check("every site: operator is rewritten, prefixes deduped per operator",
  r4.sitePrefixes.length === 2 && r4.query === '"linkedin.com/in" "linkedin.com/pub" "Jane"', r4.query);

const r5 = rewriteSiteOperators("  site:linkedin.com/in   spaced   out  ");
check("whitespace is collapsed after the rewrite", r5.query === '"linkedin.com/in" spaced out', JSON.stringify(r5.query));

check("mid-word 'site:' is not an operator",
  rewriteSiteOperators("opposite:day").changed === false);

/* --- 2. the post-filter -------------------------------------------------- */

const prefixes = ["linkedin.com/in"];
check("a plain profile URL satisfies the original operator",
  matchesSitePrefixes("https://www.linkedin.com/in/jane-doe", prefixes));
check("a country subdomain passes, the way Google's own site: treats it",
  matchesSitePrefixes("https://uk.linkedin.com/in/john", prefixes));
check("an off-domain row is dropped",
  !matchesSitePrefixes("https://twitter.com/jane", prefixes));
check("company pages do not satisfy a /in restriction",
  !matchesSitePrefixes("https://www.linkedin.com/company/datadog", prefixes));
check("no prefixes means no restriction", matchesSitePrefixes("https://anything.example", []));

/* --- 3. the miss cache policy -------------------------------------------- */

const now = new Date("2026-08-14T12:00:00Z");
const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
check("an unseen query is never suppressed", !missSuppressed(undefined, now, 4, 7));
check("misses under the cap keep retrying", !missSuppressed({ n: 3, at: iso(0) }, now, 4, 7));
check("the cap-th consecutive miss suppresses the query", missSuppressed({ n: 4, at: iso(0) }, now, 4, 7));
check("suppression expires after the retry window, so people who changed jobs get re-found",
  !missSuppressed({ n: 9, at: iso(8) }, now, 4, 7));
check("a garbage timestamp fails open (spend a query rather than silently never retry)",
  !missSuppressed({ n: 9, at: "not-a-date" }, now, 4, 7));

/* --- 4. the provider ladder ---------------------------------------------- */

const env = process.env;
const saved = {
  pin: env.INMARKET_SEARCH_PROVIDER, dl: env.DATAFORSEO_LOGIN, dp: env.DATAFORSEO_PASSWORD,
  sk: env.SERPER_API_KEY, rk: env.RAPID_WEBSEARCH_KEY,
};
env.DATAFORSEO_LOGIN = "u"; env.DATAFORSEO_PASSWORD = "p"; env.SERPER_API_KEY = "k";
delete env.RAPID_WEBSEARCH_KEY; delete env.INMARKET_SEARCH_PROVIDER;

check("DataForSEO leads the ladder (never-expiring balance + auto-recharge)",
  JSON.stringify(webSearchProviderOrder()) === '["dataforseo","serper"]', JSON.stringify(webSearchProviderOrder()));
check("webSearchProvider reports the ladder head", webSearchProvider() === "dataforseo");

env.INMARKET_SEARCH_PROVIDER = "serper";
check("a pin gets exactly the pinned provider, no ladder",
  JSON.stringify(webSearchProviderOrder()) === '["serper"]');

env.INMARKET_SEARCH_PROVIDER = "off";
check("'off' disables the paid hop", webSearchProviderOrder().length === 0 && webSearchProvider() === null);

delete env.INMARKET_SEARCH_PROVIDER;
delete env.DATAFORSEO_LOGIN; delete env.DATAFORSEO_PASSWORD;
check("with only Serper configured the ladder is Serper alone",
  JSON.stringify(webSearchProviderOrder()) === '["serper"]');

// Restore whatever the shell had, so this suite can run inside a larger harness.
saved.pin !== undefined ? (env.INMARKET_SEARCH_PROVIDER = saved.pin) : delete env.INMARKET_SEARCH_PROVIDER;
saved.dl !== undefined ? (env.DATAFORSEO_LOGIN = saved.dl) : delete env.DATAFORSEO_LOGIN;
saved.dp !== undefined ? (env.DATAFORSEO_PASSWORD = saved.dp) : delete env.DATAFORSEO_PASSWORD;
saved.sk !== undefined ? (env.SERPER_API_KEY = saved.sk) : delete env.SERPER_API_KEY;
saved.rk !== undefined ? (env.RAPID_WEBSEARCH_KEY = saved.rk) : delete env.RAPID_WEBSEARCH_KEY;

/* ------------------------------------------------------------------------- */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
