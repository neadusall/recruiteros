/* Offline proof that a term read off a vendor's account page corrects the register.

   This is the guard on the mistake that keeps happening: a seeded row carries a GUESS at
   the billing term, nothing ever contradicts it, and the burn figure is out by 12x. The
   plan check answers it with the vendor's own words, so these cases pin down exactly what
   it is allowed to overwrite: a guess yes, an owner-typed invoice figure no. */

import { applyVerifiedPlans, listSpendItems, addSpendItem, updateSpendItem, deleteSpendItem, type VerifiedPlan } from "../lib/owner/spendRegister";

const VENDOR = "FixtureNerd";
const checks: Array<[string, boolean]> = [];
const check = (what: string, pass: boolean) => checks.push([what, pass]);

async function main() {
  await listSpendItems(); // hydrate

  /* Three rows in the state the real register was in: seeded, no price, and one of
     them carrying a guessed term that is simply wrong. */
  const mail = await addSpendItem({
    vendor: VENDOR, label: "Mailcow mail server (8GB)", category: "email",
    billing: "annual", amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
  });
  const nodes = await addSpendItem({
    vendor: VENDOR, label: "Validation nodes (3 boxes)", category: "infra",
    billing: "monthly", amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
  });
  const typed = await addSpendItem({
    vendor: VENDOR, label: "Backup box", category: "infra",
    billing: "monthly", amountUsd: 99, at: "2026-06-01", status: "active",
  });
  // addSpendItem marks a hand-entered row; the two above are stand-ins for seeded rows.
  await updateSpendItem(mail.id, { verified: false });
  await updateSpendItem(nodes.id, { verified: false });

  const plans: VerifiedPlan[] = [
    { vendor: VENDOR, label: "KVM VPS - 8GB (mail.lumesp.com)", billing: "monthly", amountUsd: 16.88, nextDueAt: "2026-08-01" },
    { vendor: VENDOR, label: "Validation nodes (3 boxes)", billing: "annual", amountUsd: 86.94, nextDueAt: "2027-06-01" },
    { vendor: VENDOR, label: "Extra IPv4 Address", billing: "annual", amountUsd: 12, category: "infra" },
    { vendor: VENDOR, label: "Backup box", billing: "annual", amountUsd: 55 },
  ];

  const res = await applyVerifiedPlans(VENDOR, plans, { sourceUrl: "https://example.invalid/services", checkedAt: "2026-07-31T00:00:00.000Z" });
  const after = (await listSpendItems()).filter((i) => i.vendor === VENDOR);
  const row = (id: string) => after.find((i) => i.id === id);
  const ip = after.find((i) => /Extra IPv4/.test(i.label));

  /* The vendor's product name for the mail box resembles ours only faintly. That must
     NOT be acted on either way: rewriting the wrong row and creating a duplicate that
     double-counts the same box are both worse than asking once. */
  const ask = res.needsMapping.find((m) => /8GB/.test(m.planLabel));
  check("a name too unlike ours is not acted on", Boolean(ask) && ask?.candidateId === mail.id);
  check("...so the mail row is left exactly as it was", row(mail.id)?.billing === "annual" && row(mail.id)?.amountUsd === 0);
  check("...and no duplicate row was invented", after.filter((i) => /8GB|mail/i.test(i.label)).length === 1);

  check("the validation nodes were corrected monthly -> annual", row(nodes.id)?.billing === "annual");
  check("the vendor's own wording is remembered for next time", row(nodes.id)?.vendorLabel === "Validation nodes (3 boxes)");
  check("the extra IP became its own row", Boolean(ip) && ip?.billing === "annual" && ip?.amountUsd === 12);
  check("the new row says where it came from", /account page/i.test(ip?.notes ?? ""));
  check("an owner-typed figure is NOT overwritten", row(typed.id)?.amountUsd === 99);
  check("but its term still is: a term is never owner-typed", row(typed.id)?.billing === "annual");
  check("nothing was deleted", after.length === 4);
  check("the renewal date was recorded", row(nodes.id)?.expiresAt === "2027-06-01");
  check("the correction is reported, not silent", res.updated.length === 2 && res.created.length === 1);
  check("a row waiting on an answer is not also reported as gone", !res.missingFromVendor.includes("Mailcow mail server (8GB)"));

  /* One confirmation, and the pairing sticks: the same read now lands on the right row. */
  const res3 = await applyVerifiedPlans(VENDOR, [plans[0]], { map: { "KVM VPS - 8GB (mail.lumesp.com)": mail.id } });
  const mailNow = (await listSpendItems()).find((i) => i.id === mail.id);
  check("a confirmed pairing applies the term", mailNow?.billing === "monthly" && mailNow?.amountUsd === 16.88);
  check("...and needs no second confirmation", res3.needsMapping.length === 0);

  /* A row the vendor page never mentioned is reported, never removed: cancelled and
     "the reader missed a table" must not look the same. */
  const ghost = await addSpendItem({ vendor: VENDOR, label: "Ghost service", category: "infra", billing: "monthly", amountUsd: 5, at: "2026-06-01", status: "active" });
  const res2 = await applyVerifiedPlans(VENDOR, [plans[0]], {});
  check("a row absent from the vendor page is flagged", res2.missingFromVendor.includes("Ghost service"));
  check("...and is still there afterwards", (await listSpendItems()).some((i) => i.id === ghost.id));

  /* force: the owner holds an invoice that disagrees with the page, and says so. */
  await applyVerifiedPlans(VENDOR, [{ vendor: VENDOR, label: "Backup box", billing: "annual", amountUsd: 55 }], { force: true });
  check("force lets the page win when the owner asks", (await listSpendItems()).find((i) => i.id === typed.id)?.amountUsd === 55);

  for (const i of await listSpendItems()) if (i.vendor === VENDOR) await deleteSpendItem(i.id);

  let bad = 0;
  for (const [what, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${what}`);
    if (!pass) bad += 1;
  }
  process.exit(bad ? 1 : 0);
}

main();
