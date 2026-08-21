/**
 * RecruitersOS · In-Market · FREE corporate phone resolver
 *
 * WHAT. Given a company (name + verified domain), find that BUSINESS's main published phone
 * number — the switchboard / HQ / main office line — for $0, and attach it to every curated
 * prospect who works there, so the Clients tab ships a dialable company number alongside the
 * decision-maker and their email.
 *
 * WHY IT'S FREE. A company's main line is PUBLISHED by the company itself: schema.org
 * Organization markup, a `tel:` link in the header/footer, or a labelled "Phone:" on the
 * contact page. We read what the business says about itself on its own site. No vendor, no
 * API key, no per-hit cost, nothing to meter. The only budget is politeness: bounded fetches,
 * short timeouts, rotated egress IPs, and a per-DOMAIN cache — a company with 40 curated
 * prospects costs ONE resolve, not 40.
 *
 * ⚠️ THIS IS A SWITCHBOARD, NOT A PERSON'S LINE.
 * It is stored in its OWN field (`companyPhone`) and must never be merged into a prospect's
 * `phone` / `directPhone` / `mobilePhone`. Those feed the auto-dialer and OS Text SMS, and:
 *   - texting a corporate landline is useless AND a 10DLC compliance problem, and
 *   - the paid Voice Drops / direct-dial rung deliberately REFUSES company switchboards
 *     (see lib/signals/apify.ts) — we only ever pay to dial a person's own number.
 * Keeping the two fields apart is what makes this rung safe to run automatically.
 *
 * PRECISION OVER RECALL. A wrong number is worse than no number: a recruiter dials a stranger,
 * or worse, an unrelated business gets called repeatedly. Every candidate must survive:
 *   1. EVIDENCE TIER      schema.org telephone > tel: anchor > labelled text (weakest)
 *   2. SHAPE              valid NANP, or E.164 international with a plausible length
 *   3. JUNK FILTER        555-01xx fictional range, repeated/sequential digits, placeholders,
 *                         digit runs that were really an ID / date / zip+4
 *   4. FAX + LEGAL VETO   a number labelled fax (or sitting in a fax/DMCA context) is never
 *                         the main line
 *   5. SHARED-NUMBER VETO a number already attributed to several unrelated domains is a
 *                         template/vendor artifact (agency boilerplate, CDN demo markup),
 *                         not this company's line
 * Anything that fails every tier resolves to null, and null is a perfectly good answer.
 *
 * All best-effort: any failure returns null and the caller degrades to exactly the prior
 * behaviour (a prospect with no company phone).
 */

import { loadSnapshot, debouncedSaver } from "../db";

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const CACHE_KEY = "inmarket_company_phone_v1";
const POS_TTL_MS = 90 * 24 * 60 * 60 * 1000;  // a company's main line is stable — re-check quarterly
const NEG_TTL_MS = 14 * 24 * 60 * 60 * 1000;  // site READ fine, no number published: retry in two weeks
// UNREACHABLE is not the same answer as "publishes no number". A 403 bot-block, a TLS failure, or a
// timeout tells us nothing about the company — punishing it with the full negative TTL would blackout
// a perfectly good company for two weeks over one bad minute. Retry those in two days.
const UNREACHABLE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAGES = 5;              // per company, ever (then cached 90d): a homepage attempt, its
                                  // www fallback, and up to 3 contact-ish pages
const MAX_BODY = 400_000;         // cap bytes scanned per page
const MAX_CACHE = 60_000;         // bound the persisted blob
const SHARED_DOMAIN_LIMIT = 3;    // a number on >= this many unrelated domains is boilerplate, not theirs
const UA = "RecruitersOS/1.0 (+https://recruiteros.app; company contact lookup)";

/**
 * NANP ONLY, by default.
 *
 * This rung exists to feed a US dialer (Telnyx US lines, 10DLC, Phone Intel's NANP IVR
 * navigation) and the signal pool is itself US-only (the accumulator purges non-US leads). So a
 * non-NANP switchboard is never dialable here — and in practice it is not merely useless, it is
 * a WRONG-COMPANY ALARM. Live proof from the first sweep, every non-US number found was an
 * upstream domain-resolution error, not an international office:
 *   "Notion" -> notionpress.com (+91, an Indian publisher; the role was in New York)
 *   "SNI Financial" -> snitechnology.net (+90 Turkey; the role was in Dallas)
 *   "Cresta" -> com.ar (a bare TLD, not a company domain at all)
 * Handing any of those to Voice Drops means leaving a voicemail at a stranger's front desk, so
 * we refuse them. Set INMARKET_COMPANY_PHONE_INTL=1 if a genuinely international book ever
 * needs them.
 */
