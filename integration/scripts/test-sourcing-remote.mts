/* Remote-role (national) search tests: the ICP shaping, the query set, the scoring
   change, the database sweep, and the geo passes that must NOT run.
   Run from integration/:  npx tsx scripts/test-sourcing-remote.mts */
import {
  applyRemoteIcp, isRemoteRun, locationSaysRemote, rowSaysRemote, nationalGeoTargets,
  NATIONAL_METROS, REMOTE_LABEL,
} from "../lib/sourcing/remoteMode";
import { generateQueries } from "../lib/sourcing/generateQueries";
import { scoreCandidate } from "../lib/sourcing/score";
import { buildDbDiscoverySpecCsv } from "../lib/sourcing/koldinfoDiscovery";
import { enforceRunGeo } from "../lib/sourcing/geoEnforce";
import { geocodeUsPlace } from "../lib/sourcing/geoRadius";
import type { CandidateICP, CandidateRow, SourcingRun } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

const icp = (over: Partial<CandidateICP> = {}): CandidateICP => ({
  label: "VP of Revenue Operations",
  seniority: "vp",
  managesTeam: true,
  titles: ["VP Revenue Operations", "VP RevOps", "Head of Revenue Operations", "Director of Revenue Operations",
    "Senior Director RevOps", "VP Sales Operations", "Head of Sales Ops", "Director Sales Operations"],
  geos: ["Fair Lawn, NJ", "Newark, NJ", "New York, NY"],
  remoteOk: false,
  industries: ["SaaS", "B2B Software"],
  targetCompanies: ["Gainsight", "Clari"],
  sellsTo: [], verticals: [], mustHave: [], niceToHave: [], disqualifiers: [],
  ...over,
});

const row = (over: Partial<CandidateRow> & { fullName: string }): CandidateRow => ({
  title: "VP Revenue Operations", company: "Clari", fitScore: 0, fitReasons: [], ...over,
});

/* ---- 1. ICP shaping: the geography is cleared, not narrowed ---- */
{
  const shaped = applyRemoteIcp(icp());
  ok(shaped.geos.length === 0, "remote clears the parsed metro list", shaped.geos);
  ok(shaped.remoteOk === true, "remote sets remoteOk so the vet/rerank prompts stop asking for a city");
  ok(shaped.titles.length === 8, "titles survive untouched", shaped.titles.length);
}

/* ---- 2. The query set ---- */
{
  const qs = generateQueries(applyRemoteIcp(icp()), { breadth: "balanced", remote: true });
  ok(qs.length > 0, "a remote plan produces queries", qs.length);

  const stated = qs.filter((q) => q.group === "remote: works remotely");
  ok(stated.length >= 1, "there is a pass targeting people who state they work remotely", stated.length);
  ok(stated.every((q) => /"?Work From Home"?|Remote/.test(q.xray)), "that pass carries remote wording", stated[0]?.xray);

  const national = qs.filter((q) => q.group === "nationwide: industry");
  ok(national.length >= 1, "there is a geo-free nationwide pass", national.length);
  ok(national.every((q) => !/, [A-Z]{2}\b/.test(q.xray)), "the nationwide pass carries no city term", national[0]?.xray);

  const metro = qs.filter((q) => q.group.startsWith("nationwide: ") && q.group !== "nationwide: industry");
  ok(metro.length >= 10, "the metro rota fans out across many markets", metro.length);
  const markets = new Set(metro.map((q) => q.geoLocation));
  ok(markets.size >= 10, "the rota hits distinct markets, not one repeated", markets.size);
  ok(markets.has("New York, NY") && markets.has("Los Angeles, CA") && markets.has("Chicago, IL"),
    "the biggest US markets are covered", [...markets].slice(0, 5));

  // The whole failure this mode exists to prevent: the recruiter's OLD typed metros
  // leaking into a national search and quietly turning it back into a regional one.
  ok(!qs.some((q) => /Fair Lawn/i.test(q.xray)), "no leftover typed metro rides into a remote search");

  const companies = qs.filter((q) => q.group === "Gainsight" || q.group === "Clari");
  ok(companies.length === 2, "target companies still get their poaching search", companies.length);
  ok(companies.every((q) => !/New York|Fair Lawn/i.test(q.xray)), "company searches carry no geo term", companies[0]?.xray);
}

/* ---- 3. Breadth scales the rota, not the honesty of it ---- */
{
  const counts = (["focused", "balanced", "wide"] as const).map((b) => nationalGeoTargets(b).length);
  ok(counts[0] < counts[1] && counts[1] < counts[2], "wider breadth searches more markets", counts);
  ok(counts[2] <= NATIONAL_METROS.length, "the rota never exceeds the table", counts[2]);
  ok(new Set(nationalGeoTargets("wide")).size === counts[2], "no market is searched twice", counts[2]);

  const focused = generateQueries(applyRemoteIcp(icp()), { breadth: "focused", remote: true });
  const wide = generateQueries(applyRemoteIcp(icp()), { breadth: "wide", remote: true });
  ok(wide.length > focused.length, "wide runs more queries than focused", [focused.length, wide.length]);
  // Serper's default per-run spend guard is 100 queries; a wide remote run has to fit.
  ok(wide.length <= 100, "even a wide remote run stays inside the per-run query budget", wide.length);
}

