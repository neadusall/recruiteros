/**
 * RecruitersOS · Owner · Getting the vendor's PDF out of the email that links to it
 * (OWNER ONLY)
 *
 * The email harvester used to look at ATTACHMENTS and nothing else, so it collected a
 * receipt only from the minority of vendors that attach one. Most do not: they send a
 * short HTML message with a button — "View invoice", "Download receipt", "See your
 * receipt" — and the document itself lives one click away. Those messages were being
 * read for an amount and then filed with a picture of the EMAIL rather than the
 * vendor's invoice, or rejected outright as "no amount could be read".
 *
 * This module is that click. Given a message body it finds the link that leads to the
 * document, follows it, and returns the PDF the vendor would have given a person.
 *
 * ── Why this works without a single password ────────────────────────────────────
 * A receipt link mailed to a customer HAS to open for someone with no account, so the
 * token in the URL is itself the credential. That is what makes this the only
 * collection route that needs no session, survives every password change, cannot be
 * captcha'd, and works for vendors nobody has signed up to a portal with. It is the
 * opposite of the portal pullers, where each vendor is a bespoke recipe that expires.
 *
 * ── The four shapes, in the order they are tried ────────────────────────────────
 *   1. the link IS the PDF (Content-Type says so, or the bytes start %PDF-);
 *   2. a Stripe HOSTED invoice page — three plain GETs to the invoice's own data
 *      endpoint, which hands back a customer-scoped ephemeral key and, with it, the
 *      presigned PDF. Ported from spend-ledger/stripe-hosted.mjs, where it is proved
 *      against live invoices. TRAP kept: an ephemeral key is refused with 400 unless
 *      Stripe-Version names an explicit version;
 *   3. an HTML invoice page that names a PDF (an <a href="...pdf">, or an embedded
 *      invoice_pdf/pdfUrl in the page's own JSON), fetched one step further in;
 *   4. nothing — reported with the reason, never thrown, because a vendor whose email
 *      genuinely carries no document must read differently from one that broke.
 *
 * ── Email bodies are untrusted input, so the fetching is fenced ─────────────────
 * Anyone can send this mailbox a message, and the harvester will follow links out of
 * it. So: http(s) only; the address is re-checked at EVERY redirect hop against
 * loopback, private and link-local ranges (this server can reach the platform's own
 * internal services and its cloud metadata endpoint, and neither may be reachable by
 * mailing a link); no cookie, no Authorization and no platform header is ever sent; a
 * hard size cap; a hard timeout; and a small fixed number of candidates per message so
 * a link farm cannot turn one email into a crawl.
 */

import { Buffer } from "buffer";
import { lookup as dnsLookup } from "dns/promises";
import { isIP } from "net";

/* ============================ what comes back ============================ */

export interface LinkCandidate {
  url: string;
  /** The words the reader would have clicked on. */
  text: string;
  /** Higher is more likely to be the document. Candidates below FLOOR are dropped. */
  score: number;
  /** Why it scored, in words, so a failed pull can be explained. */
  why: string;
}

export interface StripeFacts {
  invoiceNumber?: string;
  amountUsd?: number;
  amountPaidUsd?: number;
  creditAppliedUsd?: number;
  currency?: string;
  paidOn?: string;
  merchant?: string;
  cadence?: "recurring" | "one_time" | "mixed";
  recurringUsd?: number | null;
  oneTimeUsd?: number | null;
}

export interface FetchedDocument {
  bytes: Buffer;
  mime: string;
  fileName: string;
  /** The link that was followed, after redirects. */
  url: string;
  /** Which of the four shapes it turned out to be, for the console. */
  via: string;
  /** Everything Stripe stated about the invoice, when it was one. */
  stripe?: StripeFacts;
}

export interface PullResult {
  document?: FetchedDocument;
  /** Every link tried and what happened, so a vendor that never works can be fixed. */
  attempts: Array<{ url: string; via?: string; error?: string }>;
  /** Set when no document was found: what stopped it, in the owner's words. */
  reason?: string;
  /** Links that looked plausible but were never tried (over the per-message cap). */
  skipped: number;
}

