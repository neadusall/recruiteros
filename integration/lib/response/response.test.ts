/**
 * Reply center — behavior suite.
 * Run: npx tsx lib/response/response.test.ts   (exits non-zero on failure)
 *
 * Guards the load-bearing invariants:
 *   1. Idempotency: a provider message id is claimed exactly once.
 *   2. Soft delete: the row leaves every list but the seen guard still blocks
 *      re-ingest, and it never resurfaces via forPerson.
 *   3. Person threading: forPerson matches by prospect id OR any handle,
 *      case-insensitively; outbound notes tie back via responseIds.
 *   4. Worklist stamps: handled / snoozed / suggested / escalated all persist
 *      and behave.
 *   5. Timing parsing: the comeback dates for the phrases recruiters actually see.
 *   6. Escalation eligibility: only verified, hot, unanswered, un-snoozed,
 *      never-escalated rows past their window.
 *   7. Prune: the snapshot is bounded and keeps the newest rows.
 */

import { ok, strictEqual } from "node:assert";
import { getInbox } from "./repository";
import { ruleFor } from "./rules";
import { timingToDate } from "./timing";
import { needsEscalation } from "./watchdog";
import { operatorPingAllowed } from "./router";
import type { ProcessedResponse, ResponseClass } from "./types";

const WS = "ws_test";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

let seq = 0;
function row(over: {
  cls?: ResponseClass; prospectId?: string | null; campaignId?: string;
  fromHandle?: string; receivedAt?: string; channel?: string; ws?: string;
}): ProcessedResponse {
  const cls = over.cls ?? "positive";
  return {
    inbound: {
      id: "t" + ++seq, workspaceId: over.ws ?? WS, prospectId: over.prospectId ?? null,
      channel: (over.channel ?? "email") as any, source: "smtp",
      providerMessageId: "<pm" + seq + "@x>", fromName: "Test Person",
      fromHandle: over.fromHandle ?? "person" + seq + "@example.com",
      text: "hello", receivedAt: over.receivedAt ?? hoursAgo(0.1),
      campaignId: over.campaignId,
    },
    classification: { class: cls, confidence: 0.9 },
    rule: ruleFor(cls), actionsTaken: [],
  };
}

