/**
 * Regression suite for the JD Sourcing people-search failure classification.
 *
 *   npx tsx scripts/test-sourcing-peoplesearch.mts     (from integration/)
 *
 * Pins the distinction the engine got wrong for months: a listing that is BUSY (429,
 * transient 5xx) is worth retrying query by query, while a listing that is WRONG (key
 * refused, subscription gone, endpoint missing) must stop the engine on the first
 * refusal. Both used to raise a plain Error, so a dead key was retried once per query
 * per page, billed each time, and then collapsed into "search coverage may be partial
 * ... rate-limited" — which reads like a busy afternoon rather than a broken key.
 *
 * Every case uses its own host: the 404 self-heal memoizes per host, and sharing one
 * would leak a healed path between cases.
 */

import { rapidApiPeopleSearch, isPeopleSearchFatal, PeopleSearchFatal } from "../lib/sourcing/discovery";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; } else { failed++; console.error("  FAIL:", name); }
}

const realFetch = globalThis.fetch;

/** Answer every request with a fixed status/body, counting the calls. */
function stubFetch(plan: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = plan(url, init);
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

async function attempt(): Promise<{ error?: Error; rows?: number }> {
  try {
    const rows = await rapidApiPeopleSearch({ name: "recruiter", page: 1, limit: 3 });
    return { rows: rows.length };
  } catch (e) {
    return { error: e as Error };
  }
}

function useHost(host: string, extra: Record<string, string> = {}): void {
  process.env.RAPIDAPI_KEY = "test-key";
  process.env.RAPIDAPI_PEOPLE_SEARCH_HOST = host;
  process.env.RAPIDAPI_PEOPLE_SEARCH_PATH = "/api/v1/search/people?name={query}&page={page}&limit=10";
  process.env.RAPIDAPI_PEOPLE_SEARCH_METHOD = "GET";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

async function run(): Promise<void> {
  /* --- the key itself: fatal, no retry ---------------------------------- */
  for (const status of [401, 403, 402]) {
    useHost(`auth${status}.example.com`);
    const calls = stubFetch(() => ({ status }));
    const { error } = await attempt();
    check(`${status} raises a fatal error`, Boolean(error) && isPeopleSearchFatal(error));
    check(`${status} is not retried`, calls.length === 1);
    check(`${status} names the fix`, /Setup -> JD Sourcing/.test(error?.message ?? ""));
  }

  /* --- a missing endpoint: heal first, then fatal ------------------------ */
  useHost("dead-endpoint.example.com");
  {
    const calls = stubFetch(() => ({ status: 404, body: { message: "Endpoint does not exist" } }));
    const { error } = await attempt();
    check("404 everywhere is fatal", Boolean(error) && isPeopleSearchFatal(error));
    check("404 probes the path variants before giving up", calls.length > 1);
    check("404 message names the host/path setting",
      /RAPIDAPI_PEOPLE_SEARCH_HOST\/PATH/.test(error?.message ?? ""));
  }

  useHost("renamed-endpoint.example.com");
  {
    // Configured path is gone, but /search/people answers: the run must recover, not fail.
    stubFetch((url) => url.includes("/search/people") && !url.includes("/api/v1/")
      ? { status: 200, body: { data: [{ full_name: "Ada Lovelace", title: "Engineer" }] } }
      : { status: 404 });
    const { error, rows } = await attempt();
    check("a renamed endpoint self-heals instead of failing", !error && rows === 1);
  }

  /* --- POST listings heal too (this branch had no recovery at all) ------- */
  useHost("post-renamed.example.com", {
    RAPIDAPI_PEOPLE_SEARCH_METHOD: "POST",
    RAPIDAPI_PEOPLE_SEARCH_PATH: "/search_people",
  });
  {
    const calls = stubFetch((url) => url.endsWith("/people/search")
      ? { status: 200, body: { data: [{ full_name: "Grace Hopper" }] } }
      : { status: 404 });
    const { error, rows } = await attempt();
    check("POST 404 probes variants (was GET-only)", calls.length > 1);
    check("POST listing self-heals", !error && rows === 1);
  }

  useHost("post-dead.example.com", {
    RAPIDAPI_PEOPLE_SEARCH_METHOD: "POST",
    RAPIDAPI_PEOPLE_SEARCH_PATH: "/search_people",
  });
  {
    stubFetch(() => ({ status: 404, body: { message: "Endpoint does not exist" } }));
    const { error } = await attempt();
    check("a POST listing with no people endpoint is fatal", Boolean(error) && isPeopleSearchFatal(error));
  }

  /* --- busy, not broken: NOT fatal -------------------------------------- */
  useHost("busy.example.com", { RAPIDAPI_PEOPLE_SEARCH_METHOD: "GET" });
  {
    stubFetch(() => ({ status: 500 }));
    const { error } = await attempt();
    check("a 500 raises a plain, non-fatal error", Boolean(error) && !isPeopleSearchFatal(error));
  }

  useHost("ratelimited.example.com");
  {
    stubFetch(() => ({ status: 429 }));
    const { error } = await attempt();
    check("an exhausted 429 stays non-fatal (the next query may pass)",
      Boolean(error) && !isPeopleSearchFatal(error));
  }

  /* --- the happy path still maps rows ----------------------------------- */
  useHost("working.example.com");
  {
    stubFetch(() => ({
      status: 200,
      body: { data: [{ full_name: "Ada Lovelace", title: "VP Engineering at Acme", location: "Austin, TX" }] },
    }));
    const { error, rows } = await attempt();
    check("a 200 returns mapped rows", !error && rows === 1);
  }

  /* --- the guard itself -------------------------------------------------- */
  check("isPeopleSearchFatal rejects a plain Error", !isPeopleSearchFatal(new Error("nope")));
  check("isPeopleSearchFatal accepts the fatal class", isPeopleSearchFatal(new PeopleSearchFatal("x")));
  check("isPeopleSearchFatal survives a non-error", !isPeopleSearchFatal(undefined));
}

run()
  .catch((e) => { failed++; console.error("  CRASH:", e); })
  .finally(() => {
    globalThis.fetch = realFetch;
    console.log(`\npeople-search classification: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
