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

/* ------------------------------------------------------------------ */
/* Shared fetch helpers (free, timed-out, polite UA)                   */
/* ------------------------------------------------------------------ */

const FETCH_TIMEOUT_MS = 8_000;
const UA = "RecruitersOS/1.0 (+https://recruiteros.app; hiring-manager research)";

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
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

async function companySiteCandidates(domain: string): Promise<PersonCandidate[]> {
  const base = `https://${domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  const found: PersonCandidate[] = [];
  let pagesWithPeople = 0;
  for (const path of TEAM_PATHS) {
    if (pagesWithPeople >= 2) break;               // enough signal; stop probing
    const html = await fetchText(base + path);
    if (!html) continue;
    // STRUCTURED ONLY: schema.org JSON-LD `Person` blocks. The free-text heuristic was dropped
    // on purpose — on marketing pages it grabs product-name bigrams next to title words
    // ("Vector Search — CTO"), and a wrong name → wrong email → bounce → domain-reputation
    // damage. For outbound, precision beats recall: only trust structured author/leadership data.
    const ld = peopleFromJsonLd(html, "company_site");
    // Keep only people we can place by a real title (so an untitled author can't pose as the head).
    const titled = ld.filter((p) => looksLikeTitle(p.title));
    if (titled.length) { found.push(...titled); pagesWithPeople++; }
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

function peopleFromNews(xml: string, company: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const seen = new Set<string>();
  const anchor = companyAnchor(company);
  const titles = xml.match(/<title>([\s\S]*?)<\/title>/gi) || [];
  for (const t of titles) {
    const headline = t.replace(/<\/?title>/gi, "").replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
    // The headline must actually be ABOUT this company — the RSS query is loose, so this guards
    // against grabbing a same-titled person at an unrelated firm (e.g. a film exec for "Ramp").
    if (anchor && !companyAnchor(headline).includes(anchor)) continue;
    for (const re of APPOINT_RES) {
      const m = headline.match(re);
      if (!m) continue;
      const name = m[1]?.trim();
      const title = m[2]?.trim();
      if (!name || !looksLikeName(name) || !looksLikeTitle(title)) continue;
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

async function newsAppointmentCandidates(company: string, candidateTitles: string[]): Promise<PersonCandidate[]> {
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
    const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/members?per_page=10`, {
      headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
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
  const target = hiringManagerTarget(roleTitle);
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

  const best = resolution?.best ?? null;
  const domain = resolvedDomain;
  // MX is known for free for domains we resolved ourselves; an explicitly-passed domain is
  // left undefined here and verified later by the email-validation tick.
  const deliverable = domainRes ? domainRes.mx : undefined;

  if (best && best.candidate.fullName) {
    const c = best.candidate;
    const email = domain ? guessEmail(c.firstName, c.lastName, domain) : undefined;
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
      emailDeliverable: deliverable,
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
