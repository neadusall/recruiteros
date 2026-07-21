/* Same-role auto-combine tests: name-key normalization, master pick, fold-safety gates.
   Run from integration/:  npx tsx scripts/test-sourcing-samerole.mts */
import {
  sameRoleKey, pickSameRoleMaster, combinableGroups, combineBusy, COMBINE_SETTLE_MS,
} from "../lib/sourcing/sameRole";
import type { CandidateRow, SourcingRun } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

const NOW = Date.parse("2026-07-21T12:00:00Z");
const OLD = "2026-07-21T11:00:00Z"; // settled an hour ago

const row = (over: Partial<CandidateRow> & { fullName: string }): CandidateRow => ({
  title: "VP of Operations", company: "Axion", location: "Howell, NJ",
  fitScore: 50, fitReasons: [],
  ...over,
});

const run = (id: string, name: string, over?: Partial<SourcingRun>): SourcingRun => ({
  id, workspaceId: "ws", name, motion: "recruiting", jd: "jd",
  icp: {
    label: name, seniority: "vp", managesTeam: true, titles: ["VP of Operations"],
    geos: ["Howell, NJ"], remoteOk: false, industries: [], targetCompanies: [],
    sellsTo: [], verticals: [], mustHave: [], niceToHave: [], disqualifiers: [],
  },
  queries: [], candidates: [row({ fullName: `Person ${id}` })], warnings: [],
  createdAt: "2026-07-17T00:00:00Z", updatedAt: OLD,
  ...over,
});

/* ---- 1. key normalization: the real Howell trio collapses to ONE key ---- */
{
  const base = sameRoleKey(run("a", "VP of Operations - Howell, New Jersey, United States"));
  ok(base !== null, "plain name keys", base);
  ok(sameRoleKey(run("b", "VP of Operations - Howell, New Jersey +50mi")) === base,
    "+50mi radius variant keys the same");
  ok(sameRoleKey(run("c", "VP of Operations - Howell, New Jersey, United States (combined)")) === base,
    "(combined) suffix keys the same");
  ok(sameRoleKey(run("d", "VP of Operations - Howell, New Jersey, United States (combined) (2)")) === base,
    "stacked suffixes strip repeatedly");
  ok(sameRoleKey(run("e", "vp of operations · Howell   New Jersey")) === base,
    "case/punctuation/whitespace insensitive");
  ok(sameRoleKey(run("f", "VP of Operations - Howell, New Jersey USA")) === base,
    "USA qualifier strips like United States");
}

/* ---- 2. key conservatism: real differences stay different ---- */
{
  const base = sameRoleKey(run("a", "VP of Operations - Howell, New Jersey"));
  ok(sameRoleKey(run("b", "VP of Operations - Freehold, New Jersey")) !== base,
    "different city = different key");
  ok(sameRoleKey(run("c", "Director of Operations - Howell, New Jersey")) !== base,
    "different title = different key");
  ok(sameRoleKey(run("d", "VP of Operations - Howell, New Jersey", { motion: "bd" })) !== base,
    "bd motion never keys with recruiting");
  ok(sameRoleKey(run("e", "VP of Operations - Howell, New Jersey", { workspaceId: "ws2" })) !== base,
    "different workspace never keys together");
  ok(sameRoleKey(run("f", "")) === null, "empty name is unkeyable");
  ok(sameRoleKey(run("g", "+50mi (2)")) === null, "name that is ONLY decorations is unkeyable");
}

/* ---- 3. master pick: the campaign with history keeps growing ---- */
{
  const sentSmall = run("small", "VP Ops - Howell", {
    autoflow: { sentAt: "2026-07-17T10:00:00Z", phonesAtSend: 3, attempts: 1 },
    promotedCampaignId: "camp_small",
  });
  const sentCombined = run("combined", "VP Ops - Howell (combined)", {
    autoflow: { sentAt: "2026-07-18T10:00:00Z", phonesAtSend: 40, attempts: 1 },
    promotedCampaignId: "camp_combined", combinedFrom: ["x", "y"],
    candidates: Array.from({ length: 200 }, (_, i) => row({ fullName: `P${i}` })),
  });
  const freshBig = run("fresh", "VP Ops - Howell +50mi", {
    candidates: Array.from({ length: 500 }, (_, i) => row({ fullName: `Q${i}` })),
  });
  ok(pickSameRoleMaster([sentSmall, sentCombined, freshBig]).id === "combined",
    "sent + explicit combined master beats a bigger unsent run and an earlier-sent smaller one");
  ok(pickSameRoleMaster([sentSmall, freshBig]).id === "small",
    "any sent run beats an unsent one (its OS Text campaign already exists)");
  ok(pickSameRoleMaster([freshBig, run("tiny", "VP Ops - Howell")]).id === "fresh",
    "with nothing sent, the biggest run anchors");
}

/* ---- 4. fold-safety gates ---- */
{
  const quiet = run("q", "VP Ops - Howell");
  ok(!combineBusy(quiet, NOW, new Set()), "settled idle run is foldable");
  ok(combineBusy(run("j", "VP Ops - Howell", { laxisJob: { jobId: "x", submittedAt: OLD, count: 1, targets: [] } }), NOW, new Set()),
    "in-flight enrichment job blocks the fold");
  ok(combineBusy(quiet, NOW, new Set(["q"])), "overnight-queue claim blocks the fold");
  ok(combineBusy(run("t", "VP Ops - Howell", { updatedAt: new Date(NOW - COMBINE_SETTLE_MS / 2).toISOString() }), NOW, new Set()),
    "a just-touched run (live tab) blocks the fold");
  ok(combineBusy(run("u", "VP Ops - Howell", { updatedAt: "not a date" }), NOW, new Set()),
    "unreadable timestamp counts as busy, never foldable");
}

/* ---- 5. grouping: only safe same-key groups come back, master chosen ---- */
{
  const a = run("a", "VP of Operations - Howell, New Jersey, United States", {
    autoflow: { sentAt: "2026-07-17T10:00:00Z", phonesAtSend: 5, attempts: 1 }, promotedCampaignId: "camp_a",
  });
  const b = run("b", "VP of Operations - Howell, New Jersey +50mi");
  const c = run("c", "VP of Operations - Howell, New Jersey, United States (combined)", {
    autoflow: { sentAt: "2026-07-18T10:00:00Z", phonesAtSend: 40, attempts: 1 },
    promotedCampaignId: "camp_c", combinedFrom: ["a0"],
    candidates: Array.from({ length: 200 }, (_, i) => row({ fullName: `P${i}` })),
  });
  const other = run("z", "Controller - Toms River, New Jersey");
  const bdTwin = run("bd1", "VP of Operations - Howell, New Jersey", { motion: "bd" });
  const empty = run("e0", "VP of Operations - Howell, New Jersey", { candidates: [] });

  const groups = combinableGroups([a, b, c, other, bdTwin, empty], NOW, new Set());
  ok(groups.length === 1, "exactly one foldable group (singleton/bd/empty runs excluded)", groups.length);
  ok(groups[0].master.id === "c", "the combined+sent run is the group master", groups[0].master.id);
  ok(groups[0].donors.map((d) => d.id).sort().join(",") === "a,b", "both variants are donors");

  const busyGroups = combinableGroups([a, b, c], NOW, new Set(["b"]));
  ok(busyGroups.length === 0, "one busy run holds back the whole group");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
