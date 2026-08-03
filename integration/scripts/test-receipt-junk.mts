/**
 * Receipts: marketing is not money. Regression suite for the strict classifier + junk purge.
 * Run: npx tsx scripts/test-receipt-junk.mts   (exits non-zero on failure)
 *
 * The nightly sweeps of 2026-08-02/03 filed 165 marketing and notification emails as vendor
 * charges: LinkedIn job alerts as LinkedIn spend (a $100,000 salary in a job title became a
 * $100,000 receipt), Amazon retail Prime Day blasts as AWS, AppSumo deal mail as TidyCal
 * (one for $2,749,741.93), "payment unsuccessful" notices as Anthropic money. Three holes,
 * each pinned here:
 *
 *   1. classify() matched subject hints against a haystack CONTAINING THE SENDER ADDRESS,
 *      and every vendor's hint list began with its own name, so every mail a vendor sent
 *      was "billing". Now a message files on receipt WORDS (subject or body), never on the
 *      vendor's identity.
 *   2. amazon.com was listed as an AWS sender and appsumo.com as a TidyCal sender, so a
 *      marketplace's whole mail stream wore one vendor's name.
 *   3. Nothing re-judged what an earlier sweep had already filed. purgeJunkEmail() /
 *      junkWhy() apply the current classifier to the vault, purge email duplicates of
 *      portal invoices, and repair refund-sign and future-date parse errors.
 *
 * Every subject below is a REAL one from the polluted prod vault of 2026-08-03.
 */
import { classify, junkWhy, parseReceiptText, type MailMessage, type Receipt } from "../lib/owner/receipts";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

function msg(m: Partial<MailMessage>): MailMessage {
  return { subject: "", from: "x@example.com", date: "2026-07-15", text: "", attachments: [], ...m };
}
const billing = (m: Partial<MailMessage>) => classify(msg(m)).billing;

/* ---- real receipts still classify as billing ---- */
{
  check("Stripe receipt subject", billing({ subject: "Your receipt from Anthropic, PBC #2500-8221-2736", from: "invoice@stripe.com" }), true);
  check("Hetzner numbered invoice", billing({ subject: "Hetzner Online GmbH - Invoice 086000951457 (K0519682326)", from: "no-reply@hetzner.com" }), true);
  check("WHMCS payment confirmation", billing({ subject: "Credit Card Payment Confirmation", from: "billing@racknerd.com" }), true);
  check("Telnyx top-up", billing({ subject: "[Telnyx LLC] Payment Success", from: "noreply@telnyx.com" }), true);
  check("Dynadot order received", billing({ subject: "Order Received (order 25629255) (account rrneadclaimie26)", from: "billing@dynadot.com" }), true);
  check("Porkbun order thank-you", billing({ subject: "porkbun.com | Order - Thank You - 11083780", from: "orders@porkbun.com" }), true);
  check("GoDaddy order thank-you", billing({ subject: "Ryan Nead, thank you for your order.", from: "donotreply@godaddy.com" }), true);
  check("LinkedIn Premium purchase", billing({ subject: "Thank you for purchasing Premium Career", from: "billing-noreply@linkedin.com" }), true);
  check("forwarded Stripe receipt", billing({ subject: "FW: Your receipt from Zapmail #2957-3715", from: "ryan@lumesp.com" }), true);
  check("known sender, billing word + body total", billing({
    subject: "Your July subscription", from: "billing@rapidapi.com",
    text: "Amount paid $433.99 for the period Jul 1 to Jul 31",
  }), true);
}

