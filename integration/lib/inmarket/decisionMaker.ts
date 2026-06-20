/**
 * RecruitersOS · In-Market · Free decision-maker research
 *
 * THE GOAL: for a specific open role at a specific company, find the real human who owns the
 * hire — by NAME — using only free, public sources, then build their likely work email. No paid
 * people-graph credits. This is the framework a good researcher runs by hand, encoded so it runs
 * automatically across every hiring signal, every day.
 *
 * THE PLAYBOOK (how the pros do it), ordered by precision — we run them, merge, and let the
 * existing resolver score every candidate against "who manages THIS role":
 *
 *   1. COMPANY SITE  — the company's own leadership / team / about page. Highest precision: it
 *      names the function heads with their exact titles. We parse schema.org JSON-LD `Person`
 *      blocks first (clean, structured), then fall back to "Name — Title" text near the target
 *      titles. This alone resolves most exec/head-of-function owners for SMB/mid-market.
 *   2. NEWS         — appointment/announcement coverage ("X names Jane Smith VP of Engineering").
 *      Google News RSS, free, no key. Best for recent leadership hires — exactly the moments a
 *      new owner is rebuilding their team.
 *   3. GITHUB       — for engineering roles only, the org's public owners/members often surface
 *      the eng leadership. Free API (optional token raises limits).
 *
 * Every found person becomes a `PersonCandidate`; `resolveHiringManager` (../signals/hiring)
 * scores them on title+function+seniority fit and returns the best match with an honest
 * confidence tier. When nothing resolves to a NAME we degrade to title-level — never fabricate.
 *
 * Cost discipline: bounded fetches per company (a few team URLs + one news query), all timed
 * out, so this is safe to fan out across the signal pool under the pipeline's concurrency cap.
 */

import {
  resolveHiringManager,
  hiringManagerTarget,
  type HiringManagerResolution,
  type PeopleGraph,
  type PeopleQuery,
  type PersonCandidate,
} from "../signals/hiring";
import { classifyTitle } from "../signals";
import { companyAnchor } from "../signals/hiring/normalize";
import { guessEmail, emailDomainFrom, splitFullName, type EmailGuess } from "./email";
import { resolveCompanyDomain, type DomainResolution } from "./domain";
import { resolvePersonEmail } from "./deepContact";
import { paidEmailEnabled, findEmailIcypeas } from "./paidEmail";
import { paidNamingEnabled, findDecisionMakerRapid } from "./paidNaming";
import { recordSearch, isAvailable } from "./searchHealth";

/* ------------------------------------------------------------------ */
/* Shared fetch helpers (free, timed-out, polite UA)                   */
/* ------------------------------------------------------------------ */

const FETCH_TIMEOUT_MS = 8_000;
const UA = "RecruitersOS/1.0 (+https://recruiteros.app; hiring-manager research)";

