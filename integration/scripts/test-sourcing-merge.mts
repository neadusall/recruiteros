/* Combine-lists merge tests: dedupe key, stronger-row wins, fill-blanks, vet carryover.
   Run from integration/:  npx tsx scripts/test-sourcing-merge.mts */
import { mergeSourcingRuns } from "../lib/sourcing/mergeRuns";
import type { CandidateRow, SourcingRun } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

const row = (over: Partial<CandidateRow> & { fullName: string }): CandidateRow => ({
  title: "VP of Finance", company: "Axion", location: "Dallas, TX",
  fitScore: 50, fitReasons: [],
  ...over,
});

const run = (id: string, name: string, candidates: CandidateRow[]): SourcingRun => ({
  id, workspaceId: "ws", name, motion: "recruiting", jd: "jd for " + name,
  icp: {
    label: name, seniority: "vp", managesTeam: true, titles: ["VP Finance"],
    geos: ["Dallas, TX"], remoteOk: false, industries: [], targetCompanies: [],
    sellsTo: [], verticals: [], mustHave: [], niceToHave: [], disqualifiers: [],
  },
  queries: [], candidates, warnings: [],
  createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z",
});

/* ---- 1. dedupe by LinkedIn URL (format-tolerant: trailing slash, case) ---- */
{
  const a = run("a", "list A", [
    row({ fullName: "Jordan Reyes", linkedinUrl: "https://linkedin.com/in/JordanReyes/", fitScore: 88, email: "j@axion.com" }),
  ]);
  const b = run("b", "list B", [
    row({ fullName: "Jordan R.", company: "Axion Corp", linkedinUrl: "https://linkedin.com/in/jordanreyes", fitScore: 70, phone: "+12145550101" }),
  ]);
  const m = mergeSourcingRuns([a, b]);
  ok(m.candidates.length === 1, "same LinkedIn URL merges to one row despite case/slash variance", m.candidates.length);
  ok(m.overlap === 1, "overlap counted", m.overlap);
  const c = m.candidates[0];
  ok(c.fitScore === 88, "stronger (higher-fit) row wins", c.fitScore);
  ok(c.email === "j@axion.com" && c.phone === "+12145550101", "email from list A AND phone from list B both survive", { email: c.email, phone: c.phone });
}

/* ---- 2. dedupe by name+company when no LinkedIn URL ---- */
{
  const a = run("a", "A", [row({ fullName: "Avery Kim", company: "Southgate", fitScore: 60 })]);
  const b = run("b", "B", [row({ fullName: "avery kim", company: "southgate", fitScore: 74, email: "ak@southgate.com" })]);
  const m = mergeSourcingRuns([a, b]);
  ok(m.candidates.length === 1, "name+company fallback key dedupes case-insensitively", m.candidates.length);
  ok(m.candidates[0].fitScore === 74 && m.candidates[0].email === "ak@southgate.com", "winner keeps its own data");
}

/* ---- 3. different people never merge ---- */
{
  const a = run("a", "A", [row({ fullName: "Morgan Blake", company: "Trellis" })]);
  const b = run("b", "B", [row({ fullName: "Morgan Blake", company: "Northline" })]);
  const m = mergeSourcingRuns([a, b]);
  ok(m.candidates.length === 2 && m.overlap === 0, "same name at different companies stays two rows", m.candidates.length);
}

/* ---- 4. deep-vet verdict beats raw fit, and carries over whole ---- */
{
  const vetted = row({
    fullName: "Casey Tran", linkedinUrl: "https://linkedin.com/in/caseytran", fitScore: 40,
    verifiedScore: 91, verdict: "strong", yearsRelevant: 9,
    vetStrengths: ["led 12-person team"], vetGaps: [], vetFlags: [], vetRationale: "solid",
    profileFetched: true,
  });
  const unvetted = row({ fullName: "Casey Tran", linkedinUrl: "https://linkedin.com/in/caseytran", fitScore: 95, phone: "+12145550177" });
  const m = mergeSourcingRuns([run("a", "A", [vetted]), run("b", "B", [unvetted])]);
  const c = m.candidates[0];
  ok(m.candidates.length === 1, "vetted + unvetted duplicate merges to one");
  ok(c.verifiedScore === 91 && c.verdict === "strong", "deep-vetted row wins over higher raw fit", { v: c.verifiedScore, fit: c.fitScore });
  ok(c.phone === "+12145550177", "loser's phone still filled onto the vetted winner", c.phone);
  ok(c.vetStrengths?.length === 1 && c.vetRationale === "solid", "vet verdict carried over whole");
}

/* ---- 5. verdict transplant when the WINNER is unvetted ---- */
{
  // Same verified person, but this time the unvetted row wins on strength?
  // It can't: verified beats unvetted by design. So test the transplant path:
  // both unvetted on fit, one carries a verdict from an older list where it lost.
  const winner = row({ fullName: "Riley Osei", linkedinUrl: "https://linkedin.com/in/rileyosei", fitScore: 80 });
  const loserVetted = row({
    fullName: "Riley Osei", linkedinUrl: "https://linkedin.com/in/rileyosei", fitScore: 79,
    verifiedScore: 55, verdict: "possible", vetStrengths: [], vetGaps: ["short tenures"], vetFlags: ["job_hopping"], vetRationale: "mixed",
  });
  // NOTE: strength() puts the vetted row first (verified*1000), so it wins here.
  const m = mergeSourcingRuns([run("a", "A", [winner]), run("b", "B", [loserVetted])]);
  const c = m.candidates[0];
  ok(c.verifiedScore === 55 && c.vetFlags?.includes("job_hopping"), "a vet verdict is never lost in a merge", c);
}

/* ---- 6. ranking: verified-first, then fit ---- */
{
  const m = mergeSourcingRuns([run("a", "A", [
    row({ fullName: "P1", company: "C1", fitScore: 99 }),
    row({ fullName: "P2", company: "C2", fitScore: 10, verifiedScore: 70, verdict: "possible" }),
    row({ fullName: "P3", company: "C3", fitScore: 60 }),
  ])]);
  ok(m.candidates.map((c) => c.fullName).join(",") === "P2,P1,P3", "verified-first ordering", m.candidates.map((c) => c.fullName));
}

/* ---- 7. anchor is the largest source ---- */
{
  const small = run("s", "small", [row({ fullName: "A", company: "X" })]);
  const big = run("bg", "big", [row({ fullName: "B", company: "X" }), row({ fullName: "C", company: "X" })]);
  const m = mergeSourcingRuns([small, big]);
  ok(m.anchor.id === "bg", "largest run anchors the combined list", m.anchor.id);
}

/* ---- 8. three-way overlap folds to one, nothing fabricated ---- */
{
  const p = (extra: Partial<CandidateRow>) => row({ fullName: "Sam Ode", linkedinUrl: "https://linkedin.com/in/samode", ...extra });
  const m = mergeSourcingRuns([
    run("a", "A", [p({ fitScore: 50, email: "s@x.com" })]),
    run("b", "B", [p({ fitScore: 60, phone: "+12145550122" })]),
    run("c", "C", [p({ fitScore: 55, headline: "Finance leader" })]),
  ]);
  const c = m.candidates[0];
  ok(m.candidates.length === 1 && m.overlap === 2, "three copies fold to one with overlap 2", { n: m.candidates.length, o: m.overlap });
  ok(c.email === "s@x.com" && c.phone === "+12145550122" && c.headline === "Finance leader", "every list's unique data survives the 3-way fold");
  ok(c.fitScore === 60, "highest fit survives the 3-way fold", c.fitScore);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