/* ---- the junk that was filed classifies as not-billing ---- */
{
  check("job alert with salary", billing({ subject: "Technical Recruiter insights: $88K/yr+ salary at 992 job openings", from: "jobs-noreply@linkedin.com" }), false);
  check("job posting", billing({ subject: "Recruiter, Sr. at Sundayy", from: "jobs-noreply@linkedin.com", text: "$100,000/yr" }), false);
  check("Prime Day blast", billing({ subject: "PRIME DAY is here! Four days of epic deals, up to 40% off.", from: "store-news@amazon.com", text: "Save $219.99 today" }), false);
  check("Amazon sweepstake", billing({ subject: "Enter to win $10,000 in groceries, plus more early Prime Day deals!", from: "store-news@amazon.com" }), false);
  check("AppSumo deal blast", billing({ subject: "Deal of the Day: Sbl.so (10% off!)", from: "deals@appsumo.com", text: "was $190 now $19" }), false);
  check("revenue brag", billing({ subject: "$2,749,741.93 made using TidyCal", from: "team@tidycal.com" }), false);
  check("failed payment", billing({ subject: "$45.00 payment to Anthropic, PBC was unsuccessful", from: "invoice@stripe.com" }), false);
  check("renewal reminder", billing({ subject: "Ryan Nead: Your GoDaddy Renewal Notice", from: "renewals@godaddy.com", text: "renew now for $51.99" }), false);
  check("expiry warning", billing({ subject: "Your domain expires soon.", from: "renewals@godaddy.com" }), false);
  check("sign-in notice", billing({ subject: "New sign-in detected on your Vercel account", from: "security@vercel.com" }), false);
  check("rate-limit notice", billing({ subject: "You're hitting your API rate limit", from: "billing@anthropic.com", text: "your $40 plan" }), false);
  check("welcome mail", billing({ subject: "Welcome to Dynadot! (account talrecruitersos)", from: "info@dynadot.com", text: "domains from $5" }), false);
  check("support ticket", billing({ subject: "[Ticket ID: EF47985] Looking for IPs to add to my VPS", from: "support@racknerd.com", text: "$12 per IP block" }), false);
  check("release notes", billing({ subject: "Tuned In: June Release Notes", from: "team@cartesia.ai", text: "pro is $24.09" }), false);
  check("product marketing with billing word", billing({ subject: "Multi-tenant billing portal", from: "news@hetzner.com", text: "from $10 a month" }), false);
  check("3DS prompt", billing({ subject: "3DS Verification Reminder (order 25021541) (account talrecruitersos)", from: "billing@dynadot.com" }), false);
}

/* ---- a known sender's body alone cannot file: it relays other people's words ---- */
{
  check("InMail quoting a demand letter", billing({
    subject: "Janine just messaged you", from: "messages-noreply@linkedin.com",
    text: "Re: Formal Demand for Full Refund. Total Paid: $11,900 (Paid in full)",
  }), false);
  check("PayPal receipt for someone else's product", billing({
    subject: "Google: $2.17 USD", from: "service@paypal.com",
    text: "You paid $2.17 USD to Google",
  }), false);
}

/* ---- an invoice being issued is not a payment ---- */
{
  check("WHMCS invoice generated", billing({ subject: "RackNerd - Invoice #23964835 Generated", from: "billing@racknerd.com", text: "Amount due $35.99" }), false);
  check("WHMCS customer invoice", billing({ subject: "Customer Invoice", from: "billing@racknerd.com", text: "Invoice total $36.59" }), false);
  check("WHMCS order placed", billing({ subject: "RackNerd - Order 5930932623", from: "billing@racknerd.com", text: "Order total $35.99" }), false);
  check("invoice-issued notice", billing({ subject: "New invoice from sending.ac #YWOJGCVU-0001", from: "invoice@stripe.com" }), false);
}