async function main() {
  const inbox = getInbox();

  // 1. Idempotent claims.
  ok(inbox.claim("<dup@x>"), "first claim wins");
  ok(!inbox.claim("<dup@x>"), "second claim is rejected");

  // 2 + 3. Person threading and soft delete.
  const a = row({ prospectId: "pp1", fromHandle: "Dana@Meridian.com" });
  const b = row({ prospectId: "pp1", channel: "sms", fromHandle: "+15015550100" });
  const c = row({ prospectId: null, fromHandle: "dana@meridian.com" }); // unmatched, same email
  inbox.add(a); inbox.add(b); inbox.add(c);

  const byProspect = await inbox.forPerson(WS, { prospectId: "pp1", handles: ["DANA@MERIDIAN.COM"] });
  strictEqual(byProspect.length, 3, "prospect id + case-insensitive handle pull the whole person");

  await inbox.addOutbound({ id: "o1", workspaceId: WS, responseId: a.inbound.id, prospectId: "pp1", channel: "email" as any, text: "sent", at: hoursAgo(0.05) });
  const notes = await inbox.outboundForPerson(WS, { responseIds: [a.inbound.id] });
  strictEqual(notes.length, 1, "outbound notes tie back via responseIds");

  ok(await inbox.remove(WS, c.inbound.id), "soft delete succeeds");
  const afterDelete = await inbox.forPerson(WS, { prospectId: "pp1", handles: ["dana@meridian.com"] });
  strictEqual(afterDelete.length, 2, "deleted rows never resurface in the person thread");
  ok((await inbox.list(WS, 100)).every((p) => p.inbound.id !== c.inbound.id), "deleted rows leave the list");
  ok(!inbox.claim(c.inbound.providerMessageId), "the seen guard still blocks re-ingest after delete");

  // 4. Worklist stamps persist.
  ok(await inbox.setHandled(WS, a.inbound.id, true), "handled stamp");
  ok(!!(await inbox.getById(WS, a.inbound.id))?.handledAt, "handledAt set");
  ok(await inbox.setSnooze(WS, b.inbound.id, new Date(Date.now() + 3600_000).toISOString()), "snooze stamp");
  ok(await inbox.setSuggested(WS, b.inbound.id, { text: "draft", objective: "send_info", at: new Date().toISOString() }), "suggested stamp");
  await inbox.markEscalated(WS, b.inbound.id);
  ok(!!(await inbox.getById(WS, b.inbound.id))?.escalatedAt, "escalatedAt set");

  // 5. Timing parses (dates in the future, right ballpark).
  const day = 24 * 3600_000;
  const nq = timingToDate("maybe next quarter", new Date("2026-08-11T12:00:00Z"));
  strictEqual(nq?.getMonth(), 9, "next quarter from August = October");
  const q1 = timingToDate("try me in Q1", new Date("2026-08-11T12:00:00Z"));
  strictEqual(q1?.getFullYear(), 2027, "Q1 from August rolls to next year");
  const wks = timingToDate("in 3 weeks");
  ok(wks !== null && Math.abs(wks.getTime() - (Date.now() + 21 * day)) < day, "in 3 weeks = about 21 days");
  ok(timingToDate("no idea what this means") === null, "unknown phrasing abstains");

  // 6. Escalation eligibility.
  const hot = row({ cls: "positive", prospectId: "pp2", receivedAt: hoursAgo(3) }); // immediate SLA = 1h
  inbox.add(hot);
  ok(needsEscalation(hot), "verified positive past the window escalates");
  const cold = row({ cls: "fit_objection", prospectId: "pp2", receivedAt: hoursAgo(30) });
  ok(!needsEscalation(cold), "a non-hot class never escalates");
  const fresh = row({ cls: "positive", prospectId: "pp2", receivedAt: hoursAgo(0.2) });
  ok(!needsEscalation(fresh), "inside the window does not escalate");
  const unverified = row({ cls: "positive", prospectId: null, receivedAt: hoursAgo(3) });
  ok(!needsEscalation(unverified), "warm-up traffic never escalates");

  // 6b. The instant operator ping obeys the same identity wall as escalation:
  //     warm-up chatter never emails the operator, however it gets classified.
  ok(!operatorPingAllowed({ prospectId: null, campaignId: undefined }), "warm-up traffic never pings the operator");
  ok(operatorPingAllowed({ prospectId: "pp9", campaignId: undefined }), "a matched prospect pings");
  ok(operatorPingAllowed({ prospectId: null, campaignId: "mpc-finance" }), "a campaign-attributed reply pings");
  await inbox.setHandled(WS, hot.inbound.id, true);
  ok(!needsEscalation((await inbox.getById(WS, hot.inbound.id))!), "handled rows never escalate");

  // 8. METRICS: the numbers the recruiter steers by, computed from known fixtures.
  {
    const { personSummary, quietHours, computeStats, computeDraftPerf } = await import("./metrics");
    const now = Date.now();
    const iso = (hAgo: number) => new Date(now - hAgo * 3600_000).toISOString();

    // A person: replied 80h ago, we answered 60h ago, then their OOO 10h ago.
    const pRows = [
      row({ cls: "positive", prospectId: "m1", receivedAt: iso(80) }),
      row({ cls: "auto_reply", prospectId: "m1", receivedAt: iso(10) }),
    ];
    const pNotes = [{ id: "mn1", workspaceId: WS, responseId: pRows[0].inbound.id, prospectId: "m1", channel: "email" as any, text: "answer", at: iso(60) }];
    const sum = personSummary(pRows, [], pNotes);
    strictEqual(sum.in.email, 1, "an OOO never counts as an inbound touch");
    strictEqual(sum.lastInAt, pRows[0].inbound.receivedAt, "an OOO never resets lastInAt");
    const q = quietHours(sum, now);
    ok(q !== null && q >= 59 && q <= 61, "quiet clock runs from OUR answer; the OOO does not stop the nudge");

    // Median first response: 30-minute first reply + a 3-day follow-up on the
    // SAME thread must stay a 30-minute median (follow-ups are not first responses).
    const t1 = row({ cls: "positive", prospectId: "m2", receivedAt: iso(80) });
    const statNotes = [
      { id: "sn1", workspaceId: WS, responseId: t1.inbound.id, prospectId: "m2", channel: "email" as any, text: "fast", at: iso(79.5) },
      { id: "sn2", workspaceId: WS, responseId: t1.inbound.id, prospectId: "m2", channel: "email" as any, text: "follow-up", at: iso(8) },
    ];
    const st = computeStats([t1], statNotes, { m2: [{ id: "a1", workspaceId: WS, prospectId: "m2", channel: "system", type: "discovery_call_booked", summary: "Booked", at: iso(20) } as any] }, now);
    strictEqual(st.medianFirstResponseMins, 30, "median counts only the FIRST send per thread");
    strictEqual(st.sent24h, 1, "sent24h counts the follow-up inside 24h only");
    strictEqual(st.booked7d, 1, "a discovery_call_booked activity inside 7d counts as booked");

    // Draft outcomes: an OOO arriving after the send is NOT a reply.
    const dNotes = [{ id: "dn1", workspaceId: WS, responseId: t1.inbound.id, prospectId: "m2", channel: "email" as any, text: "x", at: iso(30), aiDraft: "verbatim" as const, objective: "book_call" }];
    const ooo = row({ cls: "auto_reply", prospectId: "m2", receivedAt: iso(5) });
    const noReply = computeDraftPerf([t1, ooo], dNotes);
    strictEqual(noReply.book_call.replied, 0, "an OOO after the send does not count as a reply");
    const real = row({ cls: "positive", prospectId: "m2", receivedAt: iso(4) });
    const withReply = computeDraftPerf([t1, ooo, real], dNotes);
    strictEqual(withReply.book_call.replied, 1, "a real reply after the send counts");
  }

  // 7. Prune bounds the store and keeps the newest.
  for (let i = 0; i < 50; i++) inbox.add(row({ prospectId: null, ws: "ws_prune" }));
  const newestId = (await inbox.list("ws_prune", 1))[0].inbound.id;
  const dropped = await inbox.prune(20, 20, 20);
  ok(dropped > 0, "prune drops something when over cap");
  ok((await inbox.list("ws_prune", 100)).some((p) => p.inbound.id === newestId), "prune keeps the newest rows");

  // 8. Real replies are first-class: warm-up chatter can neither push them out
  //    of the list window nor evict them from the store.
  {
    const wsR = "ws_realfirst";
    const mpc = row({ cls: "auto_reply", prospectId: null, campaignId: "mpc-finance", ws: wsR, receivedAt: hoursAgo(20) });
    inbox.add(mpc);
    for (let i = 0; i < 30; i++) inbox.add(row({ cls: "unclassified", prospectId: null, ws: wsR }));
    const listed = await inbox.list(wsR, 10);
    ok(listed.some((p) => p.inbound.id === mpc.inbound.id),
      "a day-old campaign reply stays in the window over newer warm-up chatter");
    strictEqual(listed.length, 10, "unverified rows still fill the remaining space");
    await inbox.prune(5, 20, 20);
    const afterPrune = await inbox.forPerson(wsR, { prospectId: null, handles: [mpc.inbound.fromHandle] });
    ok(afterPrune.some((p) => p.inbound.id === mpc.inbound.id),
      "prune evicts warm-up chatter before any real reply");
  }

  console.log("response behavior suite: ALL PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