const NANP_ONLY = process.env.INMARKET_COMPANY_PHONE_INTL !== "1";

/** Public suffixes that are NOT a company domain. A resolver that hands us a bare TLD
 *  ("com.ar") would otherwise get its registrar/parking page scraped for a "main line". */
const BARE_SUFFIX = new Set([
  "com.ar", "com.au", "com.br", "co.uk", "org.uk", "co.jp", "co.in", "com.mx", "co.za",
  "com.cn", "co.nz", "com.sg", "com.tr", "com.pl", "co.kr", "com.tw", "com.hk",
]);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** How the number was found, weakest last. Surfaced in the UI so a human can judge it. */
export type CompanyPhoneVia =
  | "schema_org"   // structured Organization/LocalBusiness markup — the company declaring its own number
  | "tel_link"     // an explicit <a href="tel:…"> the company put on its site
  | "labeled";     // visible text next to a "Phone:" / "Call us" label

export interface CompanyPhoneResolution {
  /** E.164 where we can be sure ("+14155550123"), else the cleaned published form. */
  phone: string;
  /** Human display form ("(415) 555-0123") — what the Clients tab shows. */
  display: string;
  via: CompanyPhoneVia;
  /** 0-1. Drives whether the UI presents it as confirmed or as a lead to check. */
  confidence: number;
  /** The page we read it from, so any number is auditable back to the company's own site. */
  sourceUrl: string;
}

interface CacheRow {
  ok: boolean;
  phone: string;
  display: string;
  via: string;
  confidence: number;
  sourceUrl: string;
  at: number;
  /** True when we could not read a single page (bot-block / TLS / timeout / DNS). Distinguishes
   *  "we learned nothing" from "we looked and they publish no number", so the two get different
   *  retry windows. Absent on rows written before this field existed — read as false. */
  unreachable?: boolean;
}

/* ------------------------------------------------------------------ */
/* Phone shape + junk filtering                                        */
/* ------------------------------------------------------------------ */

/** Digits that are structurally impossible or reserved, in NANP (US/Canada) terms. */
function validNanp(d: string): boolean {
  if (d.length !== 10) return false;
  const area = d.slice(0, 3), exch = d.slice(3, 6), line = d.slice(6);
  // Area + exchange codes never start with 0 or 1.
  if (/^[01]/.test(area) || /^[01]/.test(exch)) return false;
  // N11 service codes (411, 911) are not company lines.
  if (/^\d11$/.test(area)) return false;
  // 555-0100..555-0199 is the reserved FICTIONAL range (movies, docs, templates).
  if (exch === "555" && /^01\d\d$/.test(line)) return false;
  // Placeholder patterns: all-same digit, or a straight 1234567890 run.
  if (/^(\d)\1{9}$/.test(d)) return false;
  if (d === "1234567890" || d === "0123456789") return false;
  // A "number" whose last 7 digits are identical is template filler (555-1111111 style).
  if (/^(\d)\1{6}$/.test(d.slice(3))) return false;
  return true;
}

