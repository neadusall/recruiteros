/**
 * Regression suite for the FREE corporate phone resolver.
 *
 * The rule this suite defends: PRECISION OVER RECALL. A wrong company number means a recruiter
 * dials a stranger, so every case below is either "this must be found" or — more importantly —
 * "this must NEVER be accepted".
 *
 * Run: node --test --import tsx integration/lib/inmarket/companyPhone.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCompanyPhone,
  extractSchemaOrg,
  extractTelLinks,
  extractLabeledText,
  extractCompanyPhones,
  pickBest,
  contactLinksFrom,
  isSharedNumber,
} from "./companyPhone";

const SRC = "https://acme.com/contact";

/* ------------------------------------------------------------------ */
/* Normalization + junk filtering                                      */
/* ------------------------------------------------------------------ */

test("normalizes NANP in every published shape to one E.164 value", () => {
  const want = "+14159260123";
  for (const raw of [
    "(415) 926-0123",
    "415-926-0123",
    "415.926.0123",
    "4159260123",
    "+1 (415) 926-0123",
    "1-415-926-0123",
    "  415 926 0123  ",
  ]) {
    const got = normalizeCompanyPhone(raw);
    assert.ok(got, `should parse ${raw}`);
    assert.equal(got.phone, want, `${raw} -> ${want}`);
  }
});

test("renders a readable display form", () => {
  assert.equal(normalizeCompanyPhone("4159260123")?.display, "(415) 926-0123");
});

test("strips a trailing extension but keeps the main line", () => {
  assert.equal(normalizeCompanyPhone("(415) 926-0123 ext. 200")?.phone, "+14159260123");
  assert.equal(normalizeCompanyPhone("415-926-0123 x99")?.phone, "+14159260123");
});

test("REJECTS the reserved 555-01xx fictional range", () => {
  // The range every template, movie, and lorem-ipsum contact page uses.
  assert.equal(normalizeCompanyPhone("(415) 555-0100"), null);
  assert.equal(normalizeCompanyPhone("212-555-0199"), null);
});

test("REJECTS structurally impossible NANP numbers", () => {
  assert.equal(normalizeCompanyPhone("(015) 926-0123"), null, "area code starting 0");
  assert.equal(normalizeCompanyPhone("(115) 926-0123"), null, "area code starting 1");
  assert.equal(normalizeCompanyPhone("(415) 055-0123"), null, "exchange starting 0");
  assert.equal(normalizeCompanyPhone("(911) 926-0123"), null, "N11 service code");
});

test("REJECTS placeholder and filler digit runs", () => {
  assert.equal(normalizeCompanyPhone("1234567890"), null);
  assert.equal(normalizeCompanyPhone("(999) 999-9999"), null);
  assert.equal(normalizeCompanyPhone("415-111-1111"), null, "repeated last seven");
});

test("REJECTS bare long digit runs that are really IDs, dates, or zip+4", () => {
  assert.equal(normalizeCompanyPhone("941065678901"), null, "12 bare digits, no +");
  assert.equal(normalizeCompanyPhone("94105-6789"), null, "zip+4 is 9 digits");
  assert.equal(normalizeCompanyPhone("20242025"), null, "a year range");
});

test("accepts international ONLY when the source wrote a +", () => {
  assert.equal(normalizeCompanyPhone("+44 20 7946 0958")?.phone, "+442079460958");
  // Same digits with no plus is an unknown 12-digit run, not a phone number.
  assert.equal(normalizeCompanyPhone("442079460958"), null);
});

/* ------------------------------------------------------------------ */
/* Tier 1 — schema.org                                                 */
/* ------------------------------------------------------------------ */