/* ---- 4. Scoring: nobody is penalized for where they live ---- */
{
  const shaped = applyRemoteIcp(icp());
  const ohio = row({ fullName: "Dana Pryor", location: "Columbus, OH" });
  const remoteRow = row({ fullName: "Sam Ellis", location: "Remote, United States" });
  const local = row({ fullName: "Alex Kim", location: "Fair Lawn, NJ" });

  const sOhio = scoreCandidate({ ...ohio }, shaped, { remote: true });
  const sRemote = scoreCandidate({ ...remoteRow }, shaped, { remote: true });
  const sLocal = scoreCandidate({ ...local }, shaped, { remote: true });

  ok(sOhio.fitScore > 0, "an out-of-state candidate still scores on a remote search", sOhio.fitScore);
  ok(sOhio.fitScore === sLocal.fitScore, "living near the old typed city is worth nothing extra", [sOhio.fitScore, sLocal.fitScore]);
  ok(sRemote.fitScore > sOhio.fitScore, "someone already working remotely ranks higher", [sRemote.fitScore, sOhio.fitScore]);
  ok(sRemote.fitReasons.some((r) => /remotely/i.test(r)), "and the reason says why", sRemote.fitReasons);
  ok(!sOhio.fitReasons.some((r) => /outside|mi away/i.test(r)), "no out-of-area reason is ever printed", sOhio.fitReasons);

  // The regression guard: the SAME row on a pinned search must still be penalized.
  const pinned = scoreCandidate({ ...ohio }, icp(), {});
  ok(pinned.fitScore < sOhio.fitScore, "a pinned search still penalizes the out-of-area row", [pinned.fitScore, sOhio.fitScore]);
}

/* ---- 5. Remote wording detection ---- */
{
  ok(locationSaysRemote("Remote"), "bare Remote");
  ok(locationSaysRemote("United States (Remote)"), "parenthesized remote");
  ok(locationSaysRemote("Anywhere, USA"), "anywhere");
  ok(!locationSaysRemote("Columbus, OH"), "a real city is not remote");
  ok(!locationSaysRemote(undefined), "a missing location is not remote");
  ok(rowSaysRemote(row({ fullName: "A", headline: "RevOps leader | 100% remote team" })), "headline wording counts");
  ok(!rowSaysRemote(row({ fullName: "B", location: "Austin, TX", headline: "Remote patient monitoring specialist" })),
    "remote as a job duty is not remote work");
}

/* ---- 6. The database sweep goes national ---- */
{
  const csv = buildDbDiscoverySpecCsv(applyRemoteIcp(icp()), 200, { remote: true }) || "";
  const cells = csv.split("\n")[1] || "";
  ok(csv.includes("VP Revenue Operations"), "titles still drive the sweep", cells);
  // The worker ANDs city and state, so any chip at all would silently re-narrow it.
  ok(/^[^,]*,,,/.test(cells) || cells.split(",").slice(1, 3).every((c) => c === ""),
    "no city or state chips ride on a national sweep", cells);

  const pinnedCsv = buildDbDiscoverySpecCsv(icp(), 200, { location: "Fair Lawn, NJ", radiusMi: 25 }) || "";
  ok(/NJ|New Jersey/.test(pinnedCsv), "a pinned sweep still sends its chips", pinnedCsv.split("\n")[1]);
}

/* ---- 7. Nothing downstream re-pins a remote list ---- */
{
  const remoteRun = {
    id: "r1", workspaceId: "ws", name: "VP RevOps · Remote · US", motion: "recruiting", jd: "",
    location: REMOTE_LABEL, remote: true, radiusMi: 0,
    icp: applyRemoteIcp(icp()), queries: [],
    candidates: [row({ fullName: "Dana Pryor", location: "Columbus, OH" })],
    warnings: [], createdAt: "", updatedAt: "",
  } as unknown as SourcingRun;

  const res = enforceRunGeo(remoteRun);
  ok(res.enforced === false, "the radius pass declines to run on a remote list");
  ok(res.marked === 0, "and marks nobody out-of-area", res.marked);
  ok(!remoteRun.candidates[0].outOfArea, "the out-of-state candidate stays deliverable");

  ok(isRemoteRun(remoteRun), "the flag identifies a remote list");
  ok(isRemoteRun({ location: REMOTE_LABEL }), "so does the label alone, for lists saved before the flag");
  ok(!isRemoteRun({ location: "Fair Lawn, NJ +25mi" }), "a pinned list is not remote");
  ok(!isRemoteRun(undefined), "no run is not remote");

  // The label must never resolve to a coordinate, or the radius pass would measure a
  // national list against a point on the map.
  ok(geocodeUsPlace(REMOTE_LABEL) === null, "the remote label does not geocode", geocodeUsPlace(REMOTE_LABEL));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
