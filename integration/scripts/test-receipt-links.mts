/**
 * Pulling the vendor's PDF out of an email that only LINKS to it: regression suite.
 * Run: npx tsx scripts/test-receipt-links.mts   (exits non-zero on failure)
 *
 * The harvester used to read attachments and nothing else, so it collected a document
 * from the minority of vendors that attach one. Most send a button. This pins the two
 * halves of clicking it:
 *
 *   FINDING the link — the document link has to win against the unsubscribe link, the
 *   manage-subscription link, the logo and the social icons, in a message where the
 *   href is usually an opaque click-tracker and the only readable signal is the words
 *   on the button;
 *
 *   FOLLOWING it safely — an email body is untrusted input that this server will fetch,
 *   so a mailed link must never reach loopback, a private range or the cloud metadata
 *   address, and must not be able to get there by redirecting after the first check.
 *
 * Every network call is stubbed, so this proves the parsing and the fences with no live
 * invoice, no vendor and no network.
 */

import {
  findInvoiceLinks, isPublicAddress, isStripeHostedUrl, pdfLinksInHtml,
  fetchInvoiceDocument, pullEmailDocument, type Net,
} from "../lib/owner/receiptLinks";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}
function checkThat(name: string, got: boolean): void { check(name, got, true); }

/* ============================ 1. finding the link ============================ */

/** A real-shaped receipt email: a button, a footer, and a tracker in front of both. */
const STRIPE_EMAIL = `
<html><body>
  <a href="https://email.stripe.com/c/track/abc123"><img src="https://x.test/logo.png"></a>
  <p>Receipt from Zapmail</p>
  <p>Amount paid $299.00</p>
  <a href="https://invoice.stripe.com/i/acct_1AB/live_YWNjdF8x?s=em" style="color:#fff">Download invoice</a>
  <a href="https://app.zapmail.ai/billing">Manage your subscription</a>
  <a href="https://email.stripe.com/unsubscribe/xyz">Unsubscribe</a>
  <a href="https://twitter.com/zapmail">Follow us</a>
</body></html>`;

const links = findInvoiceLinks({ html: STRIPE_EMAIL });
check("the Stripe invoice link wins", links[0]?.url, "https://invoice.stripe.com/i/acct_1AB/live_YWNjdF8x?s=em");
checkThat("unsubscribe is never a candidate", !links.some((l) => /unsubscribe/.test(l.url)));
checkThat("social links are dropped", !links.some((l) => /twitter/.test(l.url)));
checkThat("the logo image is not a candidate", !links.some((l) => /logo\.png/.test(l.url)));
checkThat("a bare tracker with no words scores under the floor", !links.some((l) => /c\/track/.test(l.url)));
check("the winner explains itself", links[0]?.why.includes("invoice.stripe.com serves invoices"), true);

/* A tracker-wrapped button: the href says nothing, the words say everything. */
const TRACKED = `<a href="https://u123.ct.sendgrid.net/ls/click?upn=deadbeef">Download your receipt (PDF)</a>
  <a href="https://u123.ct.sendgrid.net/ls/click?upn=cafe">Visit the help centre</a>`;
const tracked = findInvoiceLinks({ html: TRACKED });
check("a tracked link is judged on its button text", tracked[0]?.url, "https://u123.ct.sendgrid.net/ls/click?upn=deadbeef");
check("only the one that says receipt survives", tracked.length, 1);

/* An <a> whose label is an image button carries the words in the alt text. */
const IMG_BUTTON = `<a href="https://billing.acme.test/invoices/8891"><img alt="View invoice" src="https://x.test/b.png"></a>`;
check("an image button is still read", findInvoiceLinks({ html: IMG_BUTTON }).length, 1);

/* Plain-text parts have no labels at all, so the address has to carry it alone. */
const textOnly = findInvoiceLinks({ text: "Your receipt: https://acme.test/receipts/44.pdf\nHelp: https://acme.test/help" });
check("a bare PDF link in plain text is found", textOnly[0]?.url, "https://acme.test/receipts/44.pdf");
check("a bare link with nothing said about it is not chased", textOnly.length, 1);
check("trailing punctuation is not part of the URL",
  findInvoiceLinks({ text: "see https://acme.test/invoice/9.pdf." })[0]?.url, "https://acme.test/invoice/9.pdf");

check("a direct PDF outranks a hosted page",
  findInvoiceLinks({ html: `<a href="https://a.test/billing/x">Invoice</a><a href="https://a.test/i/9.pdf">Invoice</a>` })[0]?.url,
  "https://a.test/i/9.pdf");
