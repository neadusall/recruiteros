#!/usr/bin/env bash
#
# Say WHY the receipt sweep is finding nothing.
#
# Owner Console -> Spend master -> "Pull receipts from the mailbox" reports a one-line
# error when it fails, and the line IMAP hands back ("Command failed") does not say
# whether the mailbox refused the password, whether the server was unreachable, or
# whether the address simply has no such folder. This asks each configured mailbox
# directly and says which of those it is.
#
#   Run on the server:
#     bash /opt/recruiteros/check-billing-inbox.sh
#
# It is READ-ONLY in every sense: it opens a connection, logs in, counts the folders,
# logs out. Nothing is read, moved, deleted or marked. It prints no passwords: only the
# address, the host, and the result.
#
# If a mailbox reports REJECTED, the password stored for it is not one the provider
# accepts over IMAP. Gmail and Microsoft 365 both refuse the account password and want
# an app password:
#   Gmail          myaccount.google.com/apppasswords   (2-step verification must be on)
#   Microsoft 365  account.microsoft.com security -> app passwords
# Then store it:
#   bash /opt/recruiteros/set-billing-inbox.sh <email> '<app-password>'
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "Checking the mailboxes the receipt sweep is configured to read."
echo

docker compose exec -T app node -e '
const { ImapFlow } = require("imapflow");

function guessHost(user) {
  const d = (user.split("@")[1] || "").toLowerCase();
  if (d === "gmail.com" || d === "googlemail.com") return "imap.gmail.com";
  if (["outlook.com", "hotmail.com", "live.com", "office365.com"].includes(d)) return "outlook.office365.com";
  if (d === "yahoo.com") return "imap.mail.yahoo.com";
  return d ? "outlook.office365.com" : "";
}

/* Same resolution order as lib/owner/receipts.ts: the dedicated billing mailboxes
   first, and only when none is set does it fall back to the resume inbox. */
const E = process.env;
const boxes = [];
const add = (user, pass, host, port, from) => {
  if (!user || !pass) return;
  const h = host || guessHost(user);
  if (!h) return;
  if (boxes.some((b) => b.user.toLowerCase() === user.toLowerCase())) return;
  boxes.push({ user, pass, host: h, port: Number(port) || 993, from });
};
add(E.BILLING_INBOX_USER, E.BILLING_INBOX_PASS, E.BILLING_INBOX_HOST, E.BILLING_INBOX_PORT, "BILLING_INBOX_*");
for (const n of [2, 3, 4]) {
  add(E[`BILLING_INBOX_${n}_USER`], E[`BILLING_INBOX_${n}_PASS`], E[`BILLING_INBOX_${n}_HOST`], E[`BILLING_INBOX_${n}_PORT`], `BILLING_INBOX_${n}_*`);
}
if (!boxes.length) add(E.RESUME_INBOX_USER, E.RESUME_INBOX_PASS, E.RESUME_INBOX_HOST, E.RESUME_INBOX_PORT, "RESUME_INBOX_* (fallback)");

if (!boxes.length) {
  console.log("NOTHING CONFIGURED. No BILLING_INBOX_* keys are set and the resume inbox is empty,");
  console.log("so the sweep has no mailbox to read. Store one:");
  console.log("  bash /opt/recruiteros/set-billing-inbox.sh <email> \x27<app-password>\x27");
  process.exit(0);
}

(async () => {
  for (const b of boxes) {
    const label = `${b.user} (${b.host}:${b.port}, from ${b.from})`;
    const client = new ImapFlow({ host: b.host, port: b.port, secure: true, auth: { user: b.user, pass: b.pass }, logger: false, greetingTimeout: 15000, socketTimeout: 30000 });
    client.on("error", () => {});
    try {
      await client.connect();
      const list = await client.list();
      const names = list.map((f) => f.path);
      const wanted = ["INBOX", "Archive", "[Gmail]/All Mail", "Receipts", "Billing"].filter((f) => names.includes(f));
      console.log(`OK        ${label}`);
      console.log(`          ${names.length} folders; the sweep will read: ${wanted.join(", ") || "INBOX only"}`);
      await client.logout().catch(() => {});
    } catch (e) {
      const msg = String((e && e.message) || e);
      const rejected = (e && e.authenticationFailed) || /auth/i.test(msg) || msg === "Command failed";
      if (rejected) {
        console.log(`REJECTED  ${label}`);
        console.log(`          The mailbox refused the sign-in. Gmail and Microsoft 365 both reject the`);
        console.log(`          account password over IMAP and want an app password. Once you have one:`);
        console.log(`            bash /opt/recruiteros/set-billing-inbox.sh ${b.user} \x27<app-password>\x27`);
        if (e && e.responseText) console.log(`          server said: ${String(e.responseText).slice(0, 160)}`);
      } else {
        console.log(`FAILED    ${label}`);
        console.log(`          ${msg.slice(0, 200)}`);
        console.log(`          This is the connection, not the password: check the host and port.`);
      }
    }
  }
})();
'

echo
echo "Then pull the receipts in: Owner Console -> Spend master -> Pull receipts from the mailbox."