/** Pretty NANP display: (415) 555-0123. Non-NANP keeps its E.164 form. */
function displayNanp(d: string): string {
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * Normalize a raw published string into { e164, display } or null.
 * Accepts NANP with or without +1, and international +CC numbers of plausible length.
 * Deliberately strict: anything it can't confidently parse is rejected rather than guessed.
 */
export function normalizeCompanyPhone(raw: string): { phone: string; display: string } | null {
  const t = String(raw || "").trim();
  if (!t) return null;

  // Reject strings carrying an extension marker in a way that hides the real number, and strip
  // a trailing extension so "(415) 555-0123 ext. 200" still yields the main line.
  const noExt = t.replace(/\s*(?:x|ext\.?|extension|poste)\s*\.?\s*\d{1,6}\s*$/i, "");

  const hasPlus = /^\s*\+/.test(noExt);
  const digits = noExt.replace(/\D/g, "");
  if (!digits) return null;

  // NANP, bare 10 digits.
  if (digits.length === 10 && !hasPlus) {
    if (!validNanp(digits)) return null;
    return { phone: "+1" + digits, display: displayNanp(digits) };
  }
  // NANP with the country code.
  if (digits.length === 11 && digits.startsWith("1")) {
    const nat = digits.slice(1);
    if (!validNanp(nat)) return null;
    return { phone: "+1" + nat, display: displayNanp(nat) };
  }
  // International: only when the source actually wrote a "+" — a bare 12-digit run is far more
  // likely an order id / account number than a phone number, and guessing there is how you end
  // up dialing a stranger.
  if (hasPlus && digits.length >= 8 && digits.length <= 15) {
    if (/^(\d)\1+$/.test(digits)) return null;
    return { phone: "+" + digits, display: "+" + digits };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Context vetoes                                                      */
/* ------------------------------------------------------------------ */

/** A number sitting in one of these contexts is not the company's main business line. */
const VETO_CONTEXT =
  /\b(fax|facsimile|tty|tdd|telecopier|dmca|abuse|whois|registrar|emergency|poison|suicide|crisis|hotline for|do not call)\b/i;

/** Labels that mark a number as the MAIN line — a strong positive signal. */
const MAIN_CONTEXT =
  /\b(main|head\s*office|headquarters|hq|corporate|company|general|reception|switchboard|front\s*desk|office|contact us|call us|toll[-\s]?free)\b/i;

/** Labels that introduce a phone number in visible text.
 *  Tolerates the punctuation and the opening paren that normally sit between the label and the
 *  number ("Phone: (415) …", "Tel. 415…", "Call us at 415…") — without that, the single most
 *  common contact-page format on the web would be missed. */
const PHONE_LABEL =
  /(?:phone|telephone|tel|call us(?:\s+at)?|call|main|office|toll[-\s]?free|contact)\s*(?:number)?\s*[:.–—-]*\s*\(?\s*$/i;

/* ------------------------------------------------------------------ */
/* HTML helpers                                                        */
/* ------------------------------------------------------------------ */

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

async function fetchText(url: string): Promise<string | null> {
  try {
    // egressFetch rotates the free source IPs and falls back to the default route, so one bad
    // egress IP can never silently stop this rung.
    const { egressFetch } = await import("../net/egress");
    const res = await egressFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
    });
    if (!res.ok) return null;
    const body = await res.text();
    return body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Extractors — one per evidence tier                                  */
/* ------------------------------------------------------------------ */

interface Candidate {
  phone: string;
  display: string;
  via: CompanyPhoneVia;
  /** Ranking score: evidence tier + label bonuses. Higher wins. */
  score: number;
  sourceUrl: string;
}

/** Walk any nested JSON-LD value for Organization-ish telephone fields. */
function jsonLdPhones(node: unknown, out: string[], depth = 0): void {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const v of node) jsonLdPhones(v, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const tel = obj.telephone ?? obj.phone;
  if (typeof tel === "string" && tel.trim()) out.push(tel);
  else if (Array.isArray(tel)) for (const v of tel) if (typeof v === "string") out.push(v);
  for (const key of Object.keys(obj)) {
    // contactPoint / address / department / subOrganization nest the real number.
    if (key === "telephone" || key === "phone") continue;
    jsonLdPhones(obj[key], out, depth + 1);
  }
}

/**
 * TIER 1 — schema.org. The company explicitly declaring its own number in structured markup.
 * Highest precision by far: it is machine-readable, intended for exactly this, and never a
 * stray number from body copy.
 */
export function extractSchemaOrg(html: string, sourceUrl: string): Candidate[] {
  const out: Candidate[] = [];
  const blocks = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const body = block.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { continue; }
    const raws: string[] = [];
    jsonLdPhones(parsed, raws);
    for (const raw of raws) {
      const norm = normalizeCompanyPhone(raw);
      if (norm) out.push({ ...norm, via: "schema_org", score: 100, sourceUrl });
    }
  }
  // Microdata form: <span itemprop="telephone">…</span>
  const micro = html.match(/itemprop\s*=\s*["']telephone["'][^>]*>([^<]{5,40})</gi) || [];
  for (const m of micro) {
    const text = m.slice(m.indexOf(">") + 1);
    const norm = normalizeCompanyPhone(text);
    if (norm) out.push({ ...norm, via: "schema_org", score: 95, sourceUrl });
  }
  // Meta form: <meta property="business:contact_data:phone_number" content="…">
  const meta = html.match(/<meta[^>]+(?:phone_number|telephone)[^>]+content\s*=\s*["']([^"']+)["']/gi) || [];
  for (const m of meta) {
    const c = /content\s*=\s*["']([^"']+)["']/i.exec(m);
    const norm = c ? normalizeCompanyPhone(c[1]) : null;
    if (norm) out.push({ ...norm, via: "schema_org", score: 92, sourceUrl });
  }
  return out;
}

/**
 * TIER 2 — `tel:` anchors. An explicit, clickable number the company put on its own page.
 * We read ~160 chars around the anchor to catch a "Fax" label or a "Main office" bonus.
 */
export function extractTelLinks(html: string, sourceUrl: string): Candidate[] {
  const out: Candidate[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']tel:([^"']{5,40})["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const norm = normalizeCompanyPhone(decodeURIComponent(m[1]));
    if (!norm) continue;
    // Context window: what surrounds the link, plus the link's own text.
    const start = Math.max(0, m.index - 160);
    const context = stripTags(html.slice(start, m.index + m[0].length + 60));
    if (VETO_CONTEXT.test(context)) continue;
    let score = 70;
    if (MAIN_CONTEXT.test(context)) score += 12;
    out.push({ ...norm, via: "tel_link", score, sourceUrl });
  }
  return out;
}

/**
 * TIER 3 — labelled visible text ("Phone: (415) 555-0123"). Weakest tier, so it REQUIRES a
 * label immediately before the number. A bare number floating in body copy is never accepted:
 * that is where case numbers, prices, and statistics get mistaken for phones.
 */
export function extractLabeledText(html: string, sourceUrl: string): Candidate[] {
  const out: Candidate[] = [];
  const text = stripTags(html);
  // Plausible phone shapes only; the label check below is what makes this safe.
  const re = /(\+?\d[\d().\-–\s]{7,20}\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!PHONE_LABEL.test(before)) continue;
    const around = text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 40);
    if (VETO_CONTEXT.test(around)) continue;
    const norm = normalizeCompanyPhone(m[0]);
    if (!norm) continue;
    let score = 45;
    if (MAIN_CONTEXT.test(around)) score += 10;
    out.push({ ...norm, via: "labeled", score, sourceUrl });
  }
  return out;
}

/** All tiers for one page, best-first. Exported for tests. */
export function extractCompanyPhones(html: string, sourceUrl: string): Candidate[] {
  return [
    ...extractSchemaOrg(html, sourceUrl),
    ...extractTelLinks(html, sourceUrl),
    ...extractLabeledText(html, sourceUrl),
  ];
}

/**
 * Pick the winner: highest evidence score, ties broken by how often the number repeats across
 * the pages we read (a real main line appears in the header AND the footer AND the contact
 * page; a stray number appears once).
 */
export function pickBest(cands: Candidate[]): Candidate | null {
  if (!cands.length) return null;
  const freq = new Map<string, number>();
  for (const c of cands) freq.set(c.phone, (freq.get(c.phone) ?? 0) + 1);
  const best = [...cands].sort(
    (a, b) => b.score - a.score || (freq.get(b.phone) ?? 0) - (freq.get(a.phone) ?? 0),
  )[0];
  return best ?? null;
}

/** Map an evidence score to a 0-1 confidence the UI can render honestly. */
function confidenceFor(via: CompanyPhoneVia, score: number, repeats: number): number {
  const base = via === "schema_org" ? 0.92 : via === "tel_link" ? 0.78 : 0.55;
  const bonus = Math.min(0.06, Math.max(0, repeats - 1) * 0.02) + (score % 10 >= 2 ? 0.02 : 0);
  return Math.round(Math.min(0.97, base + bonus) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Page discovery                                                      */
/* ------------------------------------------------------------------ */

/** Contact-ish paths worth trying, best-first, when the homepage yields nothing strong. */
const CONTACT_PATHS = [
  "/contact", "/contact-us", "/contactus", "/contact/", "/about/contact",
  "/company/contact", "/about-us", "/about", "/support/contact", "/en/contact",
];

/** Same-origin contact links the homepage itself advertises — better than guessing paths. */
export function contactLinksFrom(html: string, domain: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 6) {
    const href = m[1], label = stripTags(m[2]);
    if (!/contact|about\s*us/i.test(href + " " + label)) continue;
    let url: string;
    if (/^https?:\/\//i.test(href)) {
      try {
        const u = new URL(href);
        // Same registrable domain only — never wander onto a partner's site.
        if (!u.hostname.endsWith(domain)) continue;
        url = u.toString();
      } catch { continue; }
    } else if (href.startsWith("/")) {
      url = `https://${domain}${href}`;
    } else continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cache + shared-number index                                         */
/* ------------------------------------------------------------------ */

let mem: Map<string, CacheRow> | null = null;
let loading: Promise<void> | null = null;

async function ensureCache(): Promise<Map<string, CacheRow>> {
  if (mem) return mem;
  if (!loading) {
    loading = (async () => {
      const raw = (await loadSnapshot<Record<string, CacheRow>>(CACHE_KEY).catch(() => null)) || {};
      mem = new Map(Object.entries(raw));
    })().catch(() => { mem = new Map(); });
  }
  await loading;
  return mem ?? (mem = new Map());
}

const scheduleSave = debouncedSaver(CACHE_KEY, () => {
  let m = mem;
  if (!m) return {};
  if (m.size > MAX_CACHE) {
    m = new Map([...m.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHE));
    mem = m;
  }
  return Object.fromEntries(m);
}, 1500);

/**
 * SHARED-NUMBER VETO. Website templates, marketing agencies, and franchise boilerplate put the
 * SAME number on many unrelated sites. If a number is already the answer for several other
 * domains, it is not this company's line, so we refuse it rather than hand a recruiter a
 * number that dials someone else's front desk.
 */
export function isSharedNumber(cache: Map<string, CacheRow>, phone: string, domain: string): boolean {
  let n = 0;
  for (const [d, row] of cache) {
    if (!row.ok || d === domain) continue;
    if (row.phone === phone && ++n >= SHARED_DOMAIN_LIMIT) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* The resolver                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve a company's main published business phone for free, or null if none can be confirmed.
 * Cached per DOMAIN (positive 90d, negative 14d), so a company is read at most once a quarter
 * no matter how many curated prospects work there.
 *
 * Bounded: at most MAX_PAGES fetches, each timed out, each best-effort. Safe to fan out under
 * the curation concurrency cap.
 */
export async function resolveCompanyPhone(
  domain: string,
  opts?: { force?: boolean },
): Promise<CompanyPhoneResolution | null> {
  const d = (domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!d || !d.includes(".")) return null;
  // A bare public suffix is not a company. Refuse before spending a fetch on it.
  if (BARE_SUFFIX.has(d) || d.split(".").length < 2) return null;

  const cache = await ensureCache();
  const hit = cache.get(d);
  if (hit && !opts?.force) {
    const ttl = hit.ok ? POS_TTL_MS : hit.unreachable ? UNREACHABLE_TTL_MS : NEG_TTL_MS;
    const fresh = Date.now() - hit.at < ttl;
    if (fresh) {
      return hit.ok
        ? { phone: hit.phone, display: hit.display, via: hit.via as CompanyPhoneVia, confidence: hit.confidence, sourceUrl: hit.sourceUrl }
        : null;
    }
  }

  const cands: Candidate[] = [];
  const visited = new Set<string>();
  const pending: string[] = [];   // contact links the homepage advertises (declared before readPage closes over it)

  let pagesRead = 0;   // how many pages we actually got bytes from (0 = the site told us nothing)

  const readPage = async (url: string, isHome = false): Promise<string | null> => {
    if (visited.has(url) || visited.size >= MAX_PAGES) return null;
    visited.add(url);
    const html = await fetchText(url);
    if (!html) return null;
    pagesRead++;
    cands.push(...extractCompanyPhones(html, url));
    // The homepage tells us where its own contact page is — better than guessing paths.
    if (isHome) for (const link of contactLinksFrom(html, d)) pending.push(link);
    return html;
  };

  // HOMEPAGE, apex then www. A large share of established corporate sites serve ONLY on www and
  // fail outright on the apex — without this fallback those companies silently resolve to nothing,
  // which is exactly the profile (older, non-tech, mid-market) this rung exists to cover. The host
  // that answered is then reused for the contact-page paths so we don't re-litigate it per page.
  let host = d;
  if (!(await readPage(`https://${d}/`, true))) {
    host = `www.${d}`;
    await readPage(`https://${host}/`, true);
  }

  // A schema.org hit on the homepage is already the best evidence there is — stop early and
  // keep the crawl to a single request for the common case.
  const strongEnough = () => cands.some((c) => c.via === "schema_org");

  if (!strongEnough()) {
    for (const url of [...pending, ...CONTACT_PATHS.map((p) => `https://${host}${p}`)]) {
      if (visited.size >= MAX_PAGES || strongEnough()) break;
      await readPage(url);
    }
  }

  // Drop anything the shared-number veto or the NANP gate rejects, then pick the winner.
  const usable = cands.filter((c) => !isSharedNumber(cache, c.phone, d) && (!NANP_ONLY || c.phone.startsWith("+1")));
  const best = pickBest(usable);

  let result: CompanyPhoneResolution | null = null;
  if (best) {
    const repeats = usable.filter((c) => c.phone === best.phone).length;
    result = {
      phone: best.phone,
      display: best.display,
      via: best.via,
      confidence: confidenceFor(best.via, best.score, repeats),
      sourceUrl: best.sourceUrl,
    };
  }

  try {
    cache.set(d, result
      ? { ok: true, phone: result.phone, display: result.display, via: result.via, confidence: result.confidence, sourceUrl: result.sourceUrl, at: Date.now() }
      // pagesRead === 0 means every fetch failed, so this is "unreachable", not "no number".
      : { ok: false, phone: "", display: "", via: "", confidence: 0, sourceUrl: "", at: Date.now(), unreachable: pagesRead === 0 });
    scheduleSave();
  } catch { /* best-effort cache */ }

  return result;
}

/**
 * The Voice Drops PAIRING SET: every domain that has a confirmed number this deployment can
 * actually dial (added 2026-08-21). Outreach is coupled — a prospect gets the cold email AND a
 * voice drop — so the pipeline has to be able to answer "how many of the people we are about to
 * mail can we also call", per stage, not just "how many numbers do we hold" in aggregate.
 *
 * Returns lowercased domains so callers can join straight against a prospect's `domain`, and
 * filters through isDialableHere so a non-NANP number never counts as pairable on a US dialer.
 */
export async function dialableDomains(): Promise<Set<string>> {
  const c = await ensureCache();
  const out = new Set<string>();
  for (const [d, row] of c) {
    if (row?.ok && row.phone && isDialableHere(row.phone)) out.add(d.toLowerCase());
  }
  return out;
}

/**
 * Every domain the resolver has ALREADY tried, hit or miss. The complement of this against the
 * curated domains is the free backlog: a domain never tried can still yield a number, while one
 * tried and missed is cached negative for 14 days and is not worth re-queuing.
 */
export async function attemptedDomains(): Promise<Set<string>> {
  const c = await ensureCache();
  const out = new Set<string>();
  for (const d of c.keys()) out.add(d.toLowerCase());
  return out;
}

/** Coverage stats for the Clients tab / health board: how many domains we've tried and hit. */
export async function companyPhoneStats(): Promise<{ attempts: number; resolved: number; rate: number }> {
  const c = await ensureCache();
  let resolved = 0;
  for (const v of c.values()) if (v.ok) resolved++;
  const attempts = c.size;
  return { attempts, resolved, rate: attempts ? Math.round((resolved / attempts) * 100) / 100 : 0 };
}

/**
 * Is this a number THIS deployment can actually dial? Exported so the stores can be swept
 * clean of values written before the gate existed (self-healing beats a one-off script: a
 * rollback or a stale cache entry would otherwise resurrect the bad number).
 */
export function isDialableHere(phone?: string): boolean {
  if (!phone) return false;
  return !NANP_ONLY || phone.startsWith("+1");
}

/** Test seam: reset the in-memory cache between cases. */
export function __resetCompanyPhoneCache(seed?: Record<string, CacheRow>): void {
  mem = new Map(Object.entries(seed || {}));
  loading = Promise.resolve();
}
