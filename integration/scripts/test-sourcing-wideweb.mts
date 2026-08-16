/**
 * Regression suite for the wide-web pass order and budgets.
 *
 *   npx tsx scripts/test-sourcing-wideweb.mts     (from integration/)
 *
 * DataForSEO is the PRIMARY wide-web engine and Serper the top-up behind it. The thing
 * worth pinning is the budget: real runs here fan out to 57-319 queries against a
 * default DataForSEO cap of 100, and Serper used to cover the remainder. With Serper
 * out of credits — the live state when this was written — every query past 100 would
 * have got no wide-web pass at all, and the run would have reported success having
 * searched a third of what it was asked to.
 *
 * Also pins that LinkedIn's own marketing pages never enter a candidate list: a live
 * DataForSEO probe returned business.linkedin.com/in/en/hire/recruiter among the first
 * six "profiles", and the old profile test admitted it.
 */

import { runDiscovery } from "../lib/sourcing/discovery";
import type { CandidateICP, SourcingQuery } from "../lib/sourcing/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; } else { failed++; console.error("  FAIL:", name); }
}

const realFetch = globalThis.fetch;

/** Count DataForSEO tasks and Serper searches issued by a run. */
interface Counts { dfs: number; serper: number }

function stub(counts: Counts, opts: { serperDies?: boolean; dfsItems?: unknown[] } = {}): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("dataforseo.com")) {
      counts.dfs++;
      return new Response(JSON.stringify({
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{ items: opts.dfsItems ?? [] }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("serper.dev")) {
      counts.serper++;
      if (opts.serperDies) {
        return new Response(JSON.stringify({ message: "insufficient credits" }), { status: 403 });
      }
      return new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const icp: CandidateICP = {
  titles: ["VP of Sales"], geos: ["Dallas, TX"], industries: [], skills: [],
  seniority: [], mustHave: [], niceToHave: [], disqualifiers: [],
} as unknown as CandidateICP;

/** N distinct queries, enough to run past the default 100-query cap. */
function queries(n: number): SourcingQuery[] {
  return Array.from({ length: n }, (_, i) => ({
    group: `g${i}`,
    label: `VP of Sales ${i}`,
    keyword: `VP of Sales ${i}`,
    xray: `site:linkedin.com/in "VP of Sales" "Dallas" ${i}`,
    linkedinUrl: "",
  })) as unknown as SourcingQuery[];
}

/** Only the wide-web engines; keeps the run off every other network path. */
const ENGINES = ["dataforseo", "serper"] as const;

async function run(): Promise<void> {
  /* --- Serper absent: DataForSEO covers the whole run ------------------- */
  delete process.env.SERPER_API_KEY;
  delete process.env.DATAFORSEO_MAX_QUERIES;
  process.env.DATAFORSEO_LOGIN = "probe@example.com";
  process.env.DATAFORSEO_PASSWORD = "pw";
  {
    const counts: Counts = { dfs: 0, serper: 0 };
    stub(counts);
    await runDiscovery(queries(260), icp, { cap: 5000, engines: ENGINES as unknown as string[] } as never);
    check("with no Serper, DataForSEO's budget doubles to 200", counts.dfs === 200);
    check("no Serper calls are made when it is unconfigured", counts.serper === 0);
  }

  /* --- Serper present: the standard 100 applies -------------------------- */
  process.env.SERPER_API_KEY = "sk-test";
  {
    const counts: Counts = { dfs: 0, serper: 0 };
    stub(counts);
    await runDiscovery(queries(260), icp, { cap: 5000, engines: ENGINES as unknown as string[] } as never);
    check("with Serper available, DataForSEO keeps the standard 100 cap", counts.dfs === 100);
    check("Serper still runs as the top-up", counts.serper > 0);
  }

  /* --- Serper dies mid-run: the primary picks the slack up --------------- */
  {
    const counts: Counts = { dfs: 0, serper: 0 };
    stub(counts, { serperDies: true });
    await runDiscovery(queries(260), icp, { cap: 5000, engines: ENGINES as unknown as string[] } as never);
    check("when Serper dies mid-run, DataForSEO's budget is raised to 200", counts.dfs === 200);
    check("Serper stops being called once it reports no credits", counts.serper < 5);
  }

  /* --- an explicit cap is never raised on the operator's behalf ---------- */
  delete process.env.SERPER_API_KEY;
  process.env.DATAFORSEO_MAX_QUERIES = "40";
  {
    const counts: Counts = { dfs: 0, serper: 0 };
    stub(counts);
    await runDiscovery(queries(260), icp, { cap: 5000, engines: ENGINES as unknown as string[] } as never);
    check("an explicit DATAFORSEO_MAX_QUERIES pins the budget", counts.dfs === 40);
  }
  delete process.env.DATAFORSEO_MAX_QUERIES;

  /* --- LinkedIn's own marketing pages are not candidates ----------------- */
  {
    const counts: Counts = { dfs: 0, serper: 0 };
    stub(counts, {
      dfsItems: [
        { type: "organic", title: "LinkedIn Recruiter", url: "https://business.linkedin.com/in/en/hire/recruiter", description: "Find and hire talent" },
        { type: "organic", title: "LinkedIn Recruiter Lite", url: "https://business.linkedin.com/in/en/hire/recruiter-lite", description: "Hiring for small teams" },
        { type: "organic", title: "Ada Lovelace - VP of Sales at Acme", url: "https://www.linkedin.com/in/ada-lovelace", description: "Dallas, Texas" },
      ],
    });
    // `scanned` is how many rows the profile mapper ADMITTED, before any scoring or geo
    // rule gets a say — exactly the layer under test. Of the three results only Ada is a
    // person; the two business.linkedin.com pages both satisfy a naive linkedin.com/in
    // test and would have been scanned as candidates before this filter.
    const res = await runDiscovery(queries(1), icp, { cap: 50, minFit: 0, engines: ENGINES as unknown as string[] } as never);
    check("only the real profile is admitted; both marketing pages are dropped", res.scanned === 1);
  }
}

run()
  .catch((e) => { failed++; console.error("  CRASH:", e); })
  .finally(() => {
    globalThis.fetch = realFetch;
    console.log(`\nwide-web pass suite: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