/* ---- junkWhy: the vault-side verdict ---- */
function rc(r: Partial<Receipt>): Receipt {
  return {
    id: "r1", period: "2026-07", vendor: "LinkedIn", amountUsd: 100, chargedAt: "2026-07-10",
    kind: "charge", source: "email", hasShot: false, confidence: 0.9, matchedBy: "test",
    createdAt: "2026-08-02T05:00:00Z", updatedAt: "2026-08-02T05:00:00Z",
  } as Receipt;
}
{
  const alert = { ...rc({}), subject: "Director of Recruiting insights: $180K/yr+ salary at 25 job openings", from: "jobs-noreply@linkedin.com", excerpt: "salaries near you" };
  check("a filed job alert is junk", junkWhy(alert, [alert]) !== null, true);

  const real = { ...rc({}), vendor: "Hetzner", subject: "Hetzner Online GmbH - Invoice 086000951457", from: "no-reply@hetzner.com", amountUsd: 50.47 };
  check("a filed real invoice stands", junkWhy(real, [real]), null);

  /* The marketplace attribution hole: appsumo.com no longer identifies TidyCal (and the
     owner has retired TidyCal everywhere), so an AppSumo order cannot survive under it. */
  const other = { ...rc({}), vendor: "TidyCal", subject: "Order Confirmation: Deftform", from: "orders@appsumo.com", excerpt: "You bought Deftform. Order total $49.00", amountUsd: 49 };
  check("another product's AppSumo order is junk under TidyCal", junkWhy(other, [other]) !== null, true);

  /* A vendor retired from BOTH the register and the source catalogue has no line left to
     prove: even a genuinely receipt-shaped message of theirs leaves the books. */
  const tidy = { ...rc({}), vendor: "TidyCal", subject: "Order Confirmation", from: "orders@appsumo.com", excerpt: "You bought TidyCal (lifetime). Order total $29.00", amountUsd: 29 };
  check("a retired vendor's receipt is junk", junkWhy(tidy, [tidy]) !== null, true);
}

/* ---- an email copy of a charge the portal already proves is the copy that goes ---- */
{
  const portal = { ...rc({}), id: "p1", vendor: "Zapmail", source: "portal" as const, amountUsd: 441.66, invoiceNumber: "CJDLTZUT-0002" };
  const emailCopy = {
    ...rc({}), id: "e1", vendor: "Zapmail", amountUsd: 391.66,
    subject: "FW: Your receipt from Zapmail #2957-3715", from: "ryan@lumesp.com",
    fileName: "Invoice-CJDLTZUT-0002.pdf",
  };
  check("email copy of a portal invoice is junk", junkWhy(emailCopy, [portal, emailCopy]) !== null, true);
  const equalCopy = { ...emailCopy, id: "e2", amountUsd: 441.66, fileName: undefined };
  check("equal-amount email copy is junk", junkWhy(equalCopy, [portal, equalCopy]) !== null, true);
  const unrelated = { ...emailCopy, id: "e3", period: "2026-06", amountUsd: 299, fileName: undefined, subject: "Your receipt from Zapmail #1111-2222" };
  check("a different month's email receipt stands", junkWhy(unrelated, [portal, unrelated]), null);
}

/* ---- a repaired row is not junk: doubting a date is not doubting who was paid ---- */
{
  /* The date repair used to lower confidence to 0.5, and the relevance rung then read the
     row as unevidenced and flagged two real GoDaddy orders for deletion on the next pass.
     A sender the vendor's catalogue claims is evidence from outside the body, whatever the
     stored confidence says. */
  const repaired = {
    ...rc({}), vendor: "GoDaddy", confidence: 0.5, amountUsd: 30.98,
    subject: "Ryan Nead, thank you for your order.", from: "donotreply@godaddy.com",
  };
  check("a date-repaired row from the vendor's own domain stands", junkWhy(repaired, [repaired]), null);
}

/* ---- a refund has to be stated, not mentioned ---- */
{
  const order = parseReceiptText("Thank you for your order. Order total $30.98. See our Refund Policy at godaddy.com/refunds.");
  check("a refund-policy footer is still a charge", order?.kind, "charge");
  const refund = parseReceiptText("Your refund of $30.98 has been processed. Amount refunded: $30.98");
  check("a stated refund is a refund", refund?.kind, "refund");
}

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
