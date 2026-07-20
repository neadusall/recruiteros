/**
 * Regression suite for the per-recruiter monthly Boost phones budget.
 *
 * The rule (user mandate 2026-07-20): every recruiter gets $150 of Boost spend
 * per calendar month, they can always see where they stand, and the SERVER is
 * the fail-safe: no client input may push a recruiter past the cap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { devLedger, userMonthSpend } from "../billing/ledger";
import { boostBudget, boostMonthlyCapUsd, runPremiumPhoneBoost } from "./premiumPhone";
import type { SourcingRun } from "./types";

const WS = "ws_test_budget";
const EMAIL = "recruiter@example.com";

function seedEvent(costUsd: number, at: string, userEmail = EMAIL, type = "premium_phone_boost") {
  devLedger().events.push({
    id: "use_test_" + Math.random().toString(36).slice(2),
    workspaceId: WS,
    motion: "recruiting",
    category: "enrichment",
    type,
    source: "rapidapi_skiptrace",
    quantity: Math.round(costUsd / 0.1),
    unitCostUsd: 0.1,
    costUsd,
    meta: { userEmail },
    at,
  });
}

function isoThisMonth(): string {
  return new Date().toISOString();
}
function isoLastMonth(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString();
}

test("userMonthSpend counts only this month, this user, this type", () => {
  devLedger().events.length = 0;
  seedEvent(10, isoThisMonth());
  seedEvent(5, isoThisMonth());
  seedEvent(99, isoLastMonth());                       // previous month: ignored
  seedEvent(7, isoThisMonth(), "other@example.com");   // someone else: ignored
  seedEvent(3, isoThisMonth(), EMAIL, "email_find");   // different type: ignored
  assert.equal(userMonthSpend(WS, EMAIL, "premium_phone_boost"), 15);
  assert.equal(userMonthSpend(WS, "", "premium_phone_boost"), 0); // no identity, no spend
});

test("boostBudget: remaining floors at zero once the cap is passed", async () => {
  devLedger().events.length = 0;
  seedEvent(140, isoThisMonth());
  let b = await boostBudget(WS, EMAIL);
  assert.equal(b.capUsd, boostMonthlyCapUsd());
  assert.equal(b.spentUsd, 140);
  assert.equal(b.remainingUsd, Math.round((b.capUsd - 140) * 100) / 100);
  seedEvent(60, isoThisMonth()); // now over the cap
  b = await boostBudget(WS, EMAIL);
  assert.equal(b.remainingUsd, 0);
});

function fakeRun(): SourcingRun {
  return {
    id: "srun_test", workspaceId: WS, name: "t", jd: "", icp: {} as any, queries: [],
    candidates: [{ fullName: "Pat Example", company: "Acme" } as any],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any as SourcingRun;
}

test("runPremiumPhoneBoost refuses when the monthly budget is spent (fail-closed)", async () => {
  devLedger().events.length = 0;
  seedEvent(150, isoThisMonth());
  const r = await runPremiumPhoneBoost(WS, fakeRun(), { max: 20, actor: { userEmail: EMAIL } });
  assert.equal(r.called, 0);
  assert.equal(r.costUsd, 0);
  assert.equal(r.budgetExhausted, true);
  assert.match(String(r.stoppedEarly), /budget/i);
});

test("runPremiumPhoneBoost refuses when spend cannot be attributed to a recruiter", async () => {
  devLedger().events.length = 0;
  const r = await runPremiumPhoneBoost(WS, fakeRun(), { max: 20, actor: {} });
  assert.equal(r.called, 0);
  assert.equal(r.costUsd, 0);
  assert.match(String(r.stoppedEarly), /attributed/i);
});
