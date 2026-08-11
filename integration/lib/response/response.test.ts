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
  await inbox.setHandled(WS, hot.inbound.id, true);
  ok(!needsEscalation((await inbox.getById(WS, hot.inbound.id))!), "handled rows never escalate");

  // 7. Prune bounds the store and keeps the newest.
  for (let i = 0; i < 50; i++) inbox.add(row({ prospectId: null, ws: "ws_prune" }));
  const newestId = (await inbox.list("ws_prune", 1))[0].inbound.id;
  const dropped = await inbox.prune(20, 20, 20);
  ok(dropped > 0, "prune drops something when over cap");
  ok((await inbox.list("ws_prune", 100)).some((p) => p.inbound.id === newestId), "prune keeps the newest rows");

  console.log("response behavior suite: ALL PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
