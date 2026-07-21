/**
 * Prospect-list duplicate fold: regression suite.
 * Run: npx tsx scripts/test-prospect-lists-dedupe.mts   (exits non-zero on failure)
 *
 * Pins the "no duplicates ever" rules (user mandate 2026-07-21):
 *   - same workspace + motion + trimmed case-folded name = one list;
 *   - the newest REFERENCED list wins (a run's promotedListId is never deleted);
 *   - members are unioned so a fold can never lose a saved person;
 *   - two referenced same-name lists both survive (the run fold happens first,
 *     in the same-role lane — deleting either here would dangle a run stamp
 *     and re-spawn the list on its next top-up, churning forever).
 */

import { planListDedupe, type ProspectList } from "../lib/prospect-lists";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

const T0 = "2026-07-20T10:00:00.000Z";
const T1 = "2026-07-20T11:00:00.000Z";
const T2 = "2026-07-20T12:00:00.000Z";

function list(over: Partial<ProspectList>): ProspectList {
  return {
    id: "l0", workspaceId: "ws1", name: "VP of Operations", prospectIds: [],
    createdAt: T0, updatedAt: T0, ...over,
  };
}

const refs = (...ids: string[]) => new Set(ids);

// Newest referenced copy wins even when an unreferenced one is newer.
{
  const plans = planListDedupe([
    list({ id: "old", updatedAt: T0, prospectIds: ["p1"] }),
    list({ id: "ref", updatedAt: T1, prospectIds: ["p1", "p2"] }),
    list({ id: "new", updatedAt: T2, prospectIds: ["p3"] }),
  ], refs("ref"));
  check("referenced list wins over a newer unreferenced one", plans[0]?.winnerId, "ref");
  check("...both unreferenced siblings fold", plans[0]?.loserIds.sort(), ["new", "old"]);
  check("...members union across the whole group", plans[0]?.prospectIds.sort(), ["p1", "p2", "p3"]);
}

// With nothing referenced, the newest copy wins.
{
  const plans = planListDedupe([
    list({ id: "a", updatedAt: T0 }),
    list({ id: "b", updatedAt: T2 }),
    list({ id: "c", updatedAt: T1 }),
  ], refs());
  check("unreferenced group: newest wins", plans[0]?.winnerId, "b");
  check("...the rest fold", plans[0]?.loserIds.sort(), ["a", "c"]);
}

// Two referenced same-name lists BOTH survive; only unreferenced ones fold.
{
  const plans = planListDedupe([
    list({ id: "refA", updatedAt: T0, prospectIds: ["p1"] }),
    list({ id: "refB", updatedAt: T1, prospectIds: ["p2"] }),
    list({ id: "junk", updatedAt: T2, prospectIds: ["p3"] }),
  ], refs("refA", "refB"));
  check("two referenced lists: only the unreferenced sibling folds", plans[0]?.loserIds, ["junk"]);
  check("...into the newest referenced one", plans[0]?.winnerId, "refB");
}
{
  const plans = planListDedupe([
    list({ id: "refA", updatedAt: T0 }),
    list({ id: "refB", updatedAt: T1 }),
  ], refs("refA", "refB"));
  check("a group that is ALL referenced plans no fold", plans.length, 0);
}

// Name matching is trim + case-folded.
{
  const plans = planListDedupe([
    list({ id: "a", name: "VP of Operations ", updatedAt: T1 }),
    list({ id: "b", name: "vp of operations", updatedAt: T0 }),
  ], refs());
  check("names match case-insensitively and ignore stray whitespace", plans[0]?.loserIds, ["b"]);
}

// Different workspace / motion / name never fold together.
{
  const plans = planListDedupe([
    list({ id: "a" }),
    list({ id: "b", workspaceId: "ws2" }),
    list({ id: "c", motion: "bd" }),
    list({ id: "d", name: "Director of Ops" }),
  ], refs());
  check("different workspace/motion/name are separate groups", plans.length, 0);
}

// Singletons plan nothing.
check("a single list plans no fold", planListDedupe([list({})], refs()).length, 0);

// dataIds union too (mixed unified-tab lists).
{
  const plans = planListDedupe([
    list({ id: "a", updatedAt: T1, dataIds: ["d1"] }),
    list({ id: "b", updatedAt: T0, dataIds: ["d2"], prospectIds: ["p1"] }),
  ], refs());
  check("dataIds union across the fold", plans[0]?.dataIds.sort(), ["d1", "d2"]);
  check("...winner keeps folded members", plans[0]?.prospectIds, ["p1"]);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall green");
