/**
 * LinkedIn OS shared engine — behavior suite.
 * Run: npx tsx lib/linkedin/os/engine.test.ts   (exits non-zero on failure)
 *
 * Guards the load-bearing invariants:
 *   1. One shared utilization: concurrent requests can never over-book the
 *      daily target (the reservation section is atomic).
 *   2. The hard ceiling is NEVER crossed, even by authorized temporary grants.
 *   3. Idempotency: a retried request returns the original ledger record.
 *   4. The global reply stop cancels pending actions, releases capacity and
 *      blocks new automated actions for the person (manual still allowed).
 *   5. Fair allocation: priority tiers, weighted shares, unused released.
 *   6. Canonical identity: handle variants resolve to ONE person.
 */

import { requestLinkedInAction, allowTemporaryCapacity } from "./engine";
import { putPolicy } from "./policy";
import { resolveIdentity } from "./identity";
import { globalReplyStop } from "./outreachState";
import { allocate } from "./allocation";
import { listLedger } from "./ledger";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ FAIL: ") + m); if (!c) fails++; };

const WS = "ws_test";
const ACC = "acct_test";

async function main() {
  // Tight policy: 3 connections/day target, 5 ceiling, always-on hours so the
  // suite is time-of-day independent.
  await putPolicy(WS, ACC, {
    mode: "custom",
    categories: {
      connections: { dailyTarget: 3, hardCeiling: 5, weeklyTarget: 100 },
      messages: { dailyTarget: 10, hardCeiling: 15, weeklyTarget: 100 },
      voice_notes: { dailyTarget: 5, hardCeiling: 8, weeklyTarget: 50 },
      inmails: { dailyTarget: 2, hardCeiling: 4, weeklyTarget: 10 },
      profile_views: { dailyTarget: 20, hardCeiling: 30, weeklyTarget: 100 },
      interactions: { dailyTarget: 10, hardCeiling: 20, weeklyTarget: 50 },
    } as never,
    workingHours: { startHour: 0, endHour: 24, days: [1, 2, 3, 4, 5, 6, 7] },
    pacing: { minDelayMinutes: 1, maxDelayMinutes: 2 } as never,
  });

  /* 1. Concurrency: 10 simultaneous connection requests, target 3. */
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    requestLinkedInAction({
      workspaceId: WS, accountId: ACC,
      person: { linkedinUrl: `https://www.linkedin.com/in/person-${i}`, fullName: `Person ${i}` },
      actionType: "connect", businessUnit: "bd", sourceType: "linkedin_campaign",
      campaignId: "cmp_a", workflowEnrollmentId: `enr_${i}`,
    })));
  const scheduled = burst.filter((r) => r.accepted).length;
  const waiting = burst.filter((r) => r.record.status === "capacity_pending").length;
  ok(scheduled === 3, `concurrent burst books exactly the daily target (got ${scheduled}/3 scheduled)`);
  ok(waiting === 7, `overflow waits for capacity with a reason (got ${waiting}/7 waiting)`);
  ok(burst.every((r) => r.accepted || /capacity|target/i.test(r.reason ?? "")),
    "waiting actions carry a human capacity reason");

  /* 2. Temporary capacity passes the target but NEVER the ceiling. */
  const pending = burst.filter((r) => !r.accepted).map((r) => r.record.id);
  let allowed = 0, refused = 0;
  for (const id of pending) {
    const out = await allowTemporaryCapacity(WS, id, "test-user");
    if (out?.accepted) allowed++; else refused++;
  }
  ok(allowed === 2, `temporary grants fill up to the hard ceiling only (got ${allowed}, want 2: ceiling 5 minus 3 booked)`);
  ok(refused === 5, `the hard ceiling is never silently bypassed (${refused} refused)`);

  /* 3. Idempotency. */
  const k = { workspaceId: WS, accountId: ACC, person: { linkedinUrl: "https://www.linkedin.com/in/idem" }, actionType: "message" as const, businessUnit: "bd" as const, sourceType: "manual" as const, idempotencyKey: "acct|enr|step|0" };
  const first = await requestLinkedInAction(k);
  const second = await requestLinkedInAction(k);
  ok(first.record.id === second.record.id, "idempotency key returns the original ledger record on retry");

  /* 4. Global reply stop. */
  const sarah = await resolveIdentity(WS, { linkedinUrl: "https://www.linkedin.com/in/sarah-m", email: "sarah@acme.com", fullName: "Sarah Miller", company: "Acme" });
  const pre = await requestLinkedInAction({
    workspaceId: WS, accountId: ACC, personIdentityId: sarah.id,
    actionType: "message", payload: { text: "hello" },
    businessUnit: "bd", sourceType: "multichannel_workflow", workflowEnrollmentId: "enr_sarah",
  });
  ok(pre.accepted, "pre-reply action schedules normally");
  const stop = await globalReplyStop(WS, sarah.id, "email");
  ok(stop.cancelledActions >= 1, `reply cancels pending LinkedIn actions (${stop.cancelledActions} cancelled)`);
  const rows = await listLedger(WS);
  const sarahRow = rows.find((r) => r.id === pre.record.id);
  ok(sarahRow?.status === "cancelled" && !sarahRow.capacityDay, "cancelled action released its reserved capacity");
  const post = await requestLinkedInAction({
    workspaceId: WS, accountId: ACC, personIdentityId: sarah.id,
    actionType: "message", businessUnit: "bd", sourceType: "multichannel_workflow", workflowEnrollmentId: "enr_sarah2",
  });
  ok(!post.accepted && post.record.status === "suppressed", "automated actions after a reply are suppressed");
  const manual = await requestLinkedInAction({
    workspaceId: WS, accountId: ACC, personIdentityId: sarah.id,
    actionType: "message", payload: { text: "human reply" },
    businessUnit: "bd", sourceType: "manual",
  });
  ok(manual.accepted, "a HUMAN reply from the inbox still goes out after the automation pause");

  /* 5. Identity dedup across handle variants. */
  const a = await resolveIdentity(WS, { email: "Dan.Roberts@Acme.com", fullName: "Dan Roberts" });
  const b = await resolveIdentity(WS, { email: "dan.roberts@acme.com", linkedinUrl: "https://www.linkedin.com/in/DanRoberts?utm=x" });
  const c = await resolveIdentity(WS, { linkedinUrl: "linkedin.com/in/danroberts" });
  ok(a.id === b.id && b.id === c.id, "email casing + LinkedIn URL variants resolve to one canonical person");

  /* 6. Fair allocation. */
  const slices = allocate(30, [
    { key: "crit", name: "Critical search", businessUnit: "recruiting", priority: "critical", weight: 50, demand: 5, usedToday: 0 },
    { key: "high", name: "BD signals", businessUnit: "bd", priority: "high", weight: 30, demand: 40, usedToday: 0 },
    { key: "low", name: "Nurture", businessUnit: "bd", priority: "low", weight: 20, demand: 40, usedToday: 0 },
  ]);
  const by = Object.fromEntries(slices.map((s) => [s.key, s.allocated]));
  ok(by.crit === 5, `critical gets its full demand and RELEASES the rest (got ${by.crit})`);
  ok(by.high === 25, `next tier absorbs the released capacity (got ${by.high})`);
  ok(by.low === 0, `low priority waits when higher tiers consume the pool (got ${by.low})`);

  const clamped = allocate(20, [
    { key: "a", name: "A", businessUnit: "bd", priority: "normal", weight: 50, demand: 20, maxAllocation: 8, usedToday: 0 },
    { key: "b", name: "B", businessUnit: "bd", priority: "normal", weight: 50, demand: 20, minAllocation: 4, usedToday: 0 },
  ]);
  const byC = Object.fromEntries(clamped.map((s) => [s.key, s.allocated]));
  ok(byC.a <= 8, `max allocation clamps (got ${byC.a} <= 8)`);
  ok(byC.b >= 4, `min allocation floors (got ${byC.b} >= 4)`);

  console.log(fails ? `\n${fails} FAILURE(S)` : "\nAll LinkedIn OS engine checks passed.");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