/** Injected in tests; nothing here needs the real network to be proved. */
export interface Net {
  fetch: typeof globalThis.fetch;
  /** Resolve a hostname to addresses. Stubbed in tests, real DNS in production. */
  resolve?: (host: string) => Promise<string[]>;
}

/* ============================ limits ============================ */

const MAX_CANDIDATES = 4;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const TIMEOUT_MS = 25_000;
const SCORE_FLOOR = 2;
const UA = "Mozilla/5.0 (RecruitersOS receipt harvester)";
const STRIPE_VERSION = "2020-03-02";

/* ============================ finding the link ============================ */

/**
 * Links that are certainly not the document. Following an unsubscribe link is worse
 * than useless: some vendors action it on GET, so the harvester would quietly
 * unsubscribe the billing mailbox from the receipts it exists to collect.
 */
const DENY = [
  /unsubscribe/i, /opt[-_]?out/i, /email[-_]?preferences/i, /notification[-_]?settings/i,
  /\/(login|signin|sign-in|log-in|register|signup)\b/i,
  /(twitter|x)\.com\//i, /facebook\.com\//i, /linkedin\.com\//i, /instagram\.com\//i, /youtube\.com\//i,
  /\/(privacy|terms|legal|cookie)/i,
  /\.(png|jpe?g|gif|svg|webp|ico|css|js)(\?|$)/i,
  /^mailto:/i, /^tel:/i,
];

/** Hosts that only ever serve a customer their own document. */
const DOC_HOSTS = [
  /^invoice\.stripe\.com$/i,
  /^pay\.stripe\.com$/i,
  /(^|\.)paddle\.com$/i,
  /(^|\.)chargebee\.com$/i,
  /(^|\.)recurly\.com$/i,
  /(^|\.)fastspring\.com$/i,
  /(^|\.)lemonsqueezy\.com$/i,
  /(^|\.)2checkout\.com$/i,
];

/** What the button says when it leads to the document. */
const STRONG_TEXT = /\b(download|get|save)\b[^.]{0,20}\b(invoice|receipt|pdf|bill|statement)\b|\b(invoice|receipt)\s*pdf\b/i;
const GOOD_TEXT = /\b(view|see|open)\b[^.]{0,20}\b(invoice|receipt|bill|statement|payment)\b|\bview\s+in\s+browser\b/i;
const WEAK_TEXT = /\b(invoice|receipt|billing|statement|order\s*(details|summary))\b/i;
const PATH_HINT = /\/(invoice|invoices|receipt|receipts|billing|bill|statement|order)s?\b/i;

