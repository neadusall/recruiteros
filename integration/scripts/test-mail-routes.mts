/**
 * Which mailbox holds which vendor's receipts: regression suite.
 * Run: npx tsx scripts/test-mail-routes.mts   (exits non-zero on failure)
 *
 * The failure this prevents is a blank cell that means four different things at once:
 * the vendor did not charge anything, or it charged and mailed an address nobody reads,
 * or nobody ever said which address it mails, or no mailbox is configured at all. Each
 * has a different fix and only one of them is "nothing to do".
 *
 * The rules that matter:
 *   - a sign-in handle that is not an email is never turned into one;
 *   - a plus-tag is the same mailbox, a different local part is not;
 *   - a receipt that HAS arrived outranks anything the configuration says, because that
 *     is the only way a forwarded address can ever be known to work;
 *   - a vendor that emails no document is not reported as a gap.
 */

import { receiptRouting, receiptEmailFor, mailboxCovers, isEmail } from "../lib/owner/mailRoutes";
import type { SafeEntry } from "../lib/owner/vault";
import type { MailboxCfg } from "../lib/owner/receipts";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

const now = "2026-07-31T00:00:00.000Z";
function acct(id: string, service: string, vendor: string, over: Partial<SafeEntry> = {}): SafeEntry {
  return {
    id, service, vendor, category: "Platform", url: `https://${vendor.toLowerCase()}.test`,
    username: "", hasSecret: true, createdAt: now, updatedAt: now, ...over,
  } as SafeEntry;
}
function box(user: string, inherited = false): MailboxCfg {
  return { user, pass: "x", host: "imap.test", port: 993, label: user, inherited };
}

/* ============================ addresses ============================ */

check("an email is an email", isEmail("ryan@lumesp.com"), true);
check("a sign-in handle is not", isEmail("vmuser346309"), false);

check("a stated billing address is used",
  receiptEmailFor({ billingEmail: "Billing@Lumesp.com", username: "ryan@lumesp.com" }),
  { email: "billing@lumesp.com", from: "billing_email" });
check("the username stands in when it is an email",
  receiptEmailFor({ username: "ryan@lumesp.com" }),
  { email: "ryan@lumesp.com", from: "username" });
/* RackNerd's client area signs in as vmuser346309 and AWS root as an account number.
   Inventing an address from either would send the harvester somewhere confident and
   wrong, which is worse than an honest blank. */
check("a non-email username is never turned into an address",
  receiptEmailFor({ username: "vmuser346309" }), null);

check("the same address is covered", mailboxCovers("ryan@lumesp.com", "ryan@lumesp.com").covered, true);
check("a plus tag is the same mailbox", mailboxCovers("ryan@lumesp.com", "ryan+aws@lumesp.com").covered, true);
check("and it says why", mailboxCovers("ryan@lumesp.com", "ryan+aws@lumesp.com").how, "the same mailbox, sub-addressed");
check("Gmail ignores dots", mailboxCovers("rrnead@gmail.com", "rr.nead@gmail.com").covered, true);
check("other providers do not", mailboxCovers("rrnead@lumesp.com", "rr.nead@lumesp.com").covered, false);
check("a different person on the same domain is not covered",
  mailboxCovers("ryan@lumesp.com", "ariel@lumesp.com").covered, false);
/* A catch-all or a forward is real and common, and CANNOT be known from the address.
   Assuming it would report a vendor as covered while its receipts go nowhere. */
check("a different domain is not covered", mailboxCovers("ryan@lumesp.com", "ryan@dev.com").covered, false);

/* ============================ the report ============================ */

const ENTRIES: SafeEntry[] = [
  acct("v1", "Smartlead", "Smartlead", { billingEmail: "ryan@lumesp.com" }),
  acct("v2", "Zapmail", "Zapmail", { username: "neadusall@gmail.com" }),
  acct("v3", "Porkbun", "Porkbun", { billingEmail: "ryan@dev.com" }),
  acct("v4", "RackNerd (billing)", "RackNerd", { username: "vmuser346309" }),
  acct("v5", "Telnyx", "Telnyx", { billingEmail: "ryan@lumesp.com" }),
];
const BOXES = [box("ryan@lumesp.com"), box("neadusall@gmail.com")];

const r = receiptRouting({ entries: ENTRIES, mailboxes: BOXES, receipts: [] });
const of = (v: string) => r.routes.find((x) => x.vendor === v);

check("a stated address in a swept mailbox is covered", of("Smartlead")?.status, "covered");
check("so is a username that is an address", of("Zapmail")?.status, "covered");
check("and the mailbox is named", of("Zapmail")?.mailbox, "neadusall@gmail.com");
check("an address nobody reads is unswept", of("Porkbun")?.status, "unswept");
/* Two different fixes, and the owner picks: read that mailbox, or change the vendor's
   billing contact to one already being read. Both are named. */
