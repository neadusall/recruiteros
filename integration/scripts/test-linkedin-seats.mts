/* Per-recruiter LinkedIn seat store tests: the bind-token handshake (single-use,
   unknown tokens rejected), seat CRUD + status transitions, and the webhook
   status sync that flips a recruiter's card to "Reconnect".
   Run from integration/:  npx tsx scripts/test-linkedin-seats.mts */
import {
  seatForUser, upsertSeat, setSeatStatus, markSeatChecked, removeSeat,
  markSeatStatusByAccount, beginConnect, takePending,
} from "../lib/linkedin/seats";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

const WS = "ws_test_seats";
const RYAN = "user_ryan";
const NOAH = "user_noah";

/* ---- 1. Hosted sign-in handshake: token is single-use and user-scoped ---- */
{
  const token = await beginConnect(WS, RYAN, "create");
  ok(typeof token === "string" && token.length >= 24, "handshake: token is long + unguessable", token.length);
  const p = await takePending(token);
  ok(Boolean(p && p.workspaceId === WS && p.userId === RYAN && p.mode === "create"), "handshake: token resolves to exactly the recruiter who clicked", p);
  ok((await takePending(token)) === null, "handshake: token burns on first use");
  ok((await takePending("forged-token-value")) === null, "handshake: unknown tokens rejected");
}

/* ---- 2. Seat CRUD: bind, read back, per-user isolation ---- */
{
  ok((await seatForUser(WS, RYAN)) === null, "seats: empty before connect");
  await upsertSeat(WS, RYAN, { accountId: "acc_ryan_1", label: "Ryan Neadus", status: "ok" });
  const seat = await seatForUser(WS, RYAN);
  ok(Boolean(seat && seat.accountId === "acc_ryan_1" && seat.status === "ok" && seat.label === "Ryan Neadus"), "seats: bound seat reads back", seat);
  ok((await seatForUser(WS, NOAH)) === null, "seats: another recruiter's seat stays empty (per-user isolation)");
  ok((await seatForUser("ws_other", RYAN)) === null, "seats: same user in another workspace stays empty (per-tenant isolation)");
}

/* ---- 3. Re-connect with the SAME account keeps connectedAt; a new account resets it ---- */
{
  const before = await seatForUser(WS, RYAN);
  await upsertSeat(WS, RYAN, { accountId: "acc_ryan_1", status: "ok" });
  const same = await seatForUser(WS, RYAN);
  ok(Boolean(before && same && same.connectedAt === before.connectedAt), "seats: same account keeps original connectedAt");
  ok(Boolean(same && same.label === "Ryan Neadus"), "seats: label survives a re-upsert without one");
  await upsertSeat(WS, RYAN, { accountId: "acc_ryan_2", label: "Ryan N (new)", status: "ok" });
  const fresh = await seatForUser(WS, RYAN);
  ok(Boolean(fresh && fresh.accountId === "acc_ryan_2" && fresh.label === "Ryan N (new)"), "seats: new account id replaces the old seat");
}

/* ---- 4. Status transitions: manual + probe + webhook-driven ---- */
{
  await setSeatStatus(WS, RYAN, "reconnect");
  ok((await seatForUser(WS, RYAN))?.status === "reconnect", "status: manual flip to reconnect");
  await markSeatChecked(WS, RYAN, "ok", "Ryan Neadus");
  const s = await seatForUser(WS, RYAN);
  ok(Boolean(s && s.status === "ok" && s.label === "Ryan Neadus" && s.lastCheckedAt), "status: health probe flips back + stamps lastCheckedAt");

  // Webhook path: provider only knows the account id.
  await upsertSeat(WS, NOAH, { accountId: "acc_noah_1", status: "ok" });
  const flipped = await markSeatStatusByAccount("acc_noah_1", "reconnect");
  ok(flipped === 1, "webhook sync: flips exactly the matching seat", flipped);
  ok((await seatForUser(WS, NOAH))?.status === "reconnect", "webhook sync: Noah's card now says reconnect");
  ok((await seatForUser(WS, RYAN))?.status === "ok", "webhook sync: Ryan untouched");
  ok((await markSeatStatusByAccount("acc_unknown", "reconnect")) === 0, "webhook sync: non-seat accounts no-op");
  ok((await markSeatStatusByAccount("acc_noah_1", "reconnect")) === 0, "webhook sync: idempotent (no re-flip)");
}

/* ---- 5. Disconnect ---- */
{
  const gone = await removeSeat(WS, RYAN);
  ok(Boolean(gone && gone.accountId === "acc_ryan_2"), "disconnect: returns the removed seat");
  ok((await seatForUser(WS, RYAN)) === null, "disconnect: seat is gone");
  ok((await removeSeat(WS, RYAN)) === null, "disconnect: second remove no-ops");
  await removeSeat(WS, NOAH);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
