/**
 * RecruitersOS · Signal Watchlists · news-signal DISCOVERY
 *
 * The job feed answers "who posted a role?". This module answers a different and
 * earlier question: "who just came into money, leadership, or a new market?" A
 * company that closed a Series B three days ago is hiring for the next two
 * quarters, but most of those roles are not posted yet. Reaching the buyer in
 * that window is the whole point of signal-led BD.
 *
 * Shape of the difference, and why this is a separate front end:
 *
 *   jobFeed   : query -> JSearch -> companies that ALREADY posted   (paid, per-call budget)
 *   newsDiscover: SEGMENT -> Google News RSS -> companies that just RAISED / HIRED an
 *                 exec / EXPANDED / ACQUIRED / LAUNCHED             (free, keyless)
 *
 * Both hand the SAME `InMarketLead[]` to the same belt (dedupe -> curateFromPool ->
 * 3 decision-makers -> Clients tab -> email -> Send Queue), so nothing downstream
 * changes. Two properties make that work:
 *
 *  1. COMPANY KEY. Leads are keyed with the job feed's own `companyKey`, so the
 *     global "seen" set treats a news-discovered company and a job-feed company as
 *     one company. A firm that raises AND posts a role is still pitched once.
 *
 *  2. SYNTHESIZED ROLES. `curateFromPool` finds a decision-maker by asking "who owns
 *     this open role?", and drops any lead with no roles at all. A funding headline
 *     carries no roles, so we infer the build-out the money buys (GTM hire, engineer,
 *     ops lead) and let the existing resolver walk up to the VP/Chief who owns it.
 *     That is the decision-maker the email goes to.
 *
 * The extracted fact lands on `lead.reason`, which the belt copies to the prospect's
 * `signalReason`, which is the "Signal:" line in the Email 1 prompt. So a headline
 * like "FleetLogs raises $60M Series B to scale AI truck intelligence" becomes an
 * opener anchored on that raise instead of a generic hiring guess.
 *
 * Cost: $0. Google News RSS is keyless and unauthenticated. Everything is timeboxed
 * and fails soft, so a news outage degrades to "no new leads this tick", never an error.
 */

import { companyKey } from "../../inmarket/jobFeed";
import type { InMarketLead } from "../../inmarket";

/* ------------------------------------------------------------------ */
/* What we hunt for                                                    */
/* ------------------------------------------------------------------ */

/** The news signal types this module can discover. Each maps to a query shape and a
 *  post-signal hiring build-out. Contraction signals are deliberately absent: a layoff
 *  is a candidate-supply signal, not a reason to pitch a company on hiring help. */
export type NewsSignal =
  | "funding_round"
  | "exec_hire"
  | "office_expansion"
  | "acquisition"
  | "product_launch";

export const NEWS_SIGNALS: NewsSignal[] = [
  "funding_round", "exec_hire", "office_expansion", "acquisition", "product_launch",
];

/** Base 0..100 intent score per signal. Funding is the highest-converting BD trigger:
 *  new budget plus a board expecting headcount against it. */
const BASE_SCORE: Record<NewsSignal, number> = {
  funding_round: 72,
  exec_hire: 62,
  office_expansion: 56,
  acquisition: 50,
  product_launch: 46,
};

/**
 * Google News query per signal. `{seg}` is the recruiter's segment in quotes, and
 * `when:Nd` is Google News' own recency operator so the feed filters server-side
 * instead of us pulling stale pages and discarding them.
 */
const QUERY: Record<NewsSignal, string> = {
  funding_round:
    '{seg} (raises OR raised OR "closes funding" OR "Series A" OR "Series B" OR "Series C" OR "seed round") when:{win}',
  exec_hire:
    '{seg} (appoints OR names OR "has hired" OR taps) (CEO OR CRO OR CTO OR COO OR "chief revenue" OR "vice president") when:{win}',
  office_expansion:
    '{seg} ("new office" OR "opens office" OR expansion OR "expands into") when:{win}',
  acquisition:
    "{seg} (acquires OR acquisition OR \"has acquired\") when:{win}",
  product_launch:
    '{seg} (launches OR unveils OR "rolls out") when:{win}',
};

/* ------------------------------------------------------------------ */
/* Headline parsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Verbs that put the COMPANY to their LEFT. "FleetLogs raises $60M" -> FleetLogs.
 * Kept tight on purpose: a loose verb list turns half of every headline into a
 * company name.
 */
const SUBJECT_VERBS = [
  "raises", "raised", "closes", "closed", "secures", "secured", "lands", "landed",
  "nabs", "nabbed", "snags", "banks", "scores", "picks up", "pulls in", "hauls in",
  "announces", "bags", "appoints", "names", "hires", "taps", "promotes",
  "acquires", "acquired", "expands", "opens", "launches", "unveils", "rolls out",
];

/**
 * The investor-first shape: "Battery Ventures leads $60M round in FleetLogs". Here the
 * company sits AFTER the preposition, and the left-hand subject is the fund, so the
 * subject pass would name the wrong entity.
 */
