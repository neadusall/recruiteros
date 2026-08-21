/**
 * Regression suite for the paid people-search rung.
 *
 * THE RULE IT DEFENDS: a refusal must never be readable as an answer.
 *
 * `fresh-linkedin-scraper-api.p.rapidapi.com` does not use HTTP status to signal failure.
 * It answers HTTP **202** and puts the outcome in the body:
 *
 *     {"success":false,"message":"Request failed with status 429: Too Many Requests","cost":1}
 *
 * Every case below is built from a body captured live on 2026-08-21, when JD Sourcing's
 * health watch reported "the listing answered but returned no LinkedIn profiles" for a
 * workspace whose plan had 11,310 of 20,000 requests left. Nothing was empty; every call
 * was being turned away, and each refusal billed a credit ("cost":1) on the way out.
 *
 * Run: node --test --import tsx integration/lib/sourcing/peopleSearch.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SOURCING_THROTTLE_BACKOFF_MS = "0";   // the retry ladders, without the waiting
process.env.RAPIDAPI_KEY = "test-key";
process.env.RAPIDAPI_PEOPLE_SEARCH_METHOD = "GET";

import { rapidApiPeopleSearch, isPeopleSearchThrottled } from "./discovery";

/** The provider's throttle envelope, verbatim from the live capture. */
const THROTTLE_202 = {
  status: 202,
  body: `{"success":false,"message":"Request failed with status 429: Too Many Requests","process_time":271,"cost":1,"page":1,"status_code":200}`,
};

/** Point the search at a host nobody else in this file uses: the throttle breaker is
 *  keyed by host, so sharing one between tests would leak a bench across cases. */
function useHost(host: string): void {
  process.env.RAPIDAPI_PEOPLE_SEARCH_HOST = host;
}

/** Stub the network with a fixed reply; returns the call counter. */
function stubFetch(reply: { status: number; body: string }): { calls: number } {
  const state = { calls: 0 };
  (globalThis as any).fetch = async () => {
    state.calls++;
    return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } });
  };
  return state;
}

const search = () => rapidApiPeopleSearch({ name: "recruiter", page: 1, limit: 3 });

test("a 202 throttle envelope is a refusal, never an empty result", async () => {
  useHost("throttle-202.test");
  const net = stubFetch(THROTTLE_202);
  await assert.rejects(search, (e: unknown) => {
    assert.ok(isPeopleSearchThrottled(e), "must be reported as a throttle, not a generic failure");
    assert.match((e as Error).message, /throttled/i);
    return true;
  });
  // Asked again before giving up: one refusal is not proof the provider is busy.
  assert.equal(net.calls, 3, "should retry the throttle before giving up");
});

test("a genuinely empty answer is an answer, and is returned as one", async () => {
  useHost("empty.test");
  const net = stubFetch({ status: 200, body: `{"success":true,"data":[]}` });
  assert.deepEqual(await search(), []);
  assert.equal(net.calls, 1, "an empty answer is the truth; asking again wastes a credit");
});

test("people come back mapped", async () => {
  useHost("people.test");
  stubFetch({
    status: 200,
    body: JSON.stringify({
      success: true,
      data: [{ full_name: "Dana Reed", title: "VP of Sales @ Uplinq", url: "https://linkedin.com/in/danareed?trk=x" }],
    }),
  });
  const rows = await search();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fullName, "Dana Reed");
  assert.equal(rows[0].company, "Uplinq");
  assert.equal(rows[0].linkedinUrl, "https://linkedin.com/in/danareed");
});

test("RapidAPI's own per-minute plan limit is a throttle too, not a transport error", async () => {
  useHost("plan-429.test");
  stubFetch({
    status: 429,
    body: `{"message":"You have exceeded the rate limit per minute for your plan, PRO, by the API provider"}`,
  });
  await assert.rejects(search, (e: unknown) => isPeopleSearchThrottled(e));
});

test("success:false that is NOT a throttle is a real error, not zero results", async () => {
  useHost("apifail.test");
  await assert.rejects(
    (() => { stubFetch({ status: 200, body: `{"success":false,"message":"captcha required"}` }); return search(); })(),
    (e: unknown) => {
      assert.equal(isPeopleSearchThrottled(e), false, "a captcha will not clear by waiting");
      assert.match((e as Error).message, /captcha required/);
      return true;
    },
  );
});

test("the breaker benches a throttled listing, so later queries cost nothing", async () => {
  useHost("breaker.test");
  const net = stubFetch(THROTTLE_202);
  await assert.rejects(search, (e: unknown) => isPeopleSearchThrottled(e));
  const spentSoFar = net.calls;
  // Second query, same listing, still inside the cool-down: refused locally.
  await assert.rejects(search, (e: unknown) => {
    assert.ok(isPeopleSearchThrottled(e));
    assert.match((e as Error).message, /paused for another/);
    return true;
  });
  assert.equal(net.calls, spentSoFar, "a benched listing must not be called again while it cools");
});