check("and both ways out are named", [
  of("Porkbun")?.fix?.includes("connect-billing-inbox.ps1 ryan@dev.com"),
  of("Porkbun")?.fix?.includes("change the billing contact"),
], [true, true]);
check("an account with no address at all asks for one", of("RackNerd")?.status, "no_email");
check("and says where to type it", of("RackNerd")?.fix?.includes("Passwords"), true);
/* Telnyx issues no document at all, so calling it a missing receipt would bury the real
   gaps under vendors behaving exactly as expected. */
check("a vendor that emails nothing is not a gap", of("Telnyx")?.status, "not_emailed");

check("the reachable count is the two covered", r.reachable, 2);
check("the unreachable count is the one unswept", r.unreachable, 1);
/* `needEmail` also counts every catalogued vendor with no vault account, which is
   correct and is what the last case here checks; among the five accounts in this fixture
   the worklist is the one signing in with a handle rather than an address. */
check("the worklist is the account with no address",
  r.routes.filter((x) => ENTRIES.some((e) => e.vendor === x.vendor) && x.status === "no_email").map((x) => x.vendor),
  ["RackNerd"]);
check("and every vendor with no account of its own is on it too", r.needEmail > 1, true);
check("the worst rows sort first", r.routes[0]?.status, "unswept");
check("mailboxes report how many vendors they carry",
  r.mailboxes.map((m) => [m.user, m.vendors]),
  [["ryan@lumesp.com", 1], ["neadusall@gmail.com", 1]]);

/* ---- evidence outranks configuration ---- */
{
  /* Porkbun bills ryan@dev.com, which is NOT a swept mailbox — and yet its receipts keep
     turning up in neadusall@gmail.com, because that address forwards. No configuration
     can know that; an arrived receipt proves it. */
  const r2 = receiptRouting({
    entries: ENTRIES, mailboxes: BOXES,
    receipts: [
      { vendor: "Porkbun", source: "email", mailbox: "neadusall@gmail.com", chargedAt: "2026-07-22" },
      { vendor: "Porkbun", source: "email", mailbox: "neadusall@gmail.com", chargedAt: "2026-06-22" },
    ],
  });
  const p = r2.routes.find((x) => x.vendor === "Porkbun");
  check("a vendor whose receipts arrive is collecting, whatever the addresses say", p?.status, "collecting");
  check("the mailbox they actually arrive in is the one reported", p?.mailbox, "neadusall@gmail.com");
  check("and the forwarding is stated rather than guessed at",
    p?.matchedBy, "receipts arrive here, so the address forwards into it");
  check("the count is real", p?.emailReceipts, 2);
  check("as is the most recent", p?.lastEmailAt, "2026-07-22");
  check("nothing is left to fix on it", p?.fix, undefined);
}

/* A portal-pulled receipt is not evidence that EMAIL works: it proves the opposite
   channel. Counting it would mark a vendor as collecting and stop the owner fixing the
   mailbox that never delivers. */
{
  const r3 = receiptRouting({
    entries: ENTRIES, mailboxes: BOXES,
    receipts: [{ vendor: "Porkbun", source: "portal", mailbox: undefined, chargedAt: "2026-07-22" }],
  });
  check("a portal receipt does not count as email working",
    r3.routes.find((x) => x.vendor === "Porkbun")?.status, "unswept");
}

/* ---- nothing configured at all: the live state before the owner's step ---- */
{
  const r4 = receiptRouting({ entries: ENTRIES, mailboxes: [], receipts: [] });
  check("with no mailbox every vendor reports the same one cause",
    [...new Set(r4.routes.map((x) => x.status))], ["no_mailbox"]);
  check("and the fix is the single command that changes it",
    r4.routes[0]?.fix?.includes("connect-billing-inbox.ps1"), true);
  check("nothing reads as reachable", r4.reachable, 0);
}

/* ---- a vendor with several accounts is one line, and the filled-in one wins ---- */
{
  const many: SafeEntry[] = [
    acct("t1", "Telnyx (house)", "Telnyx", { username: "ryan@lumesp.com" }),
    acct("t2", "Telnyx (Lume)", "Telnyx", { billingEmail: "billing@lumesp.com" }),
  ];
  const r5 = receiptRouting({ entries: many, mailboxes: [box("billing@lumesp.com")], receipts: [] });
  const t = r5.routes.filter((x) => x.vendor === "Telnyx");
  check("two accounts of one vendor are one line", t.length, 1);
  check("and the stated address beats the fallback", t[0]?.email, "billing@lumesp.com");
}

/* ---- a catalogued vendor with no vault account still appears ---- */
{
  const r6 = receiptRouting({ entries: [], mailboxes: BOXES, receipts: [] });
  check("a vendor with no account is still reported",
    r6.routes.some((x) => x.vendor === "Hetzner" && x.status === "no_email"), true);
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