const OBJECT_RE =
  /\b(?:round|investment|financing|funding|stake|raise)\s+(?:in|into|for)\s+([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'’-]*){0,3})/;

/**
 * HARD descriptors: words that are essentially never part of a real company name.
 * "Supply chain startup Auger" -> the name starts after "startup".
 */
const HARD_DESCRIPTOR = new Set([
  "exclusive", "breaking", "report", "update", "scoop",
  "startup", "startups", "scaleup", "company", "firm", "business",
  "platform", "provider", "vendor", "maker", "operator", "specialist", "distributor",
  "unicorn", "giant", "player", "outfit", "venture",
  "saas", "b2b", "b2c", "ai-powered", "ai-driven", "vc-backed", "pe-backed", "yc-backed",
  "based", "the", "a", "an", "this",
]);

/**
 * SOFT descriptors: sector and nationality words that OFTEN precede a name but are
 * just as often PART of one ("Canadian National Railway", "American Airlines").
 * These are only stripped as part of a run that also contains a hard descriptor, which
 * is what tells us the publication was describing the company rather than naming it.
 */
const SOFT_DESCRIPTOR = new Set([
  "software", "tech", "technology", "ai", "enterprise", "digital", "cloud", "data",
  "fintech", "insurtech", "healthtech", "medtech", "edtech", "proptech", "climatetech", "biotech",
  "logistics", "freight", "trucking", "supply", "chain", "shipping", "warehouse", "transport",
  "healthcare", "health", "medical", "clinical", "financial", "insurance", "industrial",
  "us", "u.s.", "uk", "european", "israeli", "indian", "canadian", "australian", "german", "french",
  "new", "young", "early-stage", "late-stage", "leading", "global", "regional",
  "leader", "innovator", "developer", "group", "series", "backed",
]);

function isDescriptor(token: string): boolean {
  const t = token.toLowerCase().replace(/[.,]$/, "");
  return HARD_DESCRIPTOR.has(t) || SOFT_DESCRIPTOR.has(t);
}

/** Words that mean the "company" we extracted is not a hiring company at all. */
const NOT_A_COMPANY = /^(?:it|they|he|she|we|you|who|what|why|how|here|there|more|most|top|best|five|four|three|two|one|\d+)$/i;

/** Investment-firm suffixes. A fund raising its own fund is not a BD lead. */
const INVESTOR_SUFFIX = /\b(ventures|capital|partners|equity|holdings|fund|funds|advisors|asset management)\b/i;

/** "X raises $500M fund" is a FUND close, not an operating company's round. */
const FUND_CLOSE = /\b(fund|vehicle|continuation|dry powder)\b/i;

/** Publications that show up as the leading token when a headline is oddly formed. */
const PUBLISHER = /^(techcrunch|reuters|bloomberg|forbes|axios|pymnts|businesswire|prnewswire|globenewswire|crunchbase|sifted|fortune|cnbc|wsj|ft|venturebeat|freightwaves|supply ?chain ?dive|the information)$/i;

interface Headline {
  title: string;
  link: string;
  publishedAt?: string;
  publisher?: string;
}

/** Strip Google News' trailing " - Publisher" and any leading "Exclusive:" tag. */
export function cleanHeadline(raw: string): { text: string; publisher?: string } {
  let t = (raw || "").replace(/\s+/g, " ").trim();
  let publisher: string | undefined;
  // Google News appends the outlet after the LAST " - ". Only treat it as an outlet
  // when the tail is short and title-like, so "raises $60M - and hires 40" survives.
  const m = t.match(/^(.*\S)\s+-\s+([^-]{2,40})$/);
  if (m && !/\d/.test(m[2])) { t = m[1].trim(); publisher = m[2].trim(); }
  t = t.replace(/^(exclusive|breaking|scoop|update|report|just in)\s*[:\-]\s*/i, "").trim();
  return { text: t, publisher };
}

/**
 * Drop the leading descriptor run, but ONLY when that run contains a hard descriptor.
 *
 *   "Supply chain startup Auger"      -> "Auger"                 (run ends at "startup")
 *   "AI-powered logistics platform X" -> "X"                     (run ends at "platform")
 *   "Canadian National Railway"       -> "Canadian National Railway"
 *
 * The last case is why the tiers exist: "Canadian" is a descriptor in isolation but is
 * part of this company's actual name, and nothing else in the run says otherwise. A
 * blanket strip turned that into "National Railway", a company that does not exist.
 */
function stripDescriptors(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  // How far does the leading descriptor run reach, and does it contain a hard one?
  let runEnd = -1;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isDescriptor(parts[i])) break;
    if (HARD_DESCRIPTOR.has(parts[i].toLowerCase().replace(/[.,]$/, ""))) runEnd = i;
  }
  return (runEnd >= 0 ? parts.slice(runEnd + 1) : parts).join(" ");
}

/**
 * Publications localize a company with a possessive: "Fort Worth's Conner Industries".
 * The possessive is never part of the name, and leaving it on splits one company into
 * two leads (and two pitches) when another outlet writes the name plainly.
 */