async function fetchText(url: string): Promise<string | null> {
  try {
    // egressFetch rotates across the free IPv6 source IPs AND falls back to the default route if a
    // rotated IP can't connect — so a broken egress IP never silently stops the naming scraper.
    const { egressFetch } = await import("../net/egress");
    const res = await egressFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/json,*/*" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Name + title extraction primitives                                  */
/* ------------------------------------------------------------------ */

/** Title-Case words that are NOT a person's name — nav/marketing/boilerplate + common copy
 *  bigrams ("Industrial Revolution", "Machine Learning", "San Francisco") that otherwise slip
 *  through the 2-token name shape. Any token here disqualifies the candidate. */
const NON_NAME = new Set([
  // nav / boilerplate
  "Privacy", "Policy", "Cookie", "Cookies", "Terms", "Service", "Services", "Team", "About",
  "Our", "The", "Contact", "Careers", "Career", "Home", "Company", "Leadership", "People",
  "Board", "Directors", "Advisors", "Investors", "Press", "Blog", "News", "Login", "Sign",
  "Get", "Started", "Learn", "More", "Read", "View", "All", "Meet", "Join", "Us", "Why",
  "Product", "Products", "Solutions", "Platform", "Pricing", "Resources", "Support", "Help",
  "Open", "Roles", "Jobs", "Apply", "Now", "Copyright", "Rights", "Reserved", "Inc", "LLC",
  // common copy / topic bigrams that masquerade as names
  "Industrial", "Revolution", "Machine", "Learning", "Artificial", "Intelligence", "Source",
  "Generation", "Recurring", "Quarterly", "Annual", "Infrastructure", "Analytics", "Security",
  "Compliance", "Enterprise", "Startup", "Venture", "Capital", "Global", "Digital", "Strategic",
  "Technology", "Software", "Hardware", "Network", "System", "Database", "Application",
  "Framework", "Pipeline", "Workflow", "Dashboard", "Roadmap", "Series", "Round", "Million",
  "Billion", "Real", "Time", "Next", "Cloud", "Native", "Customer", "Success", "Data", "Science",
  "Engineering", "Marketing", "Operations", "Finance", "Design", "Sales", "Growth", "Revenue",
  "San", "Francisco", "New", "York", "Los", "Angeles", "United", "States", "Remote", "Hybrid",
  "Chief", "Officer", "President", "Vice", "Head", "Director", "Manager", "Lead", "Senior",
]);

function looksLikeName(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return false;
  if (parts.some((p) => NON_NAME.has(p.replace(/[.'’-].*$/, "")))) return false;
  // Reject ALL-CAPS acronyms and single-letter tokens.
  if (parts.some((p) => p.length < 2 || p === p.toUpperCase())) return false;
  return true;
}

/** A captured "title" string is only trustworthy if it carries a real seniority/leadership word. */
const TITLE_KEYWORD = /\b(chief|c[tefoma]o|cro|cpo|chro|vp|vice president|head|director|manager|lead|president|founder|partner|principal|officer)\b/i;
function looksLikeTitle(s: string | undefined): boolean {
  return !!s && TITLE_KEYWORD.test(s);
}

/* ------------------------------------------------------------------ */
/* Strategy 1: company leadership / team page                          */
/* ------------------------------------------------------------------ */

/** URL paths most likely to host the leadership/team roster, best-first. */
const TEAM_PATHS = [
  "/leadership", "/team", "/about/team", "/about/leadership", "/company/team", "/our-team",
  "/about-us", "/about", "/company/leadership", "/company", "/people", "/our-people",
  "/who-we-are", "/management", "/staff", "/team-members", "/meet-the-team",
];

/** Pull schema.org `Person` objects ({name, jobTitle}) out of JSON-LD blocks — the cleanest
 *  signal a site can give us. Walks nested arrays/@graph. */
function peopleFromJsonLd(html: string, source: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const json = b.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "").trim();
    let data: unknown;
    try { data = JSON.parse(json); } catch { continue; }
    const stack: unknown[] = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      for (const k of ["@graph", "member", "employee", "founder", "employees"]) {
        if (o[k]) stack.push(o[k]);
      }
      const type = String(o["@type"] ?? "");
      const name = typeof o.name === "string" ? o.name : undefined;
      // Title can live in jobTitle, hasOccupation.name, or a title-bearing description.
      const occ = o.hasOccupation as { name?: string } | undefined;
      const desc = typeof o.description === "string" ? o.description : undefined;
      const jobTitle = typeof o.jobTitle === "string" ? o.jobTitle
        : Array.isArray(o.jobTitle) ? String(o.jobTitle[0] ?? "")
        : occ?.name ? String(occ.name)
        : looksLikeTitle(desc) ? desc
        : undefined;
      if (/Person/i.test(type) && name && looksLikeName(name)) {
        const split = splitFullName(name);
        out.push({
          fullName: name, firstName: split.firstName, lastName: split.lastName,
          title: jobTitle, headline: jobTitle, source,
        });
      }
    }
  }
  return out;
}

/**
 * PRECISION-SAFE HTML team extraction — the recall complement to JSON-LD. Most team/leadership
 * pages list people in plain markup, not schema.org, so JSON-LD alone misses the majority. This
 * recovers them WITHOUT the old free-text noise by demanding tight structure:
 *   - microdata pairs: itemprop="name" … itemprop="jobTitle" (clean, authoritative), and
 *   - card adjacency: a NAME-shaped text node immediately followed (within a couple of nodes) by a
 *     short string carrying a real LEADERSHIP/seniority keyword (the team-card "Name / VP Eng" shape).
 * Both reuse the same looksLikeName/looksLikeTitle guards, so product-name bigrams ("Vector Search
 * — CTO") and nav boilerplate are rejected. A title keyword is REQUIRED, so an untitled string can
 * never pose as a leader. Precision-first: pair only when the name AND a real title sit together.
 */
function peopleFromHtml(html: string, source: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const seen = new Set<string>();
  const push = (name: string, title: string) => {
    if (!looksLikeName(name) || !looksLikeTitle(title)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const split = splitFullName(name);
    out.push({ fullName: name, firstName: split.firstName, lastName: split.lastName, title: title.slice(0, 60), headline: title.slice(0, 60), source });
  };

  // 1) Microdata: name then jobTitle within a small window.
  const micro = /itemprop=["']name["'][^>]*>\s*([^<]{3,50})\s*<[\s\S]{0,240}?itemprop=["']jobTitle["'][^>]*>\s*([^<]{3,60})\s*</gi;
  let mm: RegExpExecArray | null;
  while ((mm = micro.exec(html)) && out.length < 40) push(clean(mm[1]), clean(mm[2]));

  // 2) Card adjacency: consecutive visible text nodes where a name is followed by a title.
  const segs: string[] = [];
  const stripped = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ");
  const textRe = />\s*([^<>{}]{2,60})\s*</g;
  let tm: RegExpExecArray | null;
  while ((tm = textRe.exec(stripped)) && segs.length < 4000) {
    const t = clean(tm[1]);
    if (t) segs.push(t);
  }
  for (let i = 0; i < segs.length && out.length < 40; i++) {
    if (!looksLikeName(segs[i])) continue;
    for (let j = i + 1; j <= i + 2 && j < segs.length; j++) {
      if (looksLikeTitle(segs[j])) { push(segs[i], segs[j]); break; }
    }
  }
  return out;
}

function clean(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

async function companySiteCandidates(domain: string): Promise<PersonCandidate[]> {
  const base = `https://${domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  const found: PersonCandidate[] = [];
  const seen = new Set<string>();
  let pagesWithPeople = 0;
  for (const path of TEAM_PATHS) {
    if (pagesWithPeople >= 2) break;               // enough signal; stop probing
    const html = await fetchText(base + path);
    if (!html) continue;
    // Structured JSON-LD `Person` blocks first (cleanest), then precision-safe HTML extraction so
    // the common plain-markup team pages aren't missed. Both demand a real title, so a wrong name
    // can't pose as the head — and the email step prefers the company's OWN published addresses.
    const people = [...peopleFromJsonLd(html, "company_site"), ...peopleFromHtml(html, "company_site")]
      .filter((p) => looksLikeTitle(p.title));
    let any = false;
    for (const p of people) {
      const k = p.fullName.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); found.push(p); any = true;
    }
    if (any) pagesWithPeople++;
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Strategy 2: news appointment coverage (Google News RSS)             */
/* ------------------------------------------------------------------ */

/** Verbs that introduce an appointment, with the captured name + (optional) title. */
const APPOINT_RES: RegExp[] = [
  // "Acme names/appoints/hires Jane Smith as VP of Engineering"
  /\b(?:names?|appoints?|hires?|welcomes?|taps?)\s+([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2})\s+as\s+([^,.|]{3,40})/,
  // "Jane Smith joins Acme as VP of Engineering" / "Jane Smith named VP of Engineering"
  /\b([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2})\s+(?:joins|named|appointed|promoted to|takes over as|becomes)\s+(?:[A-Z][\w&]+\s+)?(?:as\s+)?([^,.|]{3,40})/,
];

/** The company's most distinctive name word (for whole-word headline matching). */
function distinctiveToken(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0] || companyAnchor(company);
}

function peopleFromNews(xml: string, company: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const seen = new Set<string>();
  const anchor = companyAnchor(company);
  const token = distinctiveToken(company);
  const tokenRe = token ? new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
  const titles = xml.match(/<title>([\s\S]*?)<\/title>/gi) || [];
  for (const t of titles) {
    const headline = t.replace(/<\/?title>/gi, "").replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
    // The headline must be ABOUT this company. Require the company name as a WHOLE WORD — substring
    // matching wrongly accepted "Block Island" for "Block" and "trampoline" for "Ramp".
    if (tokenRe && !tokenRe.test(headline)) continue;
    for (const re of APPOINT_RES) {
      const m = headline.match(re);
      if (!m) continue;
      let name = m[1]?.trim();
      const title = m[2]?.trim();
      if (!name) continue;
      // POSSESSIVE attribution ("Tesla's Jon McNeill" surfaced for a Lyft query): the person
      // belongs to that OTHER company. Drop the candidate unless the possessive IS our target,
      // and never let the possessive leak into the name ("Tesla's" → firstName "teslas").
      const poss = name.match(/^(.+?)['’]s\s+(.+)$/);
      if (poss) {
        if (companyAnchor(poss[1]) !== anchor) continue;
        name = poss[2].trim();
      }
      if (!looksLikeName(name) || !looksLikeTitle(title)) continue;
      // COMPANY-MISMATCH GUARD: a headline like "Michael Hartman, General Manager of Champlin's
      // Marina" attributes the person to a DIFFERENT organization. Drop it when the title names a
      // concrete OTHER org (a place/institution word) that isn't our target — this stops a marina
      // GM getting stapled onto the company. Deliberately narrow: it only fires on org-suffix words
      // (Marina/Hotel/Bank/University/…), never on a department like "VP of Engineering", so real
      // managers are never dropped.
      const otherOrg = (title || "").match(
        /\b(?:of|at)\s+([A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,3}\s+(?:Marina|Resort|Hotel|Restaurant|Inn|Casino|School|University|College|Academy|Hospital|Clinic|Bank|Church|Temple|Club|Realty|Motors|Airlines|Airport|Stadium|Theatre|Theater|Museum|Library|District|County|City|Township|Ministry|Department))\b/,
      );
      if (otherOrg && companyAnchor(otherOrg[1]) !== anchor) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const split = splitFullName(name);
      out.push({ fullName: name, firstName: split.firstName, lastName: split.lastName, title, headline: title, source: "news" });
      break;
    }
  }
  return out;
}

/** Single-word company names that are common English words — the loose news RSS pulls in unrelated
 *  stories for these ("Block Island", a "ramp" up, "scale" back), so we skip news for them and lean
 *  on the structured company-site sources instead. Multi-word/distinctive names are unaffected. */
const NEWS_AMBIGUOUS = new Set([
  "block", "ramp", "drive", "scale", "figure", "notion", "lever", "color", "fast", "chord",
  "harness", "sift", "loom", "gem", "density", "persona", "lattice", "opus", "faire", "gusto",
  "attentive", "prove", "rippling", "front", "mode", "branch", "pilot", "wing", "circle", "guru",
]);

async function newsAppointmentCandidates(company: string, candidateTitles: string[]): Promise<PersonCandidate[]> {
  // News is the lowest-precision source. Skip it for too-short or common-word company names where a
  // whole-word match still can't tell the company from the English word.
  const anchor = companyAnchor(company);
  if (anchor.length < 4 || NEWS_AMBIGUOUS.has(anchor)) return [];
  const lead = candidateTitles.slice(0, 4).map((t) => `"${t}"`).join(" OR ");
  const q = `"${company}" (${lead}) (appointed OR names OR hires OR joins OR promoted)`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchText(url);
  return xml ? peopleFromNews(xml, company) : [];
}

/* ------------------------------------------------------------------ */
/* Strategy 3: GitHub org (engineering roles only)                     */
/* ------------------------------------------------------------------ */

async function githubEngCandidates(company: string): Promise<PersonCandidate[]> {
  const org = companyAnchor(company);
  if (!org) return [];
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": UA };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const { egressInit } = await import("../net/egress");
    const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/members?per_page=10`, egressInit({
      headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }));
    if (!res.ok) return [];
    const members = (await res.json()) as Array<{ login: string }>;
    const out: PersonCandidate[] = [];
    for (const mem of members.slice(0, 5)) {
      const u = await fetchText(`https://api.github.com/users/${encodeURIComponent(mem.login)}`);
      if (!u) continue;
      let data: { name?: string; bio?: string } = {};
      try { data = JSON.parse(u); } catch { continue; }
      if (!data.name || !looksLikeName(data.name)) continue;
      const bio = data.bio ?? "";
      // Only keep members whose bio reads like engineering leadership.
      if (!/\b(cto|vp eng|head of eng|engineering lead|director of eng|founder|principal)\b/i.test(bio)) continue;
      const split = splitFullName(data.name);
      out.push({ fullName: data.name, firstName: split.firstName, lastName: split.lastName, title: bio.slice(0, 60), headline: bio, source: "github" });
    }
    return out;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Strategy 4: search-engine LinkedIn-title finder (free, egress-rotated) */
/* ------------------------------------------------------------------ */

const searchCache = new Map<string, { at: number; people: PersonCandidate[] }>();
const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
// A real browser UA — search engines serve scrape-friendly HTML to it and challenge bots less.
const SEARCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Status-aware fetch so we can tell a THROTTLE (429/403/captcha) from a genuine empty result. */
async function searchFetch(url: string): Promise<{ status: number; body: string | null }> {
  try {
    const { egressFetch } = await import("../net/egress");
    const res = await egressFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": SEARCH_UA, Accept: "text/html,application/xhtml+xml,*/*", "Accept-Language": "en-US,en;q=0.9" },
    });
    return { status: res.status, body: res.ok ? await res.text() : null };
  } catch {
    return { status: 0, body: null }; // network/timeout — a miss, not a throttle
  }
}

/** True when the response is a rate-limit / bot challenge (so we back the engine off AND the health
 *  pill shows the truth). Search endpoints return real results ONLY as HTTP 200 — DuckDuckGo serves
 *  its JS anomaly challenge as a 202 with no results, Bing a captcha page, Mojeek a 403. Treating any
 *  non-200 (and any challenge-marker body) as a block is what stops the pill falsely reading
 *  "healthy" while every search is actually being challenged. */
function isThrottle(status: number, body: string | null): boolean {
  if (status !== 200) return true; // 202 challenge / 403 / 429 / 503 — never real results
  return !!body && /unusual traffic|captcha|are you a robot|automated queries|verify you are human|too many requests|challenge-platform|enablejs|noscript.*enable|security of your connection/i.test(body);
}

function cleanTitle(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

/** Turn a list of search-result titles ("Name - Title - Company") into validated candidates. */
function candidatesFromTitles(titles: string[], company: string, anchor: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    const parts = title.split(/\s+[–\-|]\s+/);
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    const roleTitle = parts[1].replace(/\s*\|\s*linkedin.*$/i, "").trim();
    const co = parts[2] ? parts[2].replace(/\s*\|\s*linkedin.*$/i, "").trim() : "";
    if (!looksLikeName(name)) continue;
    const hay = title.toLowerCase();
    const coOk = co ? companyAnchor(co) === anchor || hay.includes(anchor) : hay.includes(anchor);
    if (!coOk) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const split = splitFullName(name);
    out.push({
      fullName: name, firstName: split.firstName, lastName: split.lastName,
      title: roleTitle, headline: roleTitle, source: "search", companyName: company,
    } as PersonCandidate);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Exec/leadership patterns for the "research the hierarchy" pass — names a findable SENIOR
 * (founder / CEO / C-suite / function head) out of GENERAL search-result titles, not just LinkedIn
 * ones. This is how we still name a decision-maker when the EXACT boss has no public footprint: we
 * surface whoever in the chain of command IS public. For SMB that senior is the real decision-maker;
 * for larger orgs it's the up-chain economic buyer.
 */
const APEX_PATTERNS: RegExp[] = [
  // "Jane Smith, CEO" / "Jane Smith - Founder" / "Jane Smith | Chief Executive Officer of Acme"
  /([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2})\s*[,\-–|]\s*((?:co-?founder|founder|owner|ceo|cto|cfo|coo|cmo|cro|cpo|chro|chief\s+\w+\s+officer|chief\s+executive|president|vice\s+president|vp\s+of\s+\w+|head\s+of\s+\w+|director\s+of\s+\w+|general\s+manager)[^,|·]*)/i,
  // "CEO Jane Smith" / "Founder & CEO Jane Smith" / "President Jane Smith"
  /\b(co-?founder|founder|owner|ceo|president|chief\s+executive(?:\s+officer)?)\b[\s:&,]+([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2})/i,
];

/** Parse leaders out of GENERAL result titles (any source), validating name + a real title and
 *  requiring the result to be about THIS company. The recall complement to candidatesFromTitles. */
function leadersFromTitles(titles: string[], company: string, anchor: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const seen = new Set<string>();
  const push = (name: string, title: string) => {
    if (!looksLikeName(name) || !looksLikeTitle(title)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const split = splitFullName(name);
    out.push({
      fullName: name, firstName: split.firstName, lastName: split.lastName,
      title: title.slice(0, 60), headline: title.slice(0, 60), source: "search", companyName: company,
    } as PersonCandidate);
  };
  for (const title of titles) {
    if (out.length >= 8) break;
    // Prefer the clean "Name - Title - Company" shape (covers LinkedIn + many exec databases)…
    const linked = candidatesFromTitles([title], company, anchor);
    if (linked.length) { for (const c of linked) push(c.fullName, c.title || ""); continue; }
    // …else require the company anchor in the title and pull a name+exec-title pair.
    if (!title.toLowerCase().includes(anchor)) continue;
    for (const re of APEX_PATTERNS) {
      const m = title.match(re);
      if (!m) continue;
      const a = (m[1] || "").trim(), b = (m[2] || "").trim();
      if (looksLikeName(a)) push(a, b);          // pattern 1: name, title
      else if (looksLikeName(b)) push(b, a);     // pattern 2: title, name
      break;
    }
  }
  return out;
}

/** The free search engines we read public titles from, tried in order, each independently rested.
 *  Mixing INDEPENDENT indexes (DuckDuckGo, Bing, Mojeek) matters twice over: each surfaces names the
 *  others miss, AND when one rate-limits the others keep naming — diversity is throttle-insurance.
 *  An optional self-hosted/public SearXNG (INMARKET_SEARXNG_URL) is prepended as a meta-aggregator. */
const SEARCH_ENGINES: Array<{ id: string; url: (q: string) => string; titles: (html: string) => string[] }> = [
  {
    id: "duckduckgo",
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    titles: (html) => matchAll(html, [/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/gi]),
  },
  {
    id: "bing",
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20`,
    titles: (html) => matchAll(html, [/<h2>\s*<a [^>]*>([\s\S]*?)<\/a>/gi]),
  },
  {
    // Independent crawler/index (not Bing/Google backed) — scrape-friendly plain HTML.
    id: "mojeek",
    url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`,
    titles: (html) => matchAll(html, [
      /<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
      /<h2>\s*<a [^>]*>([\s\S]*?)<\/a>/gi,
    ]),
  },
  {
    // DuckDuckGo's minimal endpoint — different host/path, so it throttles independently of the
    // main DDG HTML endpoint (extra resilience when html.duckduckgo.com is resting).
    id: "ddg_lite",
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    titles: (html) => matchAll(html, [/<a[^>]+class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi]),
  },
];

// Optional meta-search aggregator (self-hosted or public SearXNG). When configured it goes FIRST —
// one query fans out across Google/Bing/etc server-side and returns clean JSON, the single biggest
// free naming lift if you run an instance. Env-gated so it's a no-op until you point it at one.
if (process.env.INMARKET_SEARXNG_URL) {
  SEARCH_ENGINES.unshift({
    id: "searxng",
    url: (q) => `${process.env.INMARKET_SEARXNG_URL!.replace(/\/$/, "")}/search?q=${encodeURIComponent(q)}&format=json`,
    titles: (body) => {
      try {
        const j = JSON.parse(body) as { results?: Array<{ title?: string; content?: string }> };
        return (j.results ?? []).slice(0, 15).map((r) => String(r.title ?? "")).filter(Boolean);
      } catch { return []; }
    },
  });
}

/** Run one or more extraction patterns over a result page, de-duplicated, capped. Multiple patterns
 *  let an engine whose markup varies (e.g. Mojeek) still yield titles without a brittle single regex. */
function matchAll(html: string, res: RegExp[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of res) {
    const r = new RegExp(re.source, re.flags); // fresh lastIndex per call
    let m: RegExpExecArray | null;
    while ((m = r.exec(html)) && out.length < 15) {
      const t = cleanTitle(m[1]);
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

/**
 * The biggest free lift to the NAMING rate. Reads the decision-maker's name straight out of PUBLIC
 * search-result titles, e.g. "Jane Doe - VP of Engineering - Acme" — catching the many companies the
 * team-page / news strategies miss (no public team page, no press).
 *
 * RUN-IT-HARD SAFELY: every request is egress-IP rotated (free Hetzner IPv6 /64) AND wrapped by the
 * search-health system — a throttled engine is rested with exponential back-off and we fall through
 * to the next engine, so one source rate-limiting never stops naming. Outcomes feed the live health
 * pill so sustainability is visible. Cached per company. Reads only public titles, never LinkedIn.
 */
/** Run a query across the engine rotation (each independently rested under the health system),
 *  parsing each engine's result titles with `parse`. Returns the first engine's non-empty result. */
async function searchEngines(q: string, parse: (titles: string[]) => PersonCandidate[]): Promise<PersonCandidate[]> {
  for (const eng of SEARCH_ENGINES) {
    if (!isAvailable(eng.id)) continue; // engine resting in back-off — skip to the next source
    // Each attempt goes out a FRESH rotated source IP (egressFetch round-robins the /64). On a
    // throttle we retry on ANOTHER IP before giving up on the engine — this is what makes a larger
    // egress pool actually pay off: a per-IP rate limit is dodged by moving the retry to a new IP.
    let found: PersonCandidate[] = [];
    let throttled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { status, body } = await searchFetch(eng.url(q));
      if (isThrottle(status, body)) { throttled = true; continue; } // this IP is rate-limited — rotate
      throttled = false;
      if (body) found = parse(eng.titles(body));
      break;
    }
    if (throttled && !found.length) { recordSearch(eng.id, "throttled"); continue; }
    recordSearch(eng.id, found.length ? "ok" : "empty");
    if (found.length) return found; // first engine that yields names wins
  }
  return [];
}

async function searchEngineCandidates(company: string, titles: string[]): Promise<PersonCandidate[]> {
  const anchor = companyAnchor(company);
  if (anchor.length < 3) return [];
  // Cache keyed by company + the function we're targeting, so researching multiple functions at the
  // same company doesn't collide on one cached result.
  const cacheKey = `${anchor}::${(titles[0] || "").toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.people;

  const titleQ = titles.slice(0, 5).map((t) => `"${t}"`).join(" OR ");
  // PASS 1 — precise: the exact boss titles on LinkedIn ("Name - VP of Engineering - Acme").
  let people = await searchEngines(
    `${company} (${titleQ}) site:linkedin.com/in`,
    (t) => candidatesFromTitles(t, company, anchor),
  );
  // PASS 2 — RESEARCH THE HIERARCHY when the exact boss has no public profile: a broad leadership
  // query that names whoever in the chain of command IS public (founder / CEO / C-suite / function
  // head) from ANY source. For SMB this findable senior is the real decision-maker; for larger orgs
  // it's the up-chain economic buyer. Only runs on a miss, so it costs nothing when Pass 1 hits.
  if (!people.length) {
    people = await searchEngines(
      `"${company}" (CEO OR Founder OR "Chief Executive" OR President OR "Head of" OR "Vice President")`,
      (t) => leadersFromTitles(t, company, anchor),
    );
  }
  searchCache.set(cacheKey, { at: Date.now(), people });
  return people;
}

/* ------------------------------------------------------------------ */
/* The free people-graph                                               */
/* ------------------------------------------------------------------ */

/**
 * A `PeopleGraph` backed entirely by free public research. Runs the playbook strategies, merges
 * their candidates, and hands them to the resolver's scorer. Stateless + injectable like every
 * other graph, so it slots straight into resolveHiringManager / the hiring pipeline.
 */
export function freePeopleGraph(opts?: { domain?: string }): PeopleGraph {
  return {
    id: "free_research",
    isConfigured: () => true,
    async search(query: PeopleQuery): Promise<PersonCandidate[]> {
      const company = query.companyName;
      const domain = opts?.domain || query.companyDomain;
      const titles = query.titles?.length ? query.titles : ["Head of", "VP", "Director", "Manager"];
      const fn = query.function;

      const tasks: Array<Promise<PersonCandidate[]>> = [];
      if (domain) tasks.push(companySiteCandidates(domain));
      if (company) tasks.push(newsAppointmentCandidates(company, titles));
      if (company) tasks.push(searchEngineCandidates(company, titles)); // free, egress-rotated naming
      if (company && fn === "engineering") tasks.push(githubEngCandidates(company));

      const results = await Promise.all(tasks.map((t) => t.catch(() => [] as PersonCandidate[])));
      // Merge + dedupe by name; tag every candidate with the company so the scorer trusts them.
      const byName = new Map<string, PersonCandidate>();
      for (const list of results) {
        for (const c of list) {
          const key = c.fullName.toLowerCase();
          if (!byName.has(key)) byName.set(key, { ...c, companyName: c.companyName ?? company });
        }
      }
      const merged = [...byName.values()];
      return query.limit ? merged.slice(0, query.limit) : merged;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Top-level: resolve the decision-maker for a specific role           */
/* ------------------------------------------------------------------ */

export interface DecisionMaker {
  /** Resolved person's full name, when found by free research. */
  fullName?: string;
  firstName?: string;
  lastName?: string;
  /** Their actual title as observed (when found), else the inferred owning title. */
  title?: string;
  /** The owning title we were targeting (always set), e.g. "VP of Engineering". */
  targetTitle: string;
  /** engineering | sales | … — the function the role rolls up to. */
  function: string;
  /** Confidence tier from the resolver: named_verified | named | function_leader | recruiter | company_only. */
  tier: string;
  /** 0..1 fit score for the best candidate. */
  score: number;
  /** Where the name came from: company_site | news | github (empty when title-only). */
  via?: string;
  /** Best-guess work email + ranked alternates (syntax only, unverified). */
  email?: EmailGuess;
  /** The VERIFIED company domain we resolved/used (when found) — persisted so the read path
   *  and the email guess have it without re-resolving. Empty when none could be confirmed. */
  domain?: string;
  /** True when the resolved domain publishes MX records (it can actually receive mail). */
  emailDeliverable?: boolean;
  /** True when `email` is the person's OWN published address (harvested from the company site) —
   *  a verified-grade contact, not a guess. Lets curation mark it validated immediately. */
  emailConfirmed?: boolean;
  /** How `email` was produced: "site_direct" (published address that IS this person), "site_pattern"
   *  (the domain's learned pattern), or "guess" (the blind syntax prior). Drives the funnel's
   *  email-source breakdown so we can see how many contacts are verified vs guessed. */
  emailSource?: "site_direct" | "site_pattern" | "guess" | "validated_external";
  /** Short, honest "why this person/title" line for the UI. */
  why: string;
}

/**
 * Resolve the decision-maker for ONE open role at ONE company using free research, and attach a
 * best-guess email. Always returns a usable target: a NAMED person when the research found one,
 * otherwise the inferred owning TITLE (never fabricated). The email guess is only built when we
 * have a real name + a domain.
 */
export async function resolveDecisionMaker(
  company: string,
  roleTitle: string,
  opts?: { domain?: string; companySize?: number; sourceUrl?: string },
): Promise<DecisionMaker> {
  // Size-aware targeting: the owner of this hire depends on the company's org depth (a line manager
  // at an enterprise, the VP/founder at a flat 150-person shop). Passing companySize is what makes
  // us target the RIGHT — and most findable — decision-maker, which is the biggest free naming lift.
  const target = hiringManagerTarget(roleTitle, { companySize: opts?.companySize });
  const targetTitle = target.candidateTitles[0] ?? "Hiring Manager";
  const fn = classifyTitle(roleTitle).function;

  // THE UNLOCK: resolve a VERIFIED company domain when the lead didn't carry one. Free job-board
  // signals arrive with a name but no domain, which starves BOTH the company-site team-page
  // research (the best NAME source) AND the email guess. Resolving it here is what lifts the
  // contactable rate. Cached per company, so this is cheap across the pool. Best-effort: if it
  // can't confirm a domain we degrade to exactly the prior behaviour.
  let domainRes: DomainResolution | null = null;
  let resolvedDomain = opts?.domain ? emailDomainFrom(opts.domain) : "";
  if (!resolvedDomain) {
    domainRes = await resolveCompanyDomain(company, { sourceUrl: opts?.sourceUrl }).catch(() => null);
    if (domainRes?.domain) resolvedDomain = domainRes.domain;
  }

  let resolution: HiringManagerResolution | null = null;
  try {
    resolution = await resolveHiringManager(company, roleTitle, {
      graphs: [freePeopleGraph({ domain: resolvedDomain || undefined })],
      companyDomain: resolvedDomain || undefined,
      companySize: opts?.companySize,
      maxCandidatesPerGraph: 25,
      alternates: 2,
    });
  } catch {
    resolution = null;
  }

  // PAID NAMING FALLBACK (RapidAPI, env-gated) — cost discipline: only when FREE research left us
  // without a real name. We fetch decision-maker candidates from the configured people-search and
  // run them back through the SAME scorer (so title/function fit + tier still apply), then continue
  // into the normal email-building path below. No-op (zero spend) unless RAPID_NAMING_KEY is set.
  if (!resolution?.best?.candidate.fullName && paidNamingEnabled()) {
    try {
      const rapid = await findDecisionMakerRapid(company, resolvedDomain || undefined, target.candidateTitles);
      if (rapid.length) {
        const paidGraph: PeopleGraph = { id: "rapid_naming", isConfigured: () => true, search: async () => rapid };
        const r2 = await resolveHiringManager(company, roleTitle, {
          graphs: [paidGraph],
          companyDomain: resolvedDomain || undefined,
          companySize: opts?.companySize,
          maxCandidatesPerGraph: 25,
          alternates: 2,
        });
        if (r2?.best?.candidate.fullName) resolution = r2;
      }
    } catch { /* paid rung is best-effort; fall through to title-level */ }
  }

  const best = resolution?.best ?? null;
  const domain = resolvedDomain;
  // emailDeliverable is a POSITIVE-only signal: true when the resolved domain publishes MX. A
  // resolved domain with no MX is NOT marked false — its homepage is live (so the domain exists)
  // and many firms still receive mail via an implicit record; suppressing it would drop real
  // prospects. The email-validation tick makes the final call (only a dead NXDOMAIN is invalid).
  const deliverable = domainRes?.mx ? true : undefined;

  if (best && best.candidate.fullName) {
    const c = best.candidate;
    // Start from the syntax guess, then DEEP-PULL the company's own published addresses to upgrade
    // it: a real address that IS this person (verified-grade), or the domain's pattern LEARNED from
    // a colleague's published address — far stronger than the generic first.last prior.
    let email = domain ? guessEmail(c.firstName, c.lastName, domain) : undefined;
    let emailConfirmed = false;
    let emailSource: DecisionMaker["emailSource"] = email?.email ? "guess" : undefined;
    if (domain) {
      const teamPeople = [c, ...(resolution!.alternates ?? []).map((a) => a.candidate)]
        .map((p) => ({ firstName: p.firstName, lastName: p.lastName, fullName: p.fullName }));
      const deep = await resolvePersonEmail(domain, { firstName: c.firstName, lastName: c.lastName, fullName: c.fullName }, teamPeople).catch(() => null);
      if (deep?.email) {
        email = { email: deep.email, pattern: deep.pattern, alternates: email?.alternates ?? [], confidence: deep.confirmed ? 0.95 : 0.7, verified: false, domain };
        emailConfirmed = deep.confirmed;
        emailSource = deep.via; // "site_direct" | "site_pattern"
      }
    }
    // CHEAP-FIRST PAID FALLBACK (Icypeas, env-gated): if free resolution left us without a
    // confirmed address — no email at all, or only an unconfirmed guess — resolve + verify one
    // for ~$0.003. No-op (zero spend) unless ICYPEAS_API_KEY is set. This is what converts the
    // Named-but-not-Contactable rows into real reachable people.
    if (!emailConfirmed && paidEmailEnabled()) {
      const paid = await findEmailIcypeas(c.firstName, c.lastName, domain || company).catch(() => null);
      if (paid?.email) {
        email = { email: paid.email, pattern: email?.pattern ?? "", alternates: email?.alternates ?? [], confidence: paid.verified ? 0.95 : 0.75, verified: paid.verified, domain: domain || emailDomainFrom(paid.email) };
        emailConfirmed = paid.verified;
        emailSource = "validated_external";
      }
    }
    return {
      fullName: c.fullName,
      firstName: c.firstName,
      lastName: c.lastName,
      title: c.title ?? c.headline ?? targetTitle,
      targetTitle,
      function: fn,
      tier: resolution!.tier,
      score: best.score,
      via: c.source,
      email: email && email.email ? email : undefined,
      domain: domain || undefined,
      // a published address that IS this person is deliverable for real; otherwise fall back to the
      // domain-level MX signal.
      emailDeliverable: emailConfirmed ? true : deliverable,
      emailConfirmed: emailConfirmed || undefined,
      emailSource,
      why: best.reasons[0] ?? `${target.rationale}`,
    };
  }

  // No name resolved → honest title-level target (still actionable; email needs a name). We
  // still carry the resolved domain so the read path / a later name find can build the email.
  return {
    targetTitle,
    title: targetTitle,
    function: fn,
    tier: "company_only",
    score: 0,
    domain: domain || undefined,
    emailDeliverable: deliverable,
    why: target.rationale,
  };
}