check("a message with no links yields nothing", findInvoiceLinks({ html: "<p>Thanks!</p>" }).length, 0);
check("entity-encoded hrefs are decoded",
  findInvoiceLinks({ html: `<a href="https://a.test/inv?id=1&amp;t=2">Download invoice</a>` })[0]?.url,
  "https://a.test/inv?id=1&t=2");

check("a Stripe hosted link is recognised", isStripeHostedUrl("https://invoice.stripe.com/i/acct_1/live_x?s=ap"), true);
check("a Stripe dashboard link is not", isStripeHostedUrl("https://dashboard.stripe.com/invoices/in_1"), false);

/* ============================ 2. the fences ============================ */

check("loopback is refused", isPublicAddress("127.0.0.1"), false);
check("the cloud metadata address is refused", isPublicAddress("169.254.169.254"), false);
check("private class A is refused", isPublicAddress("10.0.0.7"), false);
check("the docker bridge is refused", isPublicAddress("172.17.0.2"), false);
check("172.32 is public, not private", isPublicAddress("172.32.0.1"), true);
check("private class C is refused", isPublicAddress("192.168.1.5"), false);
check("carrier-grade NAT is refused", isPublicAddress("100.64.0.1"), false);
check("IPv6 loopback is refused", isPublicAddress("::1"), false);
check("IPv6 unique-local is refused", isPublicAddress("fd00::1"), false);
check("an IPv4-mapped private address is refused", isPublicAddress("::ffff:127.0.0.1"), false);
check("a real address is allowed", isPublicAddress("104.18.2.1"), true);
check("a public IPv6 address is allowed", isPublicAddress("2606:4700::1111"), true);

/* ---- a link that resolves inside the network is not followed ---- */
{
  let fetched = 0;
  const net: Net = {
    resolve: async () => ["127.0.0.1"],
    fetch: (async () => { fetched++; return new Response("", { status: 200 }); }) as typeof fetch,
  };
  const err = await fetchInvoiceDocument("https://evil.test/invoice.pdf", net).catch((e: Error) => e.message);
  checkThat("a link resolving to loopback is refused", String(err).includes("inside this network"));
  check("and nothing was fetched", fetched, 0);
}

/* ---- REDIRECTING to a private address after passing the first check ---- */
{
  const net: Net = {
    resolve: async (h) => (h === "safe.test" ? ["93.184.216.34"] : ["169.254.169.254"]),
    fetch: (async (url: string) =>
      String(url).includes("safe.test")
        ? new Response("", { status: 302, headers: { location: "http://metadata.test/latest/meta-data/" } })
        : new Response("secrets", { status: 200 })) as unknown as typeof fetch,
  };
  const err = await fetchInvoiceDocument("https://safe.test/invoice.pdf", net).catch((e: Error) => e.message);
  checkThat("every redirect hop is re-checked, not just the first", String(err).includes("inside this network"));
}

/* ---- no credential of ours ever travels with a mailed link ---- */
{
  let sent: Record<string, string> = {};
  const net: Net = {
    resolve: async () => ["93.184.216.34"],
    fetch: (async (_u: string, init: RequestInit) => {
      sent = (init.headers || {}) as Record<string, string>;
      return new Response(Buffer.from("%PDF-1.4 x"), { status: 200, headers: { "content-type": "application/pdf" } });
    }) as unknown as typeof fetch,
  };
  const doc = await fetchInvoiceDocument("https://acme.test/i/9.pdf", net);
  check("the PDF is taken as-is", doc.via, "the link was the PDF");
  check("its type is right", doc.mime, "application/pdf");
  checkThat("no cookie is sent", !Object.keys(sent).some((k) => /cookie/i.test(k)));
  checkThat("no Authorization is sent", !Object.keys(sent).some((k) => /authorization/i.test(k)));
}

/* ---- an oversized document is refused rather than swallowing the box ---- */
{
  const net: Net = {
    resolve: async () => ["93.184.216.34"],
    fetch: (async () => new Response(Buffer.from("%PDF-1.4"), {
      status: 200, headers: { "content-type": "application/pdf", "content-length": String(200 * 1024 * 1024) },
    })) as unknown as typeof fetch,
  };
  const err = await fetchInvoiceDocument("https://acme.test/i/big.pdf", net).catch((e: Error) => e.message);
  checkThat("a 200MB document is refused", String(err).includes("over the limit"));
}