function stripPossessivePrefix(name: string): string {
  const m = name.match(/^(?:[\w.&-]+\s+){0,3}?[\w.&-]+['’]s\s+(.+)$/);
  return m ? m[1].trim() : name;
}

/**
 * Keep the trailing proper-noun run. Publications write long subjects
 * ("After a rocky year, Auger raises...") so we take the capitalized tail, which is
 * where the name always sits, and cap it at four tokens.
 */
function properTail(subject: string): string {
  const parts = subject.split(/\s+/).filter(Boolean);
  const tail: string[] = [];
  for (let i = parts.length - 1; i >= 0 && tail.length < 4; i--) {
    const w = parts[i];
    const bare = w.replace(/[^\w.&'’-]/g, "");
    if (!bare) break;
    // Capitalized, all-caps, or a name-ish token (Inc., 3M, X.ai). Lowercase stops the run.
    if (!/^[A-Z0-9]/.test(bare)) break;
    tail.unshift(bare);
  }
  return tail.join(" ");
}

/** Final tidy + sanity gate on an extracted name. Returns "" when it is not usable. */
function normalizeName(raw: string): string {
  let n = stripPossessivePrefix((raw || "").trim());
  n = stripDescriptors(n);
  n = n.replace(/[,;:]+$/, "").replace(/['’]s$/i, "").trim();
  n = n.replace(/\s+\b(inc|llc|ltd|corp|co|plc|gmbh|sa|ag|bv|ab|oy|as)\b\.?$/i, "").trim();
  if (n.length < 2 || n.length > 60) return "";
  if (NOT_A_COMPANY.test(n)) return "";
  if (PUBLISHER.test(n)) return "";
  if (!/[A-Za-z]/.test(n)) return "";
  if (!/^[A-Z0-9]/.test(n)) return "";                   // must open on a proper noun
  if (isDescriptor(n)) return "";                        // "Startup", "Platform" alone
  return n;
}

/**
 * Pull the subject company out of one headline. Tries the investor-first shape first
 * (it is unambiguous when it matches), then the verb-subject shape. Returns "" when
 * the headline has no confidently-named company, which is the common case and is
 * exactly what should be dropped rather than guessed at.
 */
export function extractCompany(headline: string): string {
  const { text } = cleanHeadline(headline);
  if (!text) return "";

  // Pass A: "... round in <Company>" / "invests in <Company>".
  const obj = text.match(OBJECT_RE);
  if (obj) {
    const n = normalizeName(obj[1]);
    if (n && !INVESTOR_SUFFIX.test(n)) return n;
  }

  // Pass B: "<Company> raises/appoints/acquires ...". Take the EARLIEST verb so a
  // second clause ("... and names a new CRO") cannot re-anchor the subject.
  let best: { idx: number; subject: string } | null = null;
  for (const v of SUBJECT_VERBS) {
    const re = new RegExp(`(^|[^\\w])${v.replace(/ /g, "\\s+")}(?=[^\\w]|$)`, "i");
    const m = text.match(re);
    if (!m || m.index === undefined) continue;
    const idx = m.index + m[1].length;
    if (idx <= 0) continue;                              // verb leads the headline, no subject
    if (!best || idx < best.idx) best = { idx, subject: text.slice(0, idx) };
  }
  if (!best) return "";

  // A publication often drops an appositive between the name and the verb:
  //   "Supply chain startup Auger, led by ex-Amazon operations chief, raises $50M"
  // The proper-noun tail of that whole subject is "chief" (lowercase, so nothing), and
  // the name sits in the FIRST comma clause. Try each clause left to right and keep the
  // first that yields a real name, which puts the true subject ahead of the aside.
  const clauses = best.subject.split(",").map((s) => s.trim()).filter(Boolean);
  for (const clause of clauses) {
    const n = normalizeName(properTail(clause));
    if (!n) continue;
    // A fund closing its own fund is not an operating company with roles to fill.
    if (INVESTOR_SUFFIX.test(n) && FUND_CLOSE.test(text)) return "";
    return n;
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Fact extraction: the specifics that make an email land              */
/* ------------------------------------------------------------------ */

export interface NewsFacts {
  amountUsd?: number;
  amountText?: string;   // as written: "$60M"
  round?: string;        // "Series B", "seed"
  investor?: string;     // "Battery Ventures"
  purpose?: string;      // "scale AI truck intelligence"
  /** True when the purpose came from a sentence-case headline (real prose) rather than
   *  a de-title-cased one. A merge prefers prose, which needs no reconstruction. */
  purposeFromProse?: boolean;
  execTitle?: string;    // "chief revenue officer"
  /** What KIND of appointment it was, when the headline says. Board seats and
   *  leadership-team additions are common and must not be described as an exec hire. */
  appointmentKind?: "board" | "leadership_team";
}

const MULT: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9, t: 1e12 };

/** "$60M" / "$1.2 billion" / "€45 million" -> { amountUsd, amountText }. Non-USD is read
 *  at face value: the magnitude is what steers targeting, not the exchange rate. */
export function parseAmount(text: string): { amountUsd?: number; amountText?: string } {
  const m = text.match(/([$€£])\s?([\d]+(?:[.,]\d+)?)\s*(billion|million|thousand|bn|mm|[kmbt])\b/i);
  if (!m) return {};
  const n = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return {};
  const unit = m[3].toLowerCase();
  const mult =
    unit.startsWith("bill") ? 1e9 :
    unit.startsWith("mill") ? 1e6 :
    unit.startsWith("thou") ? 1e3 :
    MULT[unit] ?? 1;
  const amountUsd = n * mult;
  const short = mult >= 1e9 ? `${n}B` : mult >= 1e6 ? `${n}M` : mult >= 1e3 ? `${n}K` : `${n}`;
  return { amountUsd, amountText: `${m[1]}${short}` };
}

/**
 * "Raises" is heavily overloaded in business press: a company raises guidance, raises
 * prices, raises its outlook, raises concerns. None of those are a funding event, and
 * pitching a rail operator on its "raise" because it lifted a volume forecast is the
 * kind of mistake that reads as automated. Reject those outright.
 */
const NOT_A_RAISE =
  /\braise[sd]?\s+(?:its\s+|their\s+|the\s+|\d{4}\s+)*(?:full[- ]year\s+|quarterly\s+|annual\s+|volume\s+|revenue\s+|earnings\s+)*(outlook|guidance|forecast|estimates?|targets?|projections?|prices?|fares?|rates?|dividend|stake|bid|offer|alarm|concerns?|questions?|eyebrows|doubts?|awareness)\b/i;

/** Words that mark a genuine capital event, for headlines that state no dollar figure. */
const FUNDING_WORD = /\b(funding|fundraise|financing|investment|round|series\s+[a-j]|seed|capital|backing|valuation|raise of)\b/i;

/**
 * Does this headline actually describe a capital raise? Requires either a dollar figure
 * or explicit funding language, and rejects the overloaded-verb shapes above. Applied
 * only to the funding query, where the false-positive rate is highest.
 */
export function isRealRaise(headline: string): boolean {
  const { text } = cleanHeadline(headline);
  if (NOT_A_RAISE.test(text)) return false;
  if (parseAmount(text).amountUsd !== undefined) return true;
  return FUNDING_WORD.test(text);
}

/**
 * Purpose clauses that are actually appointment targets: "appoints X to board of
 * directors" would otherwise render as "is opening a new location to board of
 * directors". Only real "to <do something>" clauses survive.
 */
const NOT_A_PURPOSE = /^(?:the\s+|its\s+|his\s+|her\s+|their\s+)?(board|directors|leadership|chair|ceo|president|cfo|cto|coo|cro|role|position|post|seat|team)\b/i;

/**
 * Is this headline written in Title Case? Matters because the purpose clause gets
 * spliced into the middle of an English sentence in the email, and "we saw you raised
 * to Automate Fortune 500 Supply Chain Spend" is an instant tell that a machine wrote
 * it. In a sentence-case headline the capitals are real proper nouns and must be kept.
 */
export function isTitleCase(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z]{3,}$/.test(w));
  if (words.length < 4) return false;
  const capped = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capped / words.length > 0.6;
}

/**
 * Undo Title Case on a clause, keeping the capitals that are genuinely proper:
 * acronyms (AI, API), internal caps (McKinsey, iPhone), and words qualifying a number
 * ("Fortune 500"). Everything else drops to lowercase so the clause reads as prose.
 */
export function deTitleCase(clause: string): string {
  const words = clause.split(/\s+/);
  return words
    .map((w, i) => {
      const bare = w.replace(/[^\w]/g, "");
      if (!bare) return w;
      if (bare === bare.toUpperCase()) return w;             // AI, US, API
      if (/[A-Z]/.test(bare.slice(1))) return w;             // McKinsey, iPhone
      if (/^\d/.test(words[i + 1] || "")) return w;          // Fortune 500
      return w.charAt(0).toLowerCase() + w.slice(1);
    })
    .join(" ");
}

export function extractFacts(headline: string): NewsFacts {
  const { text } = cleanHeadline(headline);
  const facts: NewsFacts = { ...parseAmount(text) };

  const round = text.match(/\b(pre-seed|seed|series\s+[a-j]|growth round|bridge round|round [a-j])\b/i);
  if (round) {
    facts.round = round[1].replace(/\s+/g, " ").replace(/\bseries\s+([a-j])\b/i, (_s, l) => `Series ${l.toUpperCase()}`);
    if (/^(pre-seed|seed)$/i.test(facts.round)) facts.round = facts.round.toLowerCase();
  }

  // "led by X" is the reliable investor cue; "from X" too often points at a publication.
  const inv = text.match(/\bled by\s+([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,3})/);
  if (inv) {
    const name = inv[1].replace(/[,.]$/, "").trim();
    if (name && !PUBLISHER.test(name)) facts.investor = name;
  }

  // The purpose clause is the single most useful sentence for the email: it is the
  // company saying, in public, what the money is for.
  const purpose = text.match(/\bto\s+([a-z][^,.;]{8,90})\s*$/i);
  if (purpose) {
    let clause = purpose[1].replace(/\s+/g, " ").trim();
    if (isTitleCase(text)) clause = deTitleCase(clause);
    if (!NOT_A_PURPOSE.test(clause)) {
      facts.purpose = clause;
      // Remember whether this came from prose, so a merge across outlets can prefer
      // the sentence-case version of the same fact when one exists.
      facts.purposeFromProse = !isTitleCase(text);
    }
  }

  const exec = text.match(/\b(?:as|new)\s+((?:chief\s+\w+\s+officer)|(?:c[eotfmr]o)|(?:vp\s+of\s+[\w\s]{3,25})|(?:head\s+of\s+[\w\s]{3,25}))\b/i);
  if (exec) facts.execTitle = exec[1].replace(/\s+/g, " ").trim();

  // Board and leadership-team announcements are the most common "exec hire" headline
  // by volume. They are a real org-change signal, but a different one, and saying
  // "a new chief revenue officer" about a board seat would be plainly wrong.
  if (/\bto\s+(?:its\s+|the\s+)?board\b|\bboard of directors\b/i.test(text)) facts.appointmentKind = "board";
  else if (/\bleadership team\b|\bexecutive team\b/i.test(text)) facts.appointmentKind = "leadership_team";

  return facts;
}

/* ------------------------------------------------------------------ */
/* The "why now" line that becomes the email's Signal:                 */
/* ------------------------------------------------------------------ */

/**
 * Plain-English, factual, no hype. This string is copied verbatim onto the prospect as
 * `signalReason` and shown to the LLM as "Signal: ..." when Email 1 is drafted, so it
 * has to read like something a person would say out loud and must not assert anything
 * the headline did not.
 */
export function buildReason(signal: NewsSignal, facts: NewsFacts, headline: string): string {
  const { text } = cleanHeadline(headline);
  const purpose = facts.purpose ? ` to ${facts.purpose}` : "";

  if (signal === "funding_round") {
    const size = facts.amountText ? `a ${facts.amountText}` : "a new";
    const round = facts.round ? ` ${facts.round}` : " round";
    const led = facts.investor ? ` led by ${facts.investor}` : "";
    return `just closed ${size}${round}${led}${purpose}`;
  }
  if (signal === "exec_hire") {
    if (facts.execTitle) return `just brought in a new ${facts.execTitle.toLowerCase()}`;
    if (facts.appointmentKind === "board") return "just added a new board member";
    if (facts.appointmentKind === "leadership_team") return "just expanded its leadership team";
    return "just announced a new senior leader";
  }
  if (signal === "office_expansion") return `is opening a new location${purpose}`;
  if (signal === "acquisition") return "is working through an acquisition";
  if (signal === "product_launch") return `just launched something new${purpose}`;
  return text.slice(0, 140);
}

/* ------------------------------------------------------------------ */
/* Role synthesis: what the money/leader/market actually buys          */
/* ------------------------------------------------------------------ */
/*
 * curateFromPool researches the OWNER of a role, then walks up to the decision-maker.
 * News gives us no roles, so we infer the build-out the signal implies. These are
 * chosen to classify into DISTINCT job functions (see lib/signals/filters classifyTitle)
 * because the curator researches one boss PER FUNCTION: three distinct functions is
 * three real decision-makers at the same company, which is the whole per-company
 * multiplier the belt is built around.
 */

/** Function cue -> the entry role whose owner is the buyer we want. */
const BUILD_OUT: Array<{ re: RegExp; roles: string[] }> = [
  { re: /\b(gtm|go-to-market|sales|revenue|commercial|customers|market share|expansion|scale)\b/i,
    roles: ["Account Executive"] },
  { re: /\b(ai|machine learning|platform|engineering|product|r&d|technology|infrastructure|data)\b/i,
    roles: ["Software Engineer"] },
  { re: /\b(operations|supply chain|logistics|fulfillment|warehouse|network|delivery)\b/i,
    roles: ["Operations Manager"] },
  { re: /\b(clinical|patient|care|provider|health)\b/i, roles: ["Clinical Manager"] },
  { re: /\b(finance|accounting|controller|audit)\b/i, roles: ["Accounting Manager"] },
];

/** The default post-raise build-out, in the order companies actually hire it. */
const DEFAULT_ROLES = ["Account Executive", "Software Engineer", "Operations Manager"];

/**
 * Roles to research for this company, most-likely first. Any recruiter-supplied
 * `targetRoles` wins outright: their desk knows what it fills better than an inference
 * from a headline does.
 */
export function inferRoles(headline: string, facts: NewsFacts, targetRoles?: string[]): string[] {
  const explicit = (targetRoles ?? []).map((r) => r.trim()).filter(Boolean);
  if (explicit.length) return explicit.slice(0, 5);

  const hay = `${cleanHeadline(headline).text} ${facts.purpose ?? ""} ${facts.execTitle ?? ""}`;
  const led: string[] = [];
  for (const { re, roles } of BUILD_OUT) {
    if (re.test(hay)) led.push(...roles);
  }
  // Lead with what the headline pointed at, then fill with the standard build-out so
  // every company still yields the full three-function spread.
  const out: string[] = [];
  for (const r of [...led, ...DEFAULT_ROLES]) if (!out.includes(r)) out.push(r);
  return out.slice(0, 3);
}

/* ------------------------------------------------------------------ */
/* Fetch + parse the feed                                              */
/* ------------------------------------------------------------------ */

const RSS_TIMEOUT_MS = 12_000;

/* ------------------------------------------------------------------ */
/* Circuit breaker + politeness                                        */
/* ------------------------------------------------------------------ */
/*
 * Google News RSS is free and unauthenticated, which means the only thing standing
 * between us and a block is our own manners. Every news watchlist fires up to five
 * queries per poll, and the tick runs every 15 minutes, so a handful of lists is
 * thousands of requests a day from ONE server IP. Two guards:
 *
 *   1. A minimum gap between requests, so a tick never bursts.
 *   2. A breaker that OPENS on a block (429/403) or a run of failures, and stays open
 *      for an escalating cooldown. Without it, the failure mode is the worst kind: we
 *      keep hammering an endpoint that is already refusing us, guaranteeing the block
 *      sticks, while every list quietly records zero.
 *
 * While open, discovery returns immediately with a warning naming the reopen time, so
 * the list's lastError says "blocked until 14:35" rather than showing an innocent zero.
 */

const MIN_REQUEST_GAP_MS = 400;
const COOLDOWNS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
const FAILURES_BEFORE_OPEN = 3;

const breaker = {
  consecutiveFailures: 0,
  trips: 0,
  openUntil: 0,
  lastError: "",
  lastOkAt: 0,
};
let lastRequestAt = 0;

export interface NewsFeedHealth {
  open: boolean;
  openUntil?: string;
  consecutiveFailures: number;
  trips: number;
  lastError?: string;
  lastOkAt?: string;
}

/** Feed health, for the watch status endpoint and any monitor that wants it. */
export function newsFeedHealth(): NewsFeedHealth {
  return {
    open: Date.now() < breaker.openUntil,
    openUntil: breaker.openUntil ? new Date(breaker.openUntil).toISOString() : undefined,
    consecutiveFailures: breaker.consecutiveFailures,
    trips: breaker.trips,
    lastError: breaker.lastError || undefined,
    lastOkAt: breaker.lastOkAt ? new Date(breaker.lastOkAt).toISOString() : undefined,
  };
}

/** Test hook: clear breaker state so suites stay deterministic. */
export function __resetNewsFeedBreaker(): void {
  breaker.consecutiveFailures = 0;
  breaker.trips = 0;
  breaker.openUntil = 0;
  breaker.lastError = "";
  breaker.lastOkAt = 0;
  lastRequestAt = 0;
}

/** A refusal, as opposed to a transient blip. These open the breaker immediately. */
function isBlock(message: string): boolean {
  return /rss_(429|403|401|451)/.test(message);
}

function tripBreaker(message: string): void {
  breaker.lastError = message.slice(0, 160);
  breaker.consecutiveFailures += 1;
  const shouldOpen = isBlock(message) || breaker.consecutiveFailures >= FAILURES_BEFORE_OPEN;
  if (!shouldOpen) return;
  const cooldown = COOLDOWNS_MS[Math.min(breaker.trips, COOLDOWNS_MS.length - 1)];
  breaker.trips += 1;
  breaker.openUntil = Date.now() + cooldown;
}

function clearBreaker(): void {
  breaker.consecutiveFailures = 0;
  breaker.trips = 0;
  breaker.openUntil = 0;
  breaker.lastError = "";
  breaker.lastOkAt = Date.now();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getFeed(query: string): Promise<string> {
  // Politeness gap. Cheap insurance against becoming the reason we get blocked.
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RSS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/rss+xml, text/xml, */*", "User-Agent": "RecruitersOS/1.0 (+https://recruitersos.co)" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`rss_${res.status}`);
    const text = await res.text();
    clearBreaker();
    return text;
  } catch (e) {
    tripBreaker((e as Error)?.message || "rss_failed");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function tagOf(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return undefined;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() || undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");   // last, so "&amp;lt;" does not double-decode
}

export function parseFeed(xml: string): Headline[] {
  const out: Headline[] = [];
  for (const block of (xml || "").split(/<item>/).slice(1)) {
    const title = tagOf(block, "title");
    const link = tagOf(block, "link");
    if (!title || !link) continue;
    out.push({
      title: decodeEntities(title),
      link,
      publishedAt: tagOf(block, "pubDate"),
      publisher: tagOf(block, "source"),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export interface NewsDiscoverOpts {
  /** Plain-English market, e.g. "supply chain software" or "behavioral health". */
  segment: string;
  /** Which signals to hunt. Defaults to funding + exec hire, the two that convert. */
  signals?: NewsSignal[];
  /** Recency window in days (Google News `when:` operator). */
  windowDays?: number;
  /** Ignore raises smaller than this (0 = keep all). */
  minAmountUsd?: number;
  /** Roles this desk fills; overrides the inferred build-out. */
  targetRoles?: string[];
  /** Cap companies returned per run. */
  limit?: number;
  /** Wall-clock ceiling for the whole sweep. */
  timeboxMs?: number;
}

export interface NewsDiscoverResult {
  leads: InMarketLead[];
  queries: number;      // feeds pulled
  headlines: number;    // items seen
  named: number;        // headlines a company was confidently extracted from
  warnings: string[];
}

function freshnessBonus(publishedAt?: string): number {
  const at = Date.parse(publishedAt || "");
  if (!Number.isFinite(at)) return 0;
  const days = (Date.now() - at) / 86_400_000;
  if (days <= 2) return 12;
  if (days <= 7) return 8;
  if (days <= 21) return 4;
  return 0;
}

function amountBonus(amountUsd?: number): number {
  if (!amountUsd) return 0;
  if (amountUsd >= 100e6) return 14;
  if (amountUsd >= 40e6) return 11;
  if (amountUsd >= 15e6) return 8;
  if (amountUsd >= 5e6) return 5;
  return 2;
}

function normKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** True when two strings differ by at most one insert, delete, or substitution.
 *  Bounded at 1 on purpose, so it is O(n) and cannot quietly become a fuzzy matcher. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length - s.length > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (s.length === l.length) { i++; j++; } else { j++; }   // substitution vs insertion
  }
  return true;
}

/**
 * Collapse one company that two outlets spelled differently ("Conner Industries" and
 * "Connor Industries" off the same board appointment). Left alone, both survive the
 * exact-key merge, both get curated, and both get emailed — near-identical copy to a
 * company that exists once, plus a misspelt twin that will never resolve a domain.
 *
 * Deliberately narrow, because a false merge is worse than a duplicate: it silently
 * deletes a real company you would otherwise have contacted. So a pair must clear all
 * three bars — one edit apart, the SAME signal (a raise and a layoff at similar names
 * are two different stories), and a name long enough that one character is a typo
 * rather than the whole brand ("Auger" and "Augur" are plausibly two companies).
 * The higher-scoring spelling wins and absorbs the other's facts.
 */
const NEAR_DUPE_MIN_LEN = 10;
function collapseNearDuplicates<T extends { lead: InMarketLead; facts: NewsFacts; signal: NewsSignal }>(
  byCompany: Map<string, T>,
): number {
  const keys = [...byCompany.keys()].sort();          // stable order → deterministic winner
  let merged = 0;
  for (let i = 0; i < keys.length; i++) {
    const a = byCompany.get(keys[i]);
    if (!a) continue;
    for (let j = i + 1; j < keys.length; j++) {
      const b = byCompany.get(keys[j]);
      if (!b) continue;
      if (a.signal !== b.signal) continue;
      if (Math.min(keys[i].length, keys[j].length) < NEAR_DUPE_MIN_LEN) continue;
      if (!withinOneEdit(keys[i], keys[j])) continue;
      const [win, lose] = (b.lead.score ?? 0) > (a.lead.score ?? 0) ? [b, a] : [a, b];
      win.facts = { ...lose.facts, ...win.facts };     // never lose a fact the twin carried
      byCompany.delete(win === a ? keys[j] : keys[i]);
      merged++;
      if (win === b) break;                            // a is gone; stop pairing against it
    }
  }
  return merged;
}

/**
 * Run one segment across its signal queries and return de-duplicated company leads.
 * Never throws: every failure mode (feed down, blocked, garbage XML, timeout) is a
 * warning plus fewer leads, because this runs on a 15-minute timer and a thrown error
 * would take the whole tick with it.
 */
export async function discoverFromNews(opts: NewsDiscoverOpts): Promise<NewsDiscoverResult> {
  const segment = (opts.segment || "").trim();
  const result: NewsDiscoverResult = { leads: [], queries: 0, headlines: 0, named: 0, warnings: [] };
  if (!segment) {
    result.warnings.push("no segment set");
    return result;
  }

  // Breaker open: do not touch the endpoint that is already refusing us. Say so
  // explicitly, so the list shows "news feed blocked until HH:MM" instead of a zero
  // that looks like a quiet market.
  if (Date.now() < breaker.openUntil) {
    const until = new Date(breaker.openUntil).toISOString().slice(11, 16);
    result.warnings.push(`news feed backing off until ${until} UTC (${breaker.lastError || "repeated failures"})`);
    return result;
  }

  const signals = (opts.signals?.length ? opts.signals : (["funding_round", "exec_hire"] as NewsSignal[]))
    .filter((s) => NEWS_SIGNALS.includes(s));
  const windowDays = Math.min(Math.max(Math.round(opts.windowDays ?? 7), 1), 90);
  const minAmount = Math.max(0, opts.minAmountUsd ?? 0);
  const limit = Math.min(Math.max(Math.round(opts.limit ?? 40), 1), 200);
  const deadline = Date.now() + Math.min(Math.max(opts.timeboxMs ?? 30_000, 3_000), 120_000);

  // Merge every mention of the same company: a raise reported by four outlets is one
  // lead, and the richest set of facts across those four is the one worth emailing on.
  const byCompany = new Map<string, { lead: InMarketLead; facts: NewsFacts; signal: NewsSignal; at?: string; headline: string }>();

  for (const signal of signals) {
    if (Date.now() >= deadline) { result.warnings.push("timebox reached"); break; }
    // The breaker can trip mid-sweep: stop this list's remaining queries rather than
    // spending them all against an endpoint that just started refusing us.
    if (Date.now() < breaker.openUntil) {
      result.warnings.push(`news feed started refusing mid-sweep (${breaker.lastError || "blocked"})`);
      break;
    }
    const query = QUERY[signal].replace("{seg}", `"${segment}"`).replace("{win}", `${windowDays}d`);
    let items: Headline[];
    try {
      items = parseFeed(await getFeed(query));
      result.queries += 1;
    } catch (e) {
      result.warnings.push(`${signal}: ${(e as Error).message}`.slice(0, 120));
      continue;
    }
    result.headlines += items.length;

    for (const item of items) {
      // "Raises" is overloaded; make sure this is a capital event before treating it
      // as one. Done before extraction so a rejected headline costs nothing.
      if (signal === "funding_round" && !isRealRaise(item.title)) continue;

      const company = extractCompany(item.title);
      if (!company) continue;                    // unnamed headline: drop, never guess
      result.named += 1;

      const facts = extractFacts(item.title);
      if (signal === "funding_round" && minAmount > 0) {
        // A raise below the floor is out. An unstated amount is kept: plenty of real
        // rounds are announced without a number, and dropping them loses good leads.
        if (facts.amountUsd !== undefined && facts.amountUsd < minAmount) continue;
      }

      const key = normKey(company);
      if (!key) continue;
      const score = Math.min(100, BASE_SCORE[signal] + amountBonus(facts.amountUsd) + freshnessBonus(item.publishedAt));
      const existing = byCompany.get(key);
      if (existing) {
        // Keep the better-scoring mention, but never lose a fact the other one had.
        // Outlets split the story: one carries the amount, another the lead investor,
        // another what the money is for. The union of them is the strongest email.
        const keepPurpose = existing.facts.purposeFromProse || !facts.purposeFromProse;
        existing.facts = { ...facts, ...existing.facts };
        if (!keepPurpose && facts.purpose) {
          // This outlet wrote it as prose and the incumbent did not: prefer the prose.
          existing.facts.purpose = facts.purpose;
          existing.facts.purposeFromProse = true;
        }
        existing.headline = existing.headline || item.title;
        if (score > (existing.lead.score ?? 0)) {
          existing.lead.score = score;
          existing.lead.sourceUrl = item.link;
          existing.signal = signal;
          existing.at = item.publishedAt;
          existing.headline = item.title;
        }
        continue;
      }

      const roles = inferRoles(item.title, facts, opts.targetRoles);
      const reason = buildReason(signal, facts, item.title);
      const at = item.publishedAt ? new Date(Date.parse(item.publishedAt) || Date.now()).toISOString() : undefined;

      const scoreReasons = [`News signal: ${signal.replace(/_/g, " ")}`];
      if (facts.amountText) scoreReasons.push(`Raise size ${facts.amountText}`);
      if (facts.investor) scoreReasons.push(`Investor ${facts.investor}`);
      if (item.publisher) scoreReasons.push(`Reported by ${item.publisher}`);

      byCompany.set(key, {
        signal,
        facts,
        at: item.publishedAt,
        headline: item.title,
        lead: {
          // Same namespace as the job feed, so the global seen-set treats one company
          // as one company no matter which front end found it first.
          id: companyKey(company),
          company,
          industry: segment,
          reason,
          signalType: signal,
          score,
          scoreReasons,
          roles,
          roleDetails: roles.map((title) => ({ title })),
          sourceUrl: item.link,
          signalAt: at,
          postedAt: at,
        },
      });
    }
  }

  // One company, two spellings, is still one company. Collapse before the reasons are
  // rebuilt so the survivor's copy is written from the union of both outlets' facts.
  const collapsed = collapseNearDuplicates(byCompany);
  if (collapsed > 0) result.warnings.push(`merged ${collapsed} near-duplicate company name(s)`);

  // Rebuild the reason AFTER merging, so it reflects every fact any outlet carried.
  // Built at first sighting it would freeze on whichever article happened to be first,
  // which is how Freehand's lead investor and stated purpose went missing from the copy.
  result.leads = [...byCompany.values()]
    .map((v) => {
      v.lead.reason = buildReason(v.signal, v.facts, v.headline);
      // Carry the merged evidence, not just the prose, so the copy layer can tell a
      // board seat from an operating hire without re-parsing the sentence back.
      v.lead.newsFacts = v.facts;
      if (v.facts.investor && !v.lead.scoreReasons.some((r) => r.startsWith("Investor "))) {
        v.lead.scoreReasons.push(`Investor ${v.facts.investor}`);
      }
      if (v.facts.amountText && !v.lead.scoreReasons.some((r) => r.startsWith("Raise size "))) {
        v.lead.scoreReasons.push(`Raise size ${v.facts.amountText}`);
      }
      return v.lead;
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
  return result;
}

/** Internals exposed for the deterministic test suite only (scripts/test-news-neardupe.mts).
 *  Not part of the module's public surface — import `discoverFromNews` instead. */
export const __test = { withinOneEdit, collapseNearDuplicates };
