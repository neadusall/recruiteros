/**
 * Standing sweeps regression suite (the rota logic, pure functions only).
 *
 *   cd integration && npx tsx scripts/test-sourcing-standing.mts
 *
 * The seeding path itself touches the durable store and the overnight queue, so what is
 * pinned here is the decision logic that decides WHAT runs and WHEN: the part that, if
 * wrong, either starves the desk or spends money in a loop while nobody is watching.
 */

import {
  overdueBy, pickDueProfiles, dayKey, sweepName, type StandingProfile,
} from "../lib/sourcing/standingProfiles";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const NOW = new Date("2026-08-10T02:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const prof = (o: Partial<StandingProfile> = {}): StandingProfile => ({
  id: "sp_1", workspaceId: "ws_1", name: "Senior Accountant NJ", jd: "Senior Accountant",
  cadenceDays: 7, active: true, createdAt: daysAgo(30), updatedAt: daysAgo(30), ...o,
});

/* ---- due calculation ---- */
ok("a never-swept profile is due immediately", overdueBy(prof(), NOW) > 0);
ok("a profile swept today is not due", overdueBy(prof({ lastSweptAt: daysAgo(0) }), NOW) < 0);
ok("a profile swept inside its cadence is not due", overdueBy(prof({ lastSweptAt: daysAgo(3) }), NOW) < 0);
ok("a profile past its cadence is due", overdueBy(prof({ lastSweptAt: daysAgo(8) }), NOW) > 0);
ok("an inactive profile is never due", overdueBy(prof({ active: false }), NOW) < 0);
ok("an inactive profile is never due even when ancient",
  overdueBy(prof({ active: false, lastSweptAt: daysAgo(365) }), NOW) < 0);
ok("a corrupt timestamp is treated as never swept, not as an error",
  overdueBy(prof({ lastSweptAt: "not-a-date" }), NOW) > 0);
ok("a daily profile comes round the next day", overdueBy(prof({ cadenceDays: 1, lastSweptAt: daysAgo(2) }), NOW) > 0);

/* ---- rota ordering and pacing ---- */
const a = prof({ id: "a", name: "A", lastSweptAt: daysAgo(30) });
const b = prof({ id: "b", name: "B", lastSweptAt: daysAgo(10) });
const c = prof({ id: "c", name: "C", lastSweptAt: daysAgo(20) });
const fresh = prof({ id: "d", name: "D" }); // never swept

ok("most overdue runs first",
  pickDueProfiles([b, a, c], NOW, 3).map((p) => p.id).join(",") === "a,c,b");
ok("a never-swept profile outranks everything",
  pickDueProfiles([a, b, c, fresh], NOW, 1)[0].id === "d");
ok("the daily ceiling is respected", pickDueProfiles([a, b, c, fresh], NOW, 2).length === 2);
ok("no slots means no sweeps", pickDueProfiles([a, b, c], NOW, 0).length === 0);
ok("a negative ceiling is treated as no slots", pickDueProfiles([a, b, c], NOW, -5).length === 0);
ok("not-yet-due profiles are excluded even with slots free",
  pickDueProfiles([prof({ id: "x", lastSweptAt: daysAgo(1) })], NOW, 5).length === 0);
ok("inactive profiles never seed", pickDueProfiles([prof({ id: "y", active: false })], NOW, 5).length === 0);
ok("an empty rota is not an error", pickDueProfiles([], NOW, 5).length === 0);

/* ---- the pile-up guard ---- */
ok("a profile already in flight is held back",
  pickDueProfiles([a, c], NOW, 5, new Set(["A"])).map((p) => p.id).join(",") === "c");
ok("holding one profile does not block the others",
  pickDueProfiles([a, b, c], NOW, 5, new Set(["A"])).length === 2);
ok("all in flight means nothing seeds",
  pickDueProfiles([a, b, c], NOW, 5, new Set(["A", "B", "C"])).length === 0);

/* ---- naming ---- */
ok("a sweep name is dated", sweepName(prof({ name: "Senior Accountant NJ" }), NOW) === "Senior Accountant NJ · 2026-08-10");
ok("the profile name is recoverable from the sweep name",
  sweepName(prof({ name: "Tax Manager FL" }), NOW).split(" · ")[0] === "Tax Manager FL");
ok("two sweeps of one profile on different days do not collide",
  sweepName(prof(), NOW) !== sweepName(prof(), new Date(NOW.getTime() + 86_400_000)));
ok("day key is UTC and stable", dayKey(new Date("2026-08-10T23:59:59Z")) === "2026-08-10");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