test("extracts the telephone a company declares in JSON-LD", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Acme","telephone":"+1 415-926-0123"}
  </script></head><body>hi</body></html>`;
  const got = extractSchemaOrg(html, SRC);
  assert.equal(got.length, 1);
  assert.equal(got[0].phone, "+14159260123");
  assert.equal(got[0].via, "schema_org");
});

test("finds a telephone nested inside contactPoint", () => {
  const html = `<script type="application/ld+json">
    {"@type":"Organization","name":"Acme",
     "contactPoint":[{"@type":"ContactPoint","contactType":"sales","telephone":"415-926-0177"}]}
  </script>`;
  assert.equal(extractSchemaOrg(html, SRC)[0]?.phone, "+14159260177");
});

test("survives malformed JSON-LD without throwing", () => {
  const html = `<script type="application/ld+json">{ not json at all }</script>`;
  assert.deepEqual(extractSchemaOrg(html, SRC), []);
});

test("reads microdata and meta telephone forms", () => {
  const micro = `<span itemprop="telephone">(415) 926-0123</span>`;
  assert.equal(extractSchemaOrg(micro, SRC)[0]?.phone, "+14159260123");
  const meta = `<meta property="business:contact_data:phone_number" content="415-926-0123">`;
  assert.equal(extractSchemaOrg(meta, SRC)[0]?.phone, "+14159260123");
});

/* ------------------------------------------------------------------ */
/* Tier 2 — tel: anchors                                               */
/* ------------------------------------------------------------------ */

test("extracts a tel: anchor", () => {
  const html = `<a href="tel:+14159260123">Call us</a>`;
  const got = extractTelLinks(html, SRC);
  assert.equal(got[0]?.phone, "+14159260123");
  assert.equal(got[0]?.via, "tel_link");
});

test("VETOES a tel: anchor labelled as a fax line", () => {
  const html = `<div>Fax: <a href="tel:+14159260123">415-926-0123</a></div>`;
  assert.deepEqual(extractTelLinks(html, SRC), [], "a fax is never the main line");
});

test("VETOES numbers in abuse/DMCA/emergency context", () => {
  const html = `<p>DMCA agent <a href="tel:+14159260123">415-926-0123</a></p>`;
  assert.deepEqual(extractTelLinks(html, SRC), []);
});

test("scores a main-office labelled number above a bare one", () => {
  const main = extractTelLinks(`<p>Main office: <a href="tel:+14159260123">x</a></p>`, SRC)[0];
  const bare = extractTelLinks(`<p><a href="tel:+14159260188">x</a></p>`, SRC)[0];
  assert.ok(main.score > bare.score, "main-office label should outrank an unlabelled link");
});

/* ------------------------------------------------------------------ */
/* Tier 3 — labelled text (the weakest, most dangerous tier)           */
/* ------------------------------------------------------------------ */

test("extracts a labelled phone from visible text", () => {
  const html = `<p>Phone: (415) 926-0123</p>`;
  assert.equal(extractLabeledText(html, SRC)[0]?.phone, "+14159260123");
});

test("REFUSES an unlabelled number floating in body copy", () => {
  // This is the whole point of the label requirement: prices, case numbers, and stats
  // otherwise get dialed.
  assert.deepEqual(extractLabeledText(`<p>We processed 415 926 0123 records last year.</p>`, SRC), []);
  assert.deepEqual(extractLabeledText(`<p>Invoice 4159260123 is overdue.</p>`, SRC), []);
});

test("REFUSES a labelled number that sits in a fax context", () => {
  assert.deepEqual(extractLabeledText(`<p>Fax number: (415) 926-0123</p>`, SRC), []);
});

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

test("schema.org beats tel: which beats labelled text", () => {
  const html = `
    <script type="application/ld+json">{"@type":"Organization","telephone":"415-926-0111"}</script>
    <a href="tel:+14159260222">call</a>
    <p>Phone: (415) 926-0333</p>`;
  const best = pickBest(extractCompanyPhones(html, SRC));
  assert.equal(best?.phone, "+14159260111");
  assert.equal(best?.via, "schema_org");
});

test("a number repeated in header and footer wins a tie", () => {
  const html = `<a href="tel:+14159260222">call</a><a href="tel:+14159260333">other</a><a href="tel:+14159260222">call</a>`;
  assert.equal(pickBest(extractCompanyPhones(html, SRC))?.phone, "+14159260222");
});

test("no candidates yields null, which is a valid answer", () => {
  assert.equal(pickBest([]), null);
  assert.equal(pickBest(extractCompanyPhones("<p>no numbers here</p>", SRC)), null);
});

/* ------------------------------------------------------------------ */
/* Shared-number veto                                                  */
/* ------------------------------------------------------------------ */

test("VETOES a number already claimed by several unrelated domains", () => {
  const row = (phone: string) => ({ ok: true, phone, display: phone, via: "tel_link", confidence: 0.8, sourceUrl: "", at: Date.now() });
  const cache = new Map([
    ["one.com", row("+14159260123")],
    ["two.com", row("+14159260123")],
    ["three.com", row("+14159260123")],
  ]);
  // Template boilerplate: the same "company line" on four different businesses.
  assert.equal(isSharedNumber(cache, "+14159260123", "four.com"), true);
  // A number only this company uses is fine.
  assert.equal(isSharedNumber(cache, "+14159260999", "four.com"), false);
  // The domain's own cached entry never counts against itself.
  assert.equal(isSharedNumber(cache, "+14159260123", "one.com"), false);
});

/* ------------------------------------------------------------------ */
/* Contact-page discovery                                              */
/* ------------------------------------------------------------------ */

test("follows the company's own contact links, never a third party's", () => {
  const html = `
    <a href="/contact-us">Contact</a>
    <a href="https://acme.com/about-us">About us</a>
    <a href="https://partner-site.com/contact">Partner contact</a>
    <a href="/pricing">Pricing</a>`;
  const links = contactLinksFrom(html, "acme.com");
  assert.ok(links.includes("https://acme.com/contact-us"));
  assert.ok(links.includes("https://acme.com/about-us"));
  assert.ok(!links.some((l) => l.includes("partner-site.com")), "must not wander off-domain");
  assert.ok(!links.some((l) => l.includes("pricing")));
});

/* ------------------------------------------------------------------ */
/* End-to-end shape on a realistic page                                */
/* ------------------------------------------------------------------ */

test("realistic contact page yields the main line, not the fax", () => {
  const html = `
    <html><body>
      <header><a href="tel:+14159260123">(415) 926-0123</a></header>
      <main>
        <h1>Contact Acme</h1>
        <p>Main: (415) 926-0123</p>
        <p>Fax: (415) 926-0900</p>
        <p>Our 2024 revenue grew 415 percent.</p>
      </main>
      <footer><a href="tel:+14159260123">Call us</a></footer>
    </body></html>`;
  const best = pickBest(extractCompanyPhones(html, SRC));
  assert.equal(best?.phone, "+14159260123");
  const all = extractCompanyPhones(html, SRC).map((c) => c.phone);
  assert.ok(!all.includes("+14159260900"), "the fax must never be a candidate");
});