/** A URL that is the file itself. `?` allowed because presigned links carry a query. */
function looksLikePdfUrl(u: string): boolean {
  return /\.pdf(\?|#|$)/i.test(u) || /[?&](format|type)=pdf\b/i.test(u);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * The words a reader would see on this link.
 *
 * Vendors very often make the button an IMAGE, so the anchor contains a tag and no text
 * at all. Stripping tags then leaves nothing and the one link that matters scores below
 * the floor, which is how a whole vendor silently stops reporting. The words are still
 * there in `alt` (and sometimes `title`), so they are pulled out before the tags go.
 */
function stripTags(s: string): string {
  const labels: string[] = [];
  const attr = /\b(?:alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = attr.exec(s); m; m = attr.exec(s)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v) labels.push(v);
  }
  const text = decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return [text, ...labels].filter(Boolean).join(" ").trim();
}

/**
 * Rank every link in the message by how likely it is to be the document.
 *
 * The anchor TEXT is weighted as heavily as the URL on purpose: most vendors send
 * their mail through a click-tracker, so the href is an opaque redirect on the
 * tracker's domain and the only readable signal left is the words on the button.
 * Following redirects is what turns that back into a real address.
 */
export function findInvoiceLinks(input: { html?: string; text?: string }): LinkCandidate[] {
  const found = new Map<string, LinkCandidate>();

  const consider = (rawUrl: string, rawText: string) => {
    const url = decodeEntities((rawUrl || "").trim()).replace(/^<|>$/g, "");
    if (!/^https?:\/\//i.test(url)) return;
    if (DENY.some((d) => d.test(url))) return;
    const text = stripTags(rawText || "").slice(0, 120);
    if (text && DENY.some((d) => d.test(text))) return;

    let host = "";
    try { host = new URL(url).host; } catch { return; }

    let score = 0;
    const why: string[] = [];
    if (looksLikePdfUrl(url)) { score += 6; why.push("the link is a PDF"); }
    if (DOC_HOSTS.some((h) => h.test(host))) { score += 4; why.push(`${host} serves invoices`); }
    if (STRONG_TEXT.test(text)) { score += 4; why.push(`the button says "${text}"`); }
    else if (GOOD_TEXT.test(text)) { score += 2; why.push(`the link says "${text}"`); }
    else if (WEAK_TEXT.test(text)) { score += 1; why.push(`the link mentions "${text}"`); }
    if (PATH_HINT.test(url)) { score += 1; why.push("the address names an invoice"); }

    if (score < SCORE_FLOOR) return;
    const prev = found.get(url);
    if (prev && prev.score >= score) return;
    found.set(url, { url, text, score, why: why.join(", ") });
  };

  const html = input.html || "";
  // <a href="..." ...>label</a> — quoted or bare, label may contain tags (a button image).
  const anchor = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  for (let m = anchor.exec(html); m; m = anchor.exec(html)) {
    consider(m[1] ?? m[2] ?? m[3] ?? "", m[4] || "");
  }

  /* A plain-text part carries no labels, so a bare URL is judged on its address alone.
     That is deliberately enough for a direct PDF or a known invoice host and not enough
     for anything else, which is the right bar for a link with nothing said about it. */
  const bare = /https?:\/\/[^\s<>()"']+/gi;
  const textPart = input.text || "";
  for (let m = bare.exec(textPart); m; m = bare.exec(textPart)) {
    consider(m[0].replace(/[.,;:)\]]+$/, ""), "");
  }

  return [...found.values()].sort((a, b) => b.score - a.score || a.url.length - b.url.length);
}

/* ============================ where it is allowed to go ============================ */

/**
 * Addresses a link in an email must never reach. This box can talk to the platform's
 * own containers, the Docker bridge and the cloud metadata service, so following a
 * mailed link to 127.0.0.1 or 169.254.169.254 would turn the receipt harvester into
 * a way for anyone who can send mail here to read the inside of the network.
 */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 169 && p[1] === 254) return false;      // link-local + cloud metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; // carrier-grade NAT
    if (p[0] >= 224) return false;                        // multicast + reserved
    return true;
  }
  if (v === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::1" || a === "::") return false;
    if (/^f[cd]/.test(a)) return false;                   // unique-local
    if (/^fe[89ab]/.test(a)) return false;                // link-local
    if (/^::ffff:/.test(a)) return isPublicAddress(a.replace(/^::ffff:/, ""));
    return true;
  }
  return false;
}

async function assertReachable(url: string, net: Net): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`${u.protocol} is not a link this can follow`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(host) || /\.localhost$/i.test(host) || /\.internal$/i.test(host)) {
    throw new Error(`${host} is inside this network, so it is not followed`);
  }
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else if (net.resolve) addrs = await net.resolve(host);
  else addrs = (await dnsLookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length) throw new Error(`${host} does not resolve`);
  for (const a of addrs) {
    if (!isPublicAddress(a)) throw new Error(`${host} resolves inside this network (${a}), so it is not followed`);
  }
}

/**
 * One fetch, with every redirect hop re-checked. `redirect: "manual"` rather than
 * "follow" precisely so a public hostname cannot bounce to a private address after the
 * guard has already passed.
 */
async function guardedFetch(url: string, net: Net, accept: string): Promise<{ res: Response; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertReachable(current, net);
    const res = await net.fetch(current, {
      redirect: "manual",
      // Nothing of ours travels with this: no cookie, no Authorization, no platform header.
      headers: { "user-agent": UA, accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { res, finalUrl: current };
      current = new URL(next, current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error("too many redirects");
}

/** Read a body with a hard ceiling, so a huge or endless response cannot exhaust the box. */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > cap) throw new Error(`the document is ${Math.round(declared / 1e6)}MB, over the limit`);
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => {}); throw new Error("the document is over the size limit"); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/* ============================ reading the document ============================ */

function isPdf(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function fileNameFor(res: Response, url: string, ext: string): string {
  const cd = res.headers.get("content-disposition") || "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  const fromHeader = star?.[1] || plain?.[1];
  if (fromHeader) return decodeURIComponent(fromHeader.trim()).slice(0, 120);
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last.slice(0, 120);
    if (last) return `${last}.${ext}`.slice(0, 120);
  } catch { /* fall through */ }
  return `invoice.${ext}`;
}

/* ---- shape 2: a Stripe hosted invoice ---- */

export function isStripeHostedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.host === "invoice.stripe.com" && /^\/i\/[^/]+\/[^/]+/.test(u.pathname);
  } catch { return false; }
}

