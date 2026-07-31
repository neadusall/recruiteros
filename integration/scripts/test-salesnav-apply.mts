/**
 * Functional suite for the LinkedIn-URL search lander (2026-07-31).
 * Run: npx tsx scripts/test-salesnav-apply.mts   (from integration/)
 *
 * The lander is what both the live `salesNav` action and the crash recovery use
 * to turn a finished pull into a saved list, so the "a recovery never forks a
 * second list" guarantee lives or dies here. This runs the REAL store against a
 * scratch ROS_DATA_DIR (no network, no DB) and asserts on what actually landed,
 * rather than on the shape of the source.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "snav-apply-"));
delete process.env.DATABASE_URL;

const { applySalesNavResult } = await import("../lib/sourcing/salesNavApply.js");
const { listSourcingRuns, saveSourcingRun } = await import("../lib/sourcing/store.js");
type Applied = Awaited<ReturnType<typeof applySalesNavResult>>;

const WS = "ws_test_snav";
const URL_A = "https://www.linkedin.com/sales/search/people?query=titles%3ACFO";
const URL_B = "https://www.linkedin.com/sales/search/people?query=titles%3AController";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
}
function landed(r: Applied): Extract<Applied, { run: unknown }> {
  if ("missingTarget" in r) throw new Error("expected a landed list, got missingTarget");
  return r;
}

const icp = {
  label: "CFO — New York", seniority: "exec" as const, managesTeam: true,
  titles: ["CFO"], geos: ["New York"], remoteOk: false, industries: [],
  targetCompanies: [], sellsTo: [], verticals: [], mustHave: [], niceToHave: [],
  disqualifiers: [],
};
const person = (fullName: string, li: string, extra: Record<string, unknown> = {}) =>
  ({ fullName, linkedinUrl: li, fitScore: 70, fitReasons: ["test"], ...extra }) as never;
const pull = (rows: unknown[], warnings: string[] = []) => ({
  candidates: rows as never[], icp, criteria: { keywords: [], titles: ["CFO"], geos: [], companies: [], industries: [] },
  queries: [], warnings, linkedinFound: rows.length, expanded: 0,
});

/* 1. A first run creates the list. -------------------------------------- */
const first = landed(await applySalesNavResult(WS, pull([
  person("Ada Finance", "https://linkedin.com/in/ada"),
  person("Ben Ledger", "https://linkedin.com/in/ben"),
]), { url: URL_A }));
check("a first search creates a list", first.mode === "created" && first.total === 2, `mode=${first.mode} total=${first.total}`);
check("the list remembers the URL it came from", (await listSourcingRuns(WS))[0].jdUrl === URL_A);

/* 2. THE RECOVERY GUARANTEE: a re-run of the same URL, with no name to match
      on, joins that same list instead of forking a second one. ----------- */
const recovered = landed(await applySalesNavResult(WS, pull([
  person("Ada Finance", "https://linkedin.com/in/ada", { email: "ada@co.com" }),
  person("Cy Audit", "https://linkedin.com/in/cy"),
]), { url: URL_A, preferUrlMatch: true }));
check("a recovery merges into the list its own URL made", recovered.mode === "merged", `mode=${recovered.mode}`);
check("a recovery does NOT fork a second list", (await listSourcingRuns(WS)).length === 1,
  `${(await listSourcingRuns(WS)).length} lists`);
check("the person seen twice is not duplicated", recovered.total === 3, `total=${recovered.total}`);
check("the new person is added", recovered.added === 1, `added=${recovered.added}`);
check("the overlap is counted", recovered.overlap === 1, `overlap=${recovered.overlap}`);
const merged = (await listSourcingRuns(WS))[0];
check("a blank on the kept row is filled from the incoming row",
  merged.candidates.find((c) => c.fullName === "Ada Finance")?.email === "ada@co.com");

/* 3. A DIFFERENT URL still gets its own list (the match is on the URL, not
      on "was there a recovery"). ---------------------------------------- */
const other = landed(await applySalesNavResult(WS, pull([person("Dee Books", "https://linkedin.com/in/dee")]),
  { url: URL_B, preferUrlMatch: true }));
check("a different search URL gets its own list", other.mode === "created" && (await listSourcingRuns(WS)).length === 2);

/* 4. A LIVE re-paste of the same URL keeps the old behaviour: without the
      recovery flag it builds a separate list on purpose. ---------------- */
const live = landed(await applySalesNavResult(WS, pull([person("Eli Cash", "https://linkedin.com/in/eli")]), { url: URL_A }));
check("a live re-paste of the same URL still builds its own list",
  live.mode === "created" && (await listSourcingRuns(WS)).length === 3);

/* 5. A typed name matches an existing list case-insensitively, so re-using a
      name can never spawn a duplicate list. ----------------------------- */
await saveSourcingRun(WS, {
  name: "Hill Valley FP&A", jd: "", icp, queries: [],
  candidates: [person("Fay Budget", "https://linkedin.com/in/fay")] as never[],
});
const byName = landed(await applySalesNavResult(WS, pull([person("Gus Plan", "https://linkedin.com/in/gus")]),
  { url: URL_B, name: "hill valley fp&a" }));
check("a typed name merges into the existing list whatever its case",
  byName.mode === "merged" && byName.name === "Hill Valley FP&A", `mode=${byName.mode} name=${byName.name}`);

/* 6. A picked list that is gone is reported, never silently re-created. -- */
const missing = await applySalesNavResult(WS, pull([person("Hal Void", "https://linkedin.com/in/hal")]),
  { url: URL_A, targetRunId: "srun_does_not_exist" });
check("a picked list that no longer exists is reported as missing",
  "missingTarget" in missing && missing.missingTarget === "srun_does_not_exist");

/* 7. Everything above ran against workspace WS only. --------------------- */
check("nothing leaked into another workspace", (await listSourcingRuns("ws_someone_else")).length === 0);

console.log(failed ? `\n${failed} FAILED` : `\nall checks passed`);
process.exit(failed ? 1 : 0);