/* ============================ 3. following it ============================ */

/* ---- shape 3: an HTML invoice page that names the PDF ---- */
check("a PDF named in an invoice page is found", pdfLinksInHtml(
  `<a href="/files/inv-1.pdf">Download</a>`, "https://acme.test/invoice/1"),
  ["https://acme.test/files/inv-1.pdf"]);
check("a PDF named in the page's own JSON is found", pdfLinksInHtml(
  `<script>window.__DATA__={"invoice_pdf":"https:\\/\\/files.acme.test/a.pdf"}</script>`, "https://acme.test/x"),
  ["https://files.acme.test/a.pdf"]);

{
  const net: Net = {
    resolve: async () => ["93.184.216.34"],
    fetch: (async (url: string) =>
      String(url).endsWith(".pdf")
        ? new Response(Buffer.from("%PDF-1.7 invoice"), { status: 200, headers: { "content-type": "application/pdf" } })
        : new Response(`<html><body><a href="https://acme.test/files/inv-1.pdf">Download PDF</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
  };
  const doc = await fetchInvoiceDocument("https://acme.test/invoice/1", net);
  check("an invoice page is followed one step to its PDF", doc.via, "a PDF named on the invoice page");
  check("and the PDF is what comes back", doc.bytes.subarray(0, 5).toString(), "%PDF-");
}

/* ---- a link to a sign-in page is a DIFFERENT failure, and says so ---- */
{
  const net: Net = {
    resolve: async () => ["93.184.216.34"],
    fetch: (async () => new Response("<html><head><title>Sign in · Acme</title></head><body></body></html>",
      { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
  };
  const err = await fetchInvoiceDocument("https://acme.test/billing", net).catch((e: Error) => e.message);
  checkThat("a sign-in wall is named as one", String(err).includes("sign-in page"));
}

/* ---- shape 2: a Stripe hosted invoice, all three hops ---- */
const HOSTED = "https://invoice.stripe.com/i/acct_1AB/live_TOKEN";

function stripeNet(over: Partial<{ lines: unknown[]; hasMore: boolean; invoice: Record<string, unknown> }> = {}): Net {
  const lines = over.lines ?? [
    { id: "il_1", amount: 29900, price: { recurring: { interval: "month" } } },
  ];
  return {
    resolve: async () => ["93.184.216.34"],
    fetch: (async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      const auth = (init.headers as Record<string, string>)?.Authorization;
      const version = (init.headers as Record<string, string>)?.["Stripe-Version"];
      if (u.startsWith("https://invoicedata.stripe.com/hosted_invoice_page")) {
        return Response.json({ invoice_id: "in_123", ephemeral_key: { secret: "ek_test_1" } });
      }
      if (u.startsWith("https://api.stripe.com/v1/invoices/in_123/hosted")) {
        // THE TRAP: an ephemeral key is refused outright unless a version is named.
        if (!version) return Response.json({ error: { message: "Stripe-Version required" } }, { status: 400 });
        if (auth !== "Bearer ek_test_1") return Response.json({ error: { message: "bad key" } }, { status: 401 });
        return Response.json({
          number: "CJDLTZUT-0001", paid: true, total: 29900, amount_paid: 29900, currency: "usd",
          invoice_pdf: "https://files.stripe.com/inv_123.pdf",
          status_transitions: { paid_at: Math.floor(Date.parse("2026-07-30T12:00:00Z") / 1000) },
          rendering: { merchant_name: "Zapmail" },
          lines: { data: lines, has_more: !!over.hasMore },
          ...(over.invoice || {}),
        });
      }
      if (u.startsWith("https://api.stripe.com/v1/invoices/in_123/lines")) {
        return Response.json({ data: [{ id: "il_2", amount: 1299 }], has_more: false });
      }
      if (u === "https://files.stripe.com/inv_123.pdf") {
        return new Response(Buffer.from("%PDF-1.4 stripe"), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
  };
}

{
  const doc = await fetchInvoiceDocument(HOSTED, stripeNet());
  check("a Stripe hosted invoice yields the PDF", doc.via, "Stripe hosted invoice");
  check("the file is named after the invoice", doc.fileName, "CJDLTZUT-0001.pdf");
  check("the invoice number is read off the invoice", doc.stripe?.invoiceNumber, "CJDLTZUT-0001");
  check("the amount comes from Stripe, not the email", doc.stripe?.amountUsd, 299);
  check("so does the date it was paid", doc.stripe?.paidOn, "2026-07-30");
  check("a subscription line reads as recurring", doc.stripe?.cadence, "recurring");
}

/* PREPAID CREDIT IS NOT A DISCOUNT: the cost is the invoice, the card line is smaller.
   Read as a discount, $50 of real cost disappears; counted as an extra charge on top,
   the same dollar is counted twice. */
{
  const doc = await fetchInvoiceDocument(HOSTED, stripeNet({
    lines: [{ id: "il_1", amount: 44166 }],
    invoice: { total: 44166, amount_paid: 39166, number: "CJDLTZUT-0002" },
  }));
  check("the cost is the invoice total", doc.stripe?.amountUsd, 441.66);
  check("the card figure is kept beside it", doc.stripe?.amountPaidUsd, 391.66);
  check("and the gap is named as credit", doc.stripe?.creditAppliedUsd, 50);
  check("a non-subscription line reads as one-off", doc.stripe?.cadence, "one_time");
}

/* STRIPE PAGINATES LINE ITEMS AT 10. Summing the first page alone files the rest as
   subscription money, silently. */
{
  const doc = await fetchInvoiceDocument(HOSTED, stripeNet({
    lines: [{ id: "il_1", amount: 1299 }], hasMore: true,
    invoice: { total: 2598, amount_paid: 2598 },
  }));
  check("the rest of the line items are asked for", doc.stripe?.oneTimeUsd, 25.98);
  check("and nothing is left in the wrong column", doc.stripe?.recurringUsd, 0);
}

/* Lines that do not reconcile and DISAGREE about kind: the figures are withheld rather
   than published wrong, and only "mixed" is reported. */
{
  const doc = await fetchInvoiceDocument(HOSTED, stripeNet({
    lines: [{ id: "il_1", amount: 1000, price: { recurring: { interval: "month" } } }, { id: "il_2", amount: 500 }],
    invoice: { total: 90000, amount_paid: 90000 },
  }));
  check("an unreconciled mixed invoice withholds the split", doc.stripe?.recurringUsd, null);
  check("and says so in one word", doc.stripe?.cadence, "mixed");
}

/* A revoked link is a plain, explainable failure. */
{
  const net: Net = {
    resolve: async () => ["93.184.216.34"],
    fetch: (async () => Response.json({})) as unknown as typeof fetch,
  };
  const err = await fetchInvoiceDocument(HOSTED, net).catch((e: Error) => e.message);
  checkThat("a revoked hosted link says so", String(err).includes("may have been revoked"));
}

/* ============================ 4. the whole message ============================ */

{
  const r = await pullEmailDocument({ html: STRIPE_EMAIL }, stripeNet());
  check("the message yields the vendor's invoice", r.document?.stripe?.invoiceNumber, "CJDLTZUT-0001");
  check("and only the winning link was followed", r.attempts.length, 1);
}

{
  const r = await pullEmailDocument({ html: "<p>Your card was charged $12. Thanks!</p>" });
  check("a message that links to nothing is not a fault", r.reason, "the message links to no invoice or receipt");
  check("and nothing was attempted", r.attempts.length, 0);
}

{
  /* A link that IS there and fails is a fault worth showing: this vendor should be
     producing a document and is not. */
  const net: Net = {
    resolve: async () => ["93.184.216.34"],
    fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
  };
  const r = await pullEmailDocument({ html: `<a href="https://acme.test/i/1">Download invoice</a>` }, net);
  checkThat("a failed fetch is reported with its reason", String(r.reason).includes("HTTP 500"));
  check("the attempt is on the record", r.attempts[0]?.error, "the link answered HTTP 500");
}

{
  /* The first candidate failing must not stop the second from being tried. */
  const net: Net = {
    resolve: async () => ["93.184.216.34"],
    fetch: (async (url: string) => String(url).includes("good")
      ? new Response(Buffer.from("%PDF-1.4 ok"), { status: 200, headers: { "content-type": "application/pdf" } })
      : new Response("nope", { status: 404 })) as unknown as typeof fetch,
  };
  const r = await pullEmailDocument({
    html: `<a href="https://acme.test/bad/1.pdf">Download invoice</a><a href="https://acme.test/good/2.pdf">Download receipt</a>`,
  }, net);
  check("a failed first candidate falls through to the next", r.document?.via, "the link was the PDF");
  check("both attempts are recorded", r.attempts.length, 2);
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