async function stripeJson(url: string, net: Net, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await net.fetch(url, {
    headers: { "user-agent": UA, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(body); } catch { /* an HTML error page */ }
  if (!res.ok) {
    const said = ((json as { error?: { message?: string } })?.error?.message) || body.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${said}`);
  }
  if (!json) throw new Error(`${new URL(url).host} answered something that was not JSON`);
  return json;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const cents = (n: unknown) => (Number.isFinite(Number(n)) ? Number(n) / 100 : null);

/**
 * The hosted link is the credential, so this needs no Stripe key of ours and works for
 * any vendor that bills through Stripe — which is most of them here.
 *
 * The figures matter as much as the file: a Stripe invoice STATES its number, what was
 * paid, when, and whether each line recurs. Read off the invoice, that beats anything
 * guessed from the wording of an email, and it is what keeps a one-off purchase out of
 * the monthly run rate.
 */
async function pullStripeHosted(hostedUrl: string, net: Net): Promise<FetchedDocument> {
  const u = new URL(hostedUrl);
  const dataUrl = `https://invoicedata.stripe.com/hosted_invoice_page${u.pathname.replace(/^\/i/, "")}?creditNoteRecoverySlug=`;
  const page = await stripeJson(dataUrl, net);
  const invoiceId = page.invoice_id as string | undefined;
  const ek = page.ephemeral_key as { secret?: string } | string | undefined;
  const key = typeof ek === "string" ? ek : ek?.secret;
  if (!invoiceId || !key) throw new Error("the hosted page named no invoice (the link may have been revoked)");

  const inv = await stripeJson(`https://api.stripe.com/v1/invoices/${invoiceId}/hosted`, net, {
    // Without an explicit version an ephemeral key is refused outright, with a 400.
    Authorization: `Bearer ${key}`,
    "Stripe-Version": STRIPE_VERSION,
  }) as Record<string, never> & {
    number?: string; paid?: boolean; total?: number; amount_paid?: number; currency?: string;
    invoice_pdf?: string; discount?: unknown; total_discount_amounts?: unknown[];
    status_transitions?: { paid_at?: number; finalized_at?: number };
    rendering?: { merchant_name?: string };
    lines?: { data?: Array<{ id?: string; amount?: number; price?: { recurring?: unknown }; plan?: { interval?: string } }>; has_more?: boolean };
  };

  /* STRIPE PAGINATES LINE ITEMS AT 10 AND THE SPLIT IS SUMMED FROM THEM. A 34-line
     invoice came back with ten lines, so a one-off total read as a fraction of itself
     and the rest would have been filed as subscription money. Ask for the rest first. */
  let lines = inv.lines?.data || [];
  let more = Boolean(inv.lines?.has_more);
  for (let guard = 0; more && guard < 20; guard++) {
    const after = lines[lines.length - 1]?.id;
    if (!after) break;
    const next = await stripeJson(
      `https://api.stripe.com/v1/invoices/${invoiceId}/lines?limit=100&starting_after=${encodeURIComponent(after)}`,
      net, { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION },
    ).catch(() => null) as { data?: typeof lines; has_more?: boolean } | null;
    if (!next?.data?.length) break;
    lines = lines.concat(next.data);
    more = Boolean(next.has_more);
  }

  const invoiceTotal = round2(cents(inv.total) ?? 0);
  const paidUsd = round2(cents(inv.amount_paid) ?? invoiceTotal);
  /* PREPAID CREDIT IS MONEY ALREADY PAID, NOT A DISCOUNT. Where the card was charged
     less than the invoice and Stripe names no discount, the gap was credit that was
     itself bought for cash: the COST is the honest figure for a spend register, and the
     card figure is kept beside it for anyone reconciling a bank statement. */
  const discounted = Boolean(inv.discount) || (inv.total_discount_amounts || []).length > 0;
  const creditAppliedUsd = !discounted && invoiceTotal > paidUsd ? round2(invoiceTotal - paidUsd) : 0;
  const total = creditAppliedUsd > 0 ? invoiceTotal : paidUsd;

  const isRec = (l: { price?: { recurring?: unknown }; plan?: { interval?: string } }) => Boolean(l.price?.recurring || l.plan?.interval);
  let recurringUsd: number | null = round2(lines.filter(isRec).reduce((t, l) => t + (cents(l.amount) || 0), 0));
  let oneTimeUsd: number | null = round2(lines.filter((l) => !isRec(l)).reduce((t, l) => t + (cents(l.amount) || 0), 0));
  /* Lines that do not add up to the invoice are not the split (a discount, a credit or
     tax moves the total without ever being a line). When every line agrees on one kind
     that kind is applied to the whole; when they disagree the figures are withheld,
     because publishing a split that does not reconcile puts money in the wrong column
     silently. A sample can say what something IS, never how much. */
  const reconciles = lines.length > 0 && Math.abs(round2((recurringUsd || 0) + (oneTimeUsd || 0)) - total) < 0.01;
  if (!reconciles) {
    const anyRec = lines.some(isRec);
    const anyOne = lines.some((l) => !isRec(l));
    if (anyRec && !anyOne) { recurringUsd = total; oneTimeUsd = 0; }
    else if (anyOne && !anyRec) { oneTimeUsd = total; recurringUsd = 0; }
    else { recurringUsd = null; oneTimeUsd = null; }
  }
  const cadence: StripeFacts["cadence"] =
    recurringUsd === null || oneTimeUsd === null ? "mixed"
      : recurringUsd > 0 && oneTimeUsd > 0 ? "mixed"
        : oneTimeUsd > 0 ? "one_time" : "recurring";

  const paidAt = inv.status_transitions?.paid_at || inv.status_transitions?.finalized_at;
  const facts: StripeFacts = {
    invoiceNumber: inv.number || undefined,
    amountUsd: total,
    amountPaidUsd: paidUsd,
    creditAppliedUsd: creditAppliedUsd || undefined,
    currency: (inv.currency || "usd").toUpperCase(),
    paidOn: paidAt ? new Date(paidAt * 1000).toISOString().slice(0, 10) : undefined,
    merchant: inv.rendering?.merchant_name || undefined,
    cadence, recurringUsd, oneTimeUsd,
  };

  if (!inv.invoice_pdf) throw new Error("Stripe stated the invoice but published no PDF for it");
  await assertReachable(inv.invoice_pdf, net);
  const res = await net.fetch(inv.invoice_pdf, {
    headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS + 15_000),
  });
  if (!res.ok) throw new Error(`the invoice PDF answered HTTP ${res.status}`);
  const bytes = await readCapped(res, MAX_BYTES);
  if (!isPdf(bytes)) throw new Error("the invoice PDF link returned something that is not a PDF");

  return {
    bytes, mime: "application/pdf",
    fileName: facts.invoiceNumber ? `${facts.invoiceNumber}.pdf` : fileNameFor(res, inv.invoice_pdf, "pdf"),
    url: hostedUrl, via: "Stripe hosted invoice", stripe: facts,
  };
}

/* ---- shape 3: an HTML page that names a PDF ---- */

/** A PDF named anywhere in a rendered page or in the JSON the page was built from. */
export function pdfLinksInHtml(html: string, base: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    try {
      const abs = new URL(decodeEntities(raw.replace(/\\\//g, "/").trim()), base).toString();
      if (/^https?:/i.test(abs) && !out.includes(abs)) out.push(abs);
    } catch { /* not a URL */ }
  };
  const href = /(?:href|src)\s*=\s*(?:"([^"]*\.pdf[^"]*)"|'([^']*\.pdf[^']*)')/gi;
  for (let m = href.exec(html); m; m = href.exec(html)) push(m[1] ?? m[2] ?? "");
  // Server-rendered React/Vue pages carry the real link in their bootstrap JSON.
  const json = /"(?:invoice_pdf|pdfUrl|pdf_url|downloadUrl|download_url|invoicePdf)"\s*:\s*"([^"]+)"/gi;
  for (let m = json.exec(html); m; m = json.exec(html)) push(m[1]);
  return out.slice(0, 5);
}

/* ============================ the one call the harvester makes ============================ */

/** Follow one candidate as far as a document, or say why it did not lead to one. */
export async function fetchInvoiceDocument(url: string, net: Net = { fetch: globalThis.fetch }): Promise<FetchedDocument> {
  if (isStripeHostedUrl(url)) return pullStripeHosted(url, net);

  const { res, finalUrl } = await guardedFetch(url, net, "application/pdf,text/html;q=0.9,*/*;q=0.5");
  if (!res.ok) throw new Error(`the link answered HTTP ${res.status}`);

  /* A tracker or a short link can land on a hosted invoice only after redirects, so the
     shape is decided by where it ENDED UP, not by what was printed in the email. */
  if (isStripeHostedUrl(finalUrl)) return pullStripeHosted(finalUrl, net);

  const type = (res.headers.get("content-type") || "").toLowerCase();
  const isHtml = type.includes("html");
  const bytes = await readCapped(res, isHtml ? MAX_HTML_BYTES : MAX_BYTES);

  if (isPdf(bytes)) {
    return { bytes, mime: "application/pdf", fileName: fileNameFor(res, finalUrl, "pdf"), url: finalUrl, via: "the link was the PDF" };
  }
  const img = imageMime(bytes);
  if (img && bytes.length > 8_000) {
    return { bytes, mime: img, fileName: fileNameFor(res, finalUrl, img.split("/")[1]), url: finalUrl, via: "the link was the receipt image" };
  }

  const html = bytes.toString("utf8");
  /* A link that leads to a sign-in page is a different failure from a broken one, and
     the owner can only act on it if it is named: it means this vendor does not put the
     document in the mail at all, so it needs the portal route instead. */
  if (/<title[^>]*>[^<]*(sign in|log in|login|unauthori[sz]ed|access denied)/i.test(html)) {
    throw new Error("the link leads to a sign-in page, so the document is not in the email");
  }

  const nested = pdfLinksInHtml(html, finalUrl);
  for (const link of nested) {
    try {
      await assertReachable(link, net);
      const r2 = await guardedFetch(link, net, "application/pdf,*/*;q=0.5");
      if (!r2.res.ok) continue;
      const b2 = await readCapped(r2.res, MAX_BYTES);
      if (!isPdf(b2)) continue;
      return { bytes: b2, mime: "application/pdf", fileName: fileNameFor(r2.res, r2.finalUrl, "pdf"), url: r2.finalUrl, via: "a PDF named on the invoice page" };
    } catch { /* try the next one */ }
  }
  throw new Error(isHtml ? "the page it opens names no PDF" : `the link returned ${type || "an unknown type"}, not a document`);
}

/**
 * Everything above, applied to one email: rank its links, follow the best few, stop at
 * the first real document.
 *
 * It never throws. A message with no document is an ordinary, expected outcome — plenty
 * of vendors state the charge in the body and publish nothing — and it has to be told
 * apart from a message whose document could not be fetched, which is a fault worth
 * showing the owner. Both come back as words in `reason`.
 */
export async function pullEmailDocument(
  input: { html?: string; text?: string },
  net: Net = { fetch: globalThis.fetch },
): Promise<PullResult> {
  const candidates = findInvoiceLinks(input);
  const result: PullResult = { attempts: [], skipped: Math.max(0, candidates.length - MAX_CANDIDATES) };
  if (!candidates.length) {
    result.reason = "the message links to no invoice or receipt";
    return result;
  }
  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      const doc = await fetchInvoiceDocument(c.url, net);
      result.attempts.push({ url: c.url, via: doc.via });
      result.document = doc;
      return result;
    } catch (e) {
      result.attempts.push({ url: c.url, error: (e as Error)?.message?.slice(0, 200) || "failed" });
    }
  }
  result.reason = `followed ${result.attempts.length} link${result.attempts.length === 1 ? "" : "s"} and none led to a document: ${result.attempts.map((a) => a.error).filter(Boolean)[0] || "unknown"}`;
  return result;
}
