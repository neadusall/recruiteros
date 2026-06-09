/**
 * RecruiterOS · Signal Engine
 * Free / public signal connectors — the cheapest possible signal coverage.
 *
 * Goal: get as many hiring signals as possible for $0. These connectors hit public,
 * unauthenticated (or free-tier) endpoints only. Stacked with the built-ins in
 * ./sources (PublicAtsSource, EdgarSource, WarnNoticeSource), they cover the full
 * company-side picture — who is hiring, who just raised, who is expanding, who is
 * cutting — without touching a paid data provider. Paid contact enrichment only happens
 * later, in the waterfall, and only for the targets that survive filtering.
 *
 * Every connector returns normalized `Signal`s via `makeSignal`, so resolution, dedupe,
 * scoring, and the velocity roll-up downstream treat them identically to any other
 * source. Each is independently configured and degrades gracefully on failure.
 *
 * Coverage map (all free):
 *   Workable / SmartRecruiters / Recruitee / Ashby boards → job_posting, hiring_velocity
 *   RemoteOK / Remotive                                   → job_posting (remote)
 *   Hacker News "Who is hiring"                            → job_posting, hiring_velocity
 *   USAspending.gov                                        → grant_or_contract
 *   GitHub org activity                                    → headcount_growth, tech_stack_change
 *   News/RSS (Google News, press feeds)                    → funding_round, exec_hire, layoff,
 *                                                            office_expansion, market_entry, m&a
 *   layoffs.fyi-style feed                                 → layoff, employer_distress
 */

import type { PullResult, Signal, SignalType, SourceKind } from "./types";
import type { SignalSource, PullContext } from "./sources";
import { makeSignal, getJson } from "./sources";

/* ------------------------------------------------------------------ */
/* More public ATS boards (Workable / SmartRecruiters / Recruitee)     */
/* ------------------------------------------------------------------ */

/**
 * Extends ATS coverage beyond Greenhouse/Lever/Ashby. These three publish open roles as
 * public JSON keyed by company slug, no auth. Together with PublicAtsSource this covers
 * the large majority of startup + scale-up hiring at zero cost.
 */
export class ExtraAtsSource implements SignalSource {
  readonly id = "extra_ats";
  readonly kind: SourceKind = "ats_public";
  readonly emits: SignalType[] = ["job_posting", "hiring_velocity", "evergreen_role"];
  readonly label = "Public ATS boards (Workable · SmartRecruiters · Recruitee)";

  isConfigured(): boolean {
    return true;
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const slugs = (ctx.watchlist?.companyNames ?? []).slice(0, ctx.limit ?? 50);
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];

    for (const slug of slugs) {
      try {
        const roles = await this.fetchAny(slug);
        for (const r of roles) {
          signals.push(
            makeSignal({
              type: "job_posting",
              title: `${slug} is hiring: ${r.title}`,
              detail: `Open role "${r.title}"${r.location ? ` in ${r.location}` : ""} (${r.ats}). Direct hiring intent.`,
              evidence: { roleTitle: r.title, location: r.location, function: r.department, applyUrl: r.url, ats: r.ats },
              source: { kind: this.kind, connector: this.id, url: r.url, externalId: `${slug}:${r.id}`, observedAt: now },
              eventAt: r.postedAt ?? now,
              ingestedAt: now,
              anchor: slug,
              companyHint: { id: "", name: slug },
            }),
          );
        }
      } catch (err) {
        warnings.push(`extra-ats "${slug}": ${(err as Error).message}`);
      }
    }
    return { signals, warnings };
  }

  private async fetchAny(slug: string): Promise<NormalizedRole[]> {
    // Workable public board
    try {
      const wk = await getJson<{ jobs: WorkableJob[] }>(
        `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
      );
      if (wk.jobs?.length) {
        return wk.jobs.map((j) => ({
          id: j.shortcode, title: j.title, location: j.location?.location_str,
          department: j.department, url: j.url, postedAt: j.published_on, ats: "Workable",
        }));
      }
    } catch { /* next */ }
    // SmartRecruiters public postings
    try {
      const sr = await getJson<{ content: SmartRecruitersJob[] }>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`,
      );
      if (sr.content?.length) {
        return sr.content.map((j) => ({
          id: j.id, title: j.name, location: j.location?.city,
          department: j.department?.label, url: j.ref, postedAt: j.releasedDate, ats: "SmartRecruiters",
        }));
      }
    } catch { /* next */ }
    // Recruitee public offers
    const rc = await getJson<{ offers: RecruiteeOffer[] }>(
      `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
    );
    return (rc.offers ?? []).map((o) => ({
      id: String(o.id), title: o.title, location: o.location,
      department: o.department, url: o.careers_url, postedAt: o.published_at, ats: "Recruitee",
    }));
  }
}

interface NormalizedRole {
  id: string; title: string; location?: string; department?: string;
  url?: string; postedAt?: string; ats: string;
}
interface WorkableJob { shortcode: string; title: string; department?: string; url: string; published_on?: string; location?: { location_str?: string } }
interface SmartRecruitersJob { id: string; name: string; ref: string; releasedDate?: string; department?: { label?: string }; location?: { city?: string } }
interface RecruiteeOffer { id: number; title: string; location?: string; department?: string; careers_url: string; published_at?: string }

/* ------------------------------------------------------------------ */
/* Remote job boards (RemoteOK / Remotive) — free JSON                 */
/* ------------------------------------------------------------------ */

/** Free remote-job feeds. Good for remote-first ICPs; both publish open JSON. */
export class RemoteBoardsSource implements SignalSource {
  readonly id = "remote_boards";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Remote job boards (RemoteOK · Remotive)";

  isConfigured(): boolean {
    return true;
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));

    try {
      const rm = await getJson<RemotiveJob[] | { jobs: RemotiveJob[] }>("https://remotive.com/api/remote-jobs");
      const jobs = Array.isArray(rm) ? rm : rm.jobs ?? [];
      for (const j of jobs.slice(0, ctx.limit ?? 100)) {
        if (!want(`${j.title} ${j.company_name}`)) continue;
        signals.push(
          makeSignal({
            type: "job_posting",
            title: `${j.company_name} is hiring (remote): ${j.title}`,
            detail: `Remote role "${j.title}"${j.category ? ` · ${j.category}` : ""}.`,
            evidence: { roleTitle: j.title, function: j.category, location: "Remote", applyUrl: j.url, remote: true },
            source: { kind: this.kind, connector: "remotive", url: j.url, externalId: `remotive:${j.id}`, observedAt: now },
            eventAt: j.publication_date ?? now,
            ingestedAt: now,
            anchor: j.company_name,
            companyHint: { id: "", name: j.company_name, hiringLocations: [{ raw: "Remote", remote: true }] },
          }),
        );
      }
    } catch (err) {
      warnings.push(`remotive: ${(err as Error).message}`);
    }
    return { signals, warnings };
  }
}
interface RemotiveJob { id: number; title: string; company_name: string; category?: string; url: string; publication_date?: string }

/* ------------------------------------------------------------------ */
/* Hacker News "Who is hiring" — free Algolia + Firebase APIs          */
/* ------------------------------------------------------------------ */

/**
 * The monthly "Ask HN: Who is hiring?" thread is a dense, free, high-signal list of
 * companies actively hiring, with role + location inline in each top-level comment.
 * Uses the free HN Algolia search API to find the latest thread, then its children.
 */
export class HackerNewsHiringSource implements SignalSource {
  readonly id = "hn_hiring";
  readonly kind: SourceKind = "social";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = 'Hacker News "Who is hiring"';

  isConfigured(): boolean {
    return true;
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    try {
      const search = await getJson<{ hits: Array<{ objectID: string; title: string }> }>(
        "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring",
      );
      const thread = search.hits?.[0];
      if (!thread) return { signals, warnings: ["no HN hiring thread found"] };
      const item = await getJson<{ kids?: number[] }>(`https://hacker-news.firebaseio.com/v0/item/${thread.objectID}.json`);
      const kids = (item.kids ?? []).slice(0, ctx.limit ?? 60);
      const comments = await Promise.all(
        kids.map((id) => getJson<HnComment>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)),
      );
      for (const c of comments) {
        if (!c?.text) continue;
        const text = stripHtml(c.text);
        if (kw.length && !kw.some((k) => text.toLowerCase().includes(k))) continue;
        const company = text.split(/[|\n]/)[0].slice(0, 80).trim();
        signals.push(
          makeSignal({
            type: "job_posting",
            title: `Hiring (HN): ${company}`,
            detail: text.slice(0, 240),
            evidence: { roleTitle: extractRole(text), source: "HN who-is-hiring", remote: /remote/i.test(text) },
            source: { kind: this.kind, connector: this.id, url: `https://news.ycombinator.com/item?id=${c.id}`, externalId: `hn:${c.id}`, observedAt: now },
            eventAt: now,
            ingestedAt: now,
            anchor: company,
            companyHint: { id: "", name: company },
          }),
        );
      }
    } catch (err) {
      warnings.push(`hn: ${(err as Error).message}`);
    }
    return { signals, warnings };
  }
}
interface HnComment { id: number; text?: string }
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&#x2F;/g, "/").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function extractRole(text: string): string | undefined {
  const m = text.match(/\b(engineer|developer|designer|manager|lead|director|scientist|recruiter|sales|marketing|analyst)\b/i);
  return m ? m[0] : undefined;
}

/* ------------------------------------------------------------------ */
/* USAspending.gov — free federal award / contract data                */
/* ------------------------------------------------------------------ */

/**
 * Federal contract + grant awards (free, official). A new award is a strong
 * grant_or_contract signal: the recipient must staff up to deliver, often on a clock.
 */
export class UsaSpendingSource implements SignalSource {
  readonly id = "usaspending";
  readonly kind: SourceKind = "gov_filing";
  readonly emits: SignalType[] = ["grant_or_contract"];
  readonly label = "USAspending.gov federal awards";

  isConfigured(): boolean {
    return true;
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    try {
      const res = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          filters: {
            award_type_codes: ["A", "B", "C", "D"],
            keywords: ctx.watchlist?.keywords?.length ? ctx.watchlist.keywords : undefined,
          },
          fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date"],
          limit: ctx.limit ?? 50,
          sort: "Award Amount",
          order: "desc",
        }),
      });
      if (!res.ok) throw new Error(`USAspending ${res.status}`);
      const data = (await res.json()) as { results?: UsaAward[] };
      for (const a of data.results ?? []) {
        signals.push(
          makeSignal({
            type: "grant_or_contract",
            title: `${a["Recipient Name"]} won a federal award`,
            detail: `${a["Awarding Agency"]} awarded ${formatUsd(a["Award Amount"])}. Staffing to deliver is likely.`,
            evidence: { amountUsd: a["Award Amount"], agency: a["Awarding Agency"], awardId: a["Award ID"], startedAt: a["Start Date"] },
            source: { kind: this.kind, connector: this.id, externalId: `usa:${a["Award ID"]}`, observedAt: now },
            eventAt: a["Start Date"] ?? now,
            ingestedAt: now,
            anchor: a["Recipient Name"],
            companyHint: { id: "", name: a["Recipient Name"] },
          }),
        );
      }
    } catch (err) {
      warnings.push(`usaspending: ${(err as Error).message}`);
    }
    return { signals, warnings };
  }
}
interface UsaAward {
  "Award ID": string; "Recipient Name": string; "Award Amount": number;
  "Awarding Agency": string; "Start Date"?: string;
}
function formatUsd(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n}`;
}

/* ------------------------------------------------------------------ */
/* GitHub — free API for org growth + tech-stack tells                 */
/* ------------------------------------------------------------------ */

/**
 * GitHub's REST API (free, optional token raises rate limits) reveals an org's public
 * repo + member activity. A jump in members or new repos is a headcount_growth /
 * tech_stack_change tell for engineering-led companies.
 */
export class GitHubOrgSource implements SignalSource {
  readonly id = "github_org";
  readonly kind: SourceKind = "company_graph";
  readonly emits: SignalType[] = ["headcount_growth", "tech_stack_change"];
  readonly label = "GitHub org activity";

  private token = process.env.GITHUB_TOKEN ?? "";

  isConfigured(): boolean {
    return true; // works unauthenticated, just lower rate limits
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const orgs = (ctx.watchlist?.companyNames ?? []).slice(0, ctx.limit ?? 30);
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    for (const org of orgs) {
      try {
        const repos = await getJson<GitHubRepo[]>(
          `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?sort=pushed&per_page=10`,
          { headers },
        );
        const langs = [...new Set(repos.map((r) => r.language).filter(Boolean))] as string[];
        if (langs.length) {
          signals.push(
            makeSignal({
              type: "tech_stack_change",
              title: `${org} active on ${langs.slice(0, 3).join(", ")}`,
              detail: `Recent public GitHub activity across ${langs.slice(0, 5).join(", ")}. Useful for stack-matched targeting.`,
              evidence: { technology: langs, detectedAt: now, repoCount: repos.length },
              source: { kind: this.kind, connector: this.id, url: `https://github.com/${org}`, externalId: `gh:${org}:stack`, observedAt: now },
              eventAt: repos[0]?.pushed_at ?? now,
              ingestedAt: now,
              anchor: org,
              companyHint: { id: "", name: org, techStack: langs },
            }),
          );
        }
      } catch (err) {
        warnings.push(`github "${org}": ${(err as Error).message}`);
      }
    }
    return { signals, warnings };
  }
}
interface GitHubRepo { language?: string | null; pushed_at?: string }

/* ------------------------------------------------------------------ */
/* News / RSS — free Google News RSS for the soft, narrative signals    */
/* ------------------------------------------------------------------ */

/**
 * Google News RSS (free, no key) covers the signals that only show up in prose: funding
 * announcements, exec hires, layoffs, expansions, M&A. One query per signal-type maps
 * the headline to the right `SignalType`. Parsing is minimal-dependency (regex over the
 * RSS XML) to avoid adding an XML lib.
 */
export class NewsRssSource implements SignalSource {
  readonly id = "news_rss";
  readonly kind: SourceKind = "news";
  readonly emits: SignalType[] = [
    "funding_round", "exec_hire", "layoff", "office_expansion", "market_entry", "acquisition",
  ];
  readonly label = "News (Google News RSS)";

  isConfigured(): boolean {
    return true;
  }

  /** Query templates per signal type; {co} is filled from the watchlist when present. */
  private queries: Array<{ type: SignalType; q: string }> = [
    { type: "funding_round", q: "{co} raises funding round" },
    { type: "exec_hire", q: "{co} appoints new VP OR CTO OR chief" },
    { type: "layoff", q: "{co} layoffs OR job cuts" },
    { type: "office_expansion", q: "{co} opens new office OR expansion" },
    { type: "market_entry", q: "{co} expands into OR enters market" },
    { type: "acquisition", q: "{co} acquired OR acquisition" },
  ];

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const cos = ctx.watchlist?.companyNames?.length ? ctx.watchlist.companyNames : [""];

    for (const co of cos.slice(0, 10)) {
      for (const { type, q } of this.queries) {
        const query = q.replace("{co}", co).replace(/\s+/g, " ").trim();
        try {
          const xml = await getText(
            `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
          );
          for (const item of parseRssItems(xml).slice(0, 5)) {
            signals.push(
              makeSignal({
                type,
                title: item.title,
                detail: `${item.title} (${item.source ?? "news"}).`,
                evidence: { announcedAt: item.pubDate, url: item.link },
                source: { kind: this.kind, connector: this.id, url: item.link, externalId: `news:${hash(item.link)}`, observedAt: now },
                eventAt: item.pubDate ?? now,
                ingestedAt: now,
                anchor: co || item.title.split(/\s+/).slice(0, 2).join(" "),
                companyHint: co ? { id: "", name: co } : undefined,
              }),
            );
          }
        } catch (err) {
          warnings.push(`news "${query}": ${(err as Error).message}`);
        }
      }
    }
    return { signals, warnings };
  }
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: "application/rss+xml, text/xml, */*" } });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  return res.text();
}
interface RssItem { title: string; link: string; pubDate?: string; source?: string }
function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.split(/<item>/).slice(1);
  for (const b of blocks) {
    const title = tag(b, "title");
    const link = tag(b, "link");
    if (!title || !link) continue;
    items.push({ title: decode(title), link, pubDate: tag(b, "pubDate"), source: tag(b, "source") });
  }
  return items;
}
function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return undefined;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() || undefined;
}
function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}
/** Coerce a pubDate (ISO string or unix seconds/millis) to an ISO string. */
function toIso(v: unknown, fallback: string): string {
  if (typeof v === "string" && v) return v;
  if (typeof v === "number" && isFinite(v)) {
    try { return new Date(v > 1e12 ? v : v * 1000).toISOString(); } catch { return fallback; }
  }
  return fallback;
}
/** Tiny stable string hash (djb2) for dedupe ids — deterministic, no randomness. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ------------------------------------------------------------------ */
/* Product Hunt — free public RSS for product-launch signals           */
/* ------------------------------------------------------------------ */

/**
 * Product Hunt's public RSS (free, no key) surfaces new product launches. A launch is a
 * product_launch signal: a company shipping something new usually needs people to build
 * and sell it. Good leading indicator for early-stage BD targeting.
 */
export class ProductHuntSource implements SignalSource {
  readonly id = "product_hunt";
  readonly kind: SourceKind = "social";
  readonly emits: SignalType[] = ["product_launch"];
  readonly label = "Product Hunt launches";

  isConfigured(): boolean {
    return true;
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    try {
      const xml = await getText("https://www.producthunt.com/feed");
      for (const item of parseRssItems(xml).slice(0, ctx.limit ?? 40)) {
        if (kw.length && !kw.some((k) => item.title.toLowerCase().includes(k))) continue;
        const name = item.title.split(/[-–—:|]/)[0].trim();
        signals.push(
          makeSignal({
            type: "product_launch",
            title: `${name} launched on Product Hunt`,
            detail: `${item.title}. A new launch usually means a team to build and sell it.`,
            evidence: { product: name, launchedAt: item.pubDate, url: item.link },
            source: { kind: this.kind, connector: this.id, url: item.link, externalId: `ph:${hash(item.link)}`, observedAt: now },
            eventAt: item.pubDate ?? now,
            ingestedAt: now,
            anchor: name,
            companyHint: { id: "", name },
          }),
        );
      }
    } catch (err) {
      warnings.push(`producthunt: ${(err as Error).message}`);
    }
    return { signals, warnings };
  }
}

/* ------------------------------------------------------------------ */
/* Layoffs aggregate (layoffs.fyi-style) — free community feed         */
/* ------------------------------------------------------------------ */

/**
 * A layoffs aggregate feed (point LAYOFFS_FEED_URL at a layoffs.fyi mirror, a community
 * JSON export, or your own scraper). Complements the official WARN connector with the
 * faster, broader, non-US-only coverage that community trackers provide. Emits both the
 * company-side `layoff` and, for named individuals when present, `employer_distress`.
 */
export class LayoffsFeedSource implements SignalSource {
  readonly id = "layoffs_feed";
  readonly kind: SourceKind = "news";
  readonly emits: SignalType[] = ["layoff", "employer_distress"];
  readonly label = "Layoffs aggregate (layoffs.fyi-style)";

  private feedUrl = process.env.LAYOFFS_FEED_URL ?? "";

  isConfigured(): boolean {
    return Boolean(this.feedUrl);
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    if (!this.isConfigured()) return { signals: [], warnings: ["LAYOFFS_FEED_URL not configured"] };
    const now = new Date().toISOString();
    const rows = await getJson<LayoffRow[]>(this.feedUrl);
    const signals = rows.slice(0, ctx.limit ?? 100).map((r) =>
      makeSignal({
        type: "layoff",
        title: `${r.company} cut ${r.count ?? "staff"}${r.location ? ` in ${r.location}` : ""}`,
        detail: `${r.company} reduced headcount${r.percent ? ` by ${r.percent}%` : ""}${r.industry ? ` (${r.industry})` : ""}. Strong people now reachable.`,
        evidence: { affectedCount: r.count, reductionPct: r.percent, functions: r.functions, announcedAt: r.date, industry: r.industry },
        source: { kind: this.kind, connector: this.id, url: r.source, externalId: `layoff:${hash(`${r.company}:${r.date}`)}`, observedAt: now },
        eventAt: r.date ?? now,
        ingestedAt: now,
        anchor: r.company,
        companyHint: { id: "", name: r.company, industry: r.industry },
      }),
    );
    return { signals };
  }
}
interface LayoffRow {
  company: string; count?: number; percent?: number; location?: string;
  industry?: string; functions?: string[]; date?: string; source?: string;
}

/* ------------------------------------------------------------------ */
/* Global free job APIs (no key) — broad, cross-company hiring feeds    */
/* These don't need a watchlist: they return who is hiring across the    */
/* whole market, and several carry industry/category so the in-market    */
/* industry filter can classify non-tech roles too.                      */
/* ------------------------------------------------------------------ */

/** Arbeitnow public job board API — free, no auth. Strong EU + remote coverage; carries
 *  tags + job types we use for keyword/industry classification. */
export class ArbeitnowSource implements SignalSource {
  readonly id = "arbeitnow";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Arbeitnow job board (free API)";
  isConfigured(): boolean { return true; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));
    try {
      const res = await getJson<{ data: ArbeitnowJob[] }>("https://www.arbeitnow.com/api/job-board-api");
      for (const j of (res.data ?? []).slice(0, ctx.limit ?? 100)) {
        if (!j.company_name || !j.title) continue;
        if (!want(`${j.title} ${j.company_name} ${(j.tags ?? []).join(" ")}`)) continue;
        signals.push(makeSignal({
          type: "job_posting",
          title: `${j.company_name} is hiring: ${j.title}`,
          detail: `Open role "${j.title}"${j.location ? ` in ${j.location}` : ""}${j.remote ? " · remote" : ""}.`,
          evidence: { roleTitle: j.title, location: j.location, applyUrl: j.url, tags: j.tags, remote: j.remote },
          source: { kind: this.kind, connector: "arbeitnow", url: j.url, externalId: `arbeitnow:${j.slug}`, observedAt: now },
          eventAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : now,
          ingestedAt: now,
          anchor: j.company_name,
          companyHint: { id: "", name: j.company_name, industry: (j.tags ?? [])[0] },
        }));
      }
    } catch (err) { warnings.push(`arbeitnow: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface ArbeitnowJob { slug: string; company_name: string; title: string; tags?: string[]; job_types?: string[]; location?: string; url: string; remote?: boolean; created_at?: number }

/** Jobicy remote-jobs API — free, no auth. Carries jobIndustry, mapped onto the company
 *  so the industry filter classifies these roles accurately. */
export class JobicySource implements SignalSource {
  readonly id = "jobicy";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Jobicy remote jobs (free API)";
  isConfigured(): boolean { return true; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));
    try {
      const count = Math.min(ctx.limit ?? 50, 50);
      const res = await getJson<{ jobs: JobicyJob[] }>(`https://jobicy.com/api/v2/remote-jobs?count=${count}`);
      for (const j of res.jobs ?? []) {
        if (!j.companyName || !j.jobTitle) continue;
        const industry = Array.isArray(j.jobIndustry) ? j.jobIndustry[0] : j.jobIndustry;
        if (!want(`${j.jobTitle} ${j.companyName} ${industry ?? ""}`)) continue;
        signals.push(makeSignal({
          type: "job_posting",
          title: `${j.companyName} is hiring (remote): ${j.jobTitle}`,
          detail: `Remote role "${j.jobTitle}"${industry ? ` · ${industry}` : ""}${j.jobGeo ? ` · ${j.jobGeo}` : ""}.`,
          evidence: { roleTitle: j.jobTitle, function: industry, location: j.jobGeo || "Remote", applyUrl: j.url, remote: true },
          source: { kind: this.kind, connector: "jobicy", url: j.url, externalId: `jobicy:${j.id}`, observedAt: now },
          eventAt: j.pubDate ?? now,
          ingestedAt: now,
          anchor: j.companyName,
          companyHint: { id: "", name: j.companyName, industry, hiringLocations: [{ raw: j.jobGeo || "Remote", remote: true }] },
        }));
      }
    } catch (err) { warnings.push(`jobicy: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface JobicyJob { id: number | string; url: string; jobTitle: string; companyName: string; jobIndustry?: string[] | string; jobGeo?: string; pubDate?: string }

/** The Muse public jobs API — free, no key. Broad CROSS-INDUSTRY coverage (not just tech)
 *  with category + company, which is the strongest free signal for non-tech sectors. */
export class TheMuseSource implements SignalSource {
  readonly id = "themuse";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "The Muse jobs (free API)";
  isConfigured(): boolean { return true; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));
    const pages = Math.min(Math.ceil((ctx.limit ?? 60) / 20), 4);
    try {
      for (let page = 0; page < pages; page++) {
        const res = await getJson<{ results: MuseJob[] }>(`https://www.themuse.com/api/public/jobs?page=${page}`);
        for (const j of res.results ?? []) {
          const company = j.company?.name;
          if (!company || !j.name) continue;
          const cat = (j.categories ?? [])[0]?.name;
          const loc = (j.locations ?? [])[0]?.name;
          if (!want(`${j.name} ${company} ${cat ?? ""}`)) continue;
          signals.push(makeSignal({
            type: "job_posting",
            title: `${company} is hiring: ${j.name}`,
            detail: `Open role "${j.name}"${cat ? ` · ${cat}` : ""}${loc ? ` in ${loc}` : ""}.`,
            evidence: { roleTitle: j.name, function: cat, location: loc, applyUrl: j.refs?.landing_page },
            source: { kind: this.kind, connector: "themuse", url: j.refs?.landing_page, externalId: `themuse:${j.id ?? j.name}`, observedAt: now },
            eventAt: j.publication_date ?? now,
            ingestedAt: now,
            anchor: company,
            companyHint: { id: "", name: company, industry: cat },
          }));
        }
      }
    } catch (err) { warnings.push(`themuse: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface MuseJob { id?: number; name: string; company?: { name: string }; categories?: { name: string }[]; locations?: { name: string }[]; publication_date?: string; refs?: { landing_page?: string } }

/** Himalayas remote-jobs API — free, NO key/auth. Carries categories + salary +
 *  company; categories map onto the company for the industry filter. */
export class HimalayasSource implements SignalSource {
  readonly id = "himalayas";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Himalayas remote jobs (free API)";
  isConfigured(): boolean { return true; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));
    try {
      const limit = Math.min(ctx.limit ?? 100, 100);
      const res = await getJson<{ jobs: HimalayasJob[] }>(`https://himalayas.app/jobs/api?limit=${limit}`);
      for (const j of res.jobs ?? []) {
        if (!j.companyName || !j.title) continue;
        const cat = (j.categories ?? [])[0] ?? (j.parentCategories ?? [])[0];
        if (!want(`${j.title} ${j.companyName} ${cat ?? ""}`)) continue;
        const loc = (j.locationRestrictions ?? [])[0];
        signals.push(makeSignal({
          type: "job_posting",
          title: `${j.companyName} is hiring (remote): ${j.title}`,
          detail: `Remote role "${j.title}"${cat ? ` · ${cat}` : ""}${loc ? ` · ${loc}` : ""}.`,
          evidence: { roleTitle: j.title, function: cat, location: loc || "Remote", applyUrl: j.applicationLink, remote: true },
          source: { kind: this.kind, connector: "himalayas", url: j.applicationLink, externalId: `himalayas:${j.guid ?? j.title}`, observedAt: now },
          eventAt: toIso(j.pubDate, now),
          ingestedAt: now,
          anchor: j.companyName,
          companyHint: { id: "", name: j.companyName, industry: cat, hiringLocations: [{ raw: loc || "Remote", remote: true }] },
        }));
      }
    } catch (err) { warnings.push(`himalayas: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface HimalayasJob { title: string; companyName: string; categories?: string[]; parentCategories?: string[]; locationRestrictions?: string[]; applicationLink?: string; pubDate?: string | number; guid?: string }

/** Working Nomads jobs feed — free, NO key/auth. Top-level array with company +
 *  category, classifies onto the company. */
export class WorkingNomadsSource implements SignalSource {
  readonly id = "working_nomads";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Working Nomads jobs (free API)";
  isConfigured(): boolean { return true; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));
    try {
      const res = await getJson<WnJob[]>("https://www.workingnomads.com/api/exposed_jobs/");
      for (const j of (Array.isArray(res) ? res : []).slice(0, ctx.limit ?? 100)) {
        if (!j.company_name || !j.title) continue;
        if (!want(`${j.title} ${j.company_name} ${j.category_name ?? ""} ${j.tags ?? ""}`)) continue;
        signals.push(makeSignal({
          type: "job_posting",
          title: `${j.company_name} is hiring: ${j.title}`,
          detail: `Remote role "${j.title}"${j.category_name ? ` · ${j.category_name}` : ""}${j.location ? ` · ${j.location}` : ""}.`,
          evidence: { roleTitle: j.title, function: j.category_name, location: j.location || "Remote", applyUrl: j.url, remote: true },
          source: { kind: this.kind, connector: "working_nomads", url: j.url, externalId: `wn:${j.url}`, observedAt: now },
          eventAt: toIso(j.pub_date, now),
          ingestedAt: now,
          anchor: j.company_name,
          companyHint: { id: "", name: j.company_name, industry: j.category_name },
        }));
      }
    } catch (err) { warnings.push(`working_nomads: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface WnJob { url: string; title: string; company_name: string; category_name?: string; tags?: string; location?: string; pub_date?: string }

/** We Work Remotely RSS — free, NO key/auth (attribution required). Title is
 *  "Company: Role"; region + category give location + function. */
export class WeWorkRemotelySource implements SignalSource {
  readonly id = "wework_remotely";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "We Work Remotely (free RSS)";
  isConfigured(): boolean { return true; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));
    try {
      const xml = await getText("https://weworkremotely.com/remote-jobs.rss");
      for (const b of xml.split(/<item>/).slice(1, (ctx.limit ?? 100) + 1)) {
        const rawTitle = tag(b, "title"); const link = tag(b, "link");
        if (!rawTitle || !link) continue;
        const t = decode(rawTitle);
        const idx = t.indexOf(": ");
        if (idx <= 0) continue;
        const company = t.slice(0, idx); const role = t.slice(idx + 2);
        const region = tag(b, "region"); const cat = tag(b, "category");
        if (!want(`${role} ${company} ${cat ?? ""}`)) continue;
        signals.push(makeSignal({
          type: "job_posting",
          title: `${company} is hiring (remote): ${role}`,
          detail: `Remote role "${role}"${cat ? ` · ${cat}` : ""}${region ? ` · ${region}` : ""}.`,
          evidence: { roleTitle: role, function: cat, location: region || "Remote", applyUrl: link, remote: true },
          source: { kind: this.kind, connector: "wework_remotely", url: link, externalId: `wwr:${tag(b, "guid") ?? link}`, observedAt: now },
          eventAt: tag(b, "pubDate") ?? now,
          ingestedAt: now,
          anchor: company,
          companyHint: { id: "", name: company, industry: cat },
        }));
      }
    } catch (err) { warnings.push(`wework_remotely: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}

/** Jobspresso RSS — free, NO key/auth. Company is in <dc:creator>; we strip the
 *  trailing location to get a clean company name. */
export class JobspressoSource implements SignalSource {
  readonly id = "jobspresso";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Jobspresso (free RSS)";
  isConfigured(): boolean { return true; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));
    try {
      const xml = await getText("https://jobspresso.co/feed/?post_type=job_listing");
      for (const b of xml.split(/<item>/).slice(1, (ctx.limit ?? 100) + 1)) {
        const title = tag(b, "title"); const link = tag(b, "link");
        if (!title || !link) continue;
        const creator = tag(b, "dc:creator");
        const company = creator ? decode(creator).split(/<br|⚲|\n/i)[0].replace(/&nbsp;/g, " ").trim() : undefined;
        if (!company) continue;
        const role = decode(title);
        if (!want(`${role} ${company}`)) continue;
        signals.push(makeSignal({
          type: "job_posting",
          title: `${company} is hiring: ${role}`,
          detail: `Open role "${role}" (remote, via Jobspresso).`,
          evidence: { roleTitle: role, applyUrl: link, remote: true },
          source: { kind: this.kind, connector: "jobspresso", url: link, externalId: `jobspresso:${tag(b, "guid") ?? link}`, observedAt: now },
          eventAt: tag(b, "pubDate") ?? now,
          ingestedAt: now,
          anchor: company,
          companyHint: { id: "", name: company },
        }));
      }
    } catch (err) { warnings.push(`jobspresso: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}

/** Adzuna job aggregator — millions of listings across many countries with SALARY
 *  and a clean category label (great for non-tech industry classification). Free tier,
 *  needs an app id + key (read from env; never committed). Configured only when both
 *  ADZUNA_APP_ID and ADZUNA_APP_KEY are present, otherwise skipped. */
export class AdzunaSource implements SignalSource {
  readonly id = "adzuna";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Adzuna job aggregator (free key)";
  isConfigured(): boolean { return !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY); }

  async pull(ctx: PullContext): Promise<PullResult> {
    const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
    if (!id || !key) return { signals: [], warnings: [] };
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const country = (process.env.ADZUNA_COUNTRY || "us").toLowerCase();
    const kw = (ctx.watchlist?.keywords ?? []);
    const what = kw.length ? `&what=${encodeURIComponent(kw.join(" "))}` : "";
    const perPage = 50;                                   // Adzuna's max page size
    const pages = Math.min(Math.max(Math.ceil((ctx.limit ?? 50) / perPage), 1), 4); // up to 200
    try {
      for (let page = 1; page <= pages; page++) {
        const url =
          `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?app_id=${id}&app_key=${key}` +
          `&results_per_page=${perPage}&content-type=application/json${what}`;
        const res = await getJson<{ results: AdzunaJob[] }>(url);
        const rows = res.results ?? [];
        if (!rows.length) break;                          // no more pages
        for (const j of rows) {
          const company = j.company?.display_name;
          const title = (j.title ?? "").replace(/<[^>]+>/g, "").trim();
          if (!company || !title) continue;
          const cat = j.category?.label;
          const loc = j.location?.display_name;
          signals.push(makeSignal({
            type: "job_posting",
            title: `${company} is hiring: ${title}`,
            detail: `Open role "${title}"${cat ? ` · ${cat}` : ""}${loc ? ` in ${loc}` : ""}.`,
            evidence: { roleTitle: title, function: cat, location: loc, applyUrl: j.redirect_url, salaryMin: j.salary_min, salaryMax: j.salary_max },
            source: { kind: this.kind, connector: "adzuna", url: j.redirect_url, externalId: `adzuna:${j.id}`, observedAt: now },
            eventAt: j.created ?? now,
            ingestedAt: now,
            anchor: company,
            companyHint: { id: "", name: company, industry: cat },
          }));
        }
      }
    } catch (err) { warnings.push(`adzuna: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface AdzunaJob { id: string; title?: string; company?: { display_name?: string }; location?: { display_name?: string }; category?: { label?: string; tag?: string }; created?: string; redirect_url?: string; salary_min?: number; salary_max?: number }

/** RemoteOK public API — free, NO key/auth (attribution required, sent via User-Agent).
 *  A dense, fast-refreshing remote-jobs feed with company + tags we use for industry
 *  classification. The first array element is a legal/metadata object, skipped. */
export class RemoteOkSource implements SignalSource {
  readonly id = "remoteok";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "RemoteOK (free API)";
  isConfigured(): boolean { return true; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const kw = (ctx.watchlist?.keywords ?? []).map((k) => k.toLowerCase());
    const want = (s: string) => !kw.length || kw.some((k) => s.toLowerCase().includes(k));
    try {
      const rows = await getJson<RemoteOkJob[]>("https://remoteok.com/api", {
        headers: { "User-Agent": "RecruiterOS/1.0 (+https://recruitersos.co)", Accept: "application/json" },
      });
      for (const j of (Array.isArray(rows) ? rows : []).slice(0, (ctx.limit ?? 100) + 1)) {
        if (!j.company || !j.position) continue; // skips the leading legal/metadata object
        const tags = j.tags ?? [];
        if (!want(`${j.position} ${j.company} ${tags.join(" ")}`)) continue;
        signals.push(makeSignal({
          type: "job_posting",
          title: `${j.company} is hiring (remote): ${j.position}`,
          detail: `Remote role "${j.position}"${tags.length ? ` · ${tags.slice(0, 3).join(", ")}` : ""}.`,
          evidence: { roleTitle: j.position, location: j.location || "Remote", applyUrl: j.url || j.apply_url, tags, remote: true },
          source: { kind: this.kind, connector: "remoteok", url: j.url || j.apply_url, externalId: `remoteok:${j.id ?? j.slug}`, observedAt: now },
          eventAt: toIso(j.epoch, j.date ?? now),
          ingestedAt: now,
          anchor: j.company,
          companyHint: { id: "", name: j.company, industry: tags[0], hiringLocations: [{ raw: j.location || "Remote", remote: true }] },
        }));
      }
    } catch (err) { warnings.push(`remoteok: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface RemoteOkJob { id?: string; slug?: string; epoch?: number; date?: string; company?: string; position?: string; tags?: string[]; location?: string; url?: string; apply_url?: string }

/** Findwork.dev jobs API — broad cross-industry coverage with company + keywords. Needs a
 *  FREE API token (FINDWORK_API_KEY, read from env, never committed); skipped until set.
 *  Get a key at findwork.dev/developers. */
export class FindworkSource implements SignalSource {
  readonly id = "findwork";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "Findwork.dev jobs (free key)";
  isConfigured(): boolean { return !!process.env.FINDWORK_API_KEY; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const key = process.env.FINDWORK_API_KEY;
    if (!key) return { signals: [], warnings: [] };
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const headers = { Authorization: `Token ${key}`, Accept: "application/json" };
    const kw = (ctx.watchlist?.keywords ?? []);
    const search = kw.length ? `&search=${encodeURIComponent(kw.join(" "))}` : "";
    const pages = Math.min(Math.max(Math.ceil((ctx.limit ?? 50) / 50), 1), 3);
    try {
      for (let page = 1; page <= pages; page++) {
        const res = await getJson<{ results: FindworkJob[] }>(
          `https://findwork.dev/api/jobs/?sort_by=date${search}&page=${page}`, { headers },
        );
        const rows = res.results ?? [];
        if (!rows.length) break;
        for (const j of rows) {
          const company = j.company_name; const role = j.role;
          if (!company || !role) continue;
          const kwTag = (j.keywords ?? [])[0];
          signals.push(makeSignal({
            type: "job_posting",
            title: `${company} is hiring: ${role}`,
            detail: `Open role "${role}"${j.location ? ` in ${j.location}` : ""}${j.remote ? " · remote" : ""}.`,
            evidence: { roleTitle: role, location: j.location, applyUrl: j.url, keywords: j.keywords, remote: j.remote, employmentType: j.employment_type },
            source: { kind: this.kind, connector: "findwork", url: j.url, externalId: `findwork:${j.id}`, observedAt: now },
            eventAt: j.date_posted ?? now,
            ingestedAt: now,
            anchor: company,
            companyHint: { id: "", name: company, industry: kwTag },
          }));
        }
      }
    } catch (err) { warnings.push(`findwork: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface FindworkJob { id: number | string; role: string; company_name: string; location?: string; remote?: boolean; url: string; keywords?: string[]; date_posted?: string; employment_type?: string }

/** JobDataAPI (jobdataapi.com) — large aggregated feed with company + industry + country.
 *  Needs a FREE API key (JOBDATA_API_KEY, read from env, never committed); skipped until
 *  set. Get a key at jobdataapi.com. */
export class JobdataSource implements SignalSource {
  readonly id = "jobdata";
  readonly kind: SourceKind = "job_board";
  readonly emits: SignalType[] = ["job_posting"];
  readonly label = "JobDataAPI (free key)";
  isConfigured(): boolean { return !!process.env.JOBDATA_API_KEY; }

  async pull(ctx: PullContext): Promise<PullResult> {
    const key = process.env.JOBDATA_API_KEY;
    if (!key) return { signals: [], warnings: [] };
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const headers = { Authorization: `Api-Key ${key}`, Accept: "application/json" };
    const kw = (ctx.watchlist?.keywords ?? []);
    const title = kw.length ? `&title=${encodeURIComponent(kw.join(" "))}` : "";
    const pages = Math.min(Math.max(Math.ceil((ctx.limit ?? 50) / 50), 1), 3);
    try {
      for (let page = 1; page <= pages; page++) {
        const res = await getJson<{ results: JobdataJob[] }>(
          `https://jobdataapi.com/api/jobs/?page_size=50&page=${page}${title}`, { headers },
        );
        const rows = res.results ?? [];
        if (!rows.length) break;
        for (const j of rows) {
          const company = j.company?.name; const role = j.title;
          if (!company || !role) continue;
          const industry = j.company?.industry || (j.types ?? [])[0]?.name;
          const loc = j.location || [j.city?.name, j.region?.name, j.country?.name].filter(Boolean).join(", ");
          signals.push(makeSignal({
            type: "job_posting",
            title: `${company} is hiring: ${role}`,
            detail: `Open role "${role}"${industry ? ` · ${industry}` : ""}${loc ? ` in ${loc}` : ""}.`,
            evidence: { roleTitle: role, function: industry, location: loc, applyUrl: j.application_url },
            source: { kind: this.kind, connector: "jobdata", url: j.application_url, externalId: `jobdata:${j.id}`, observedAt: now },
            eventAt: j.published ?? now,
            ingestedAt: now,
            anchor: company,
            companyHint: { id: "", name: company, industry },
          }));
        }
      }
    } catch (err) { warnings.push(`jobdata: ${(err as Error).message}`); }
    return { signals, warnings };
  }
}
interface JobdataJob {
  id: number | string; title: string; company?: { name?: string; industry?: string };
  location?: string; city?: { name?: string }; region?: { name?: string }; country?: { name?: string };
  types?: Array<{ name?: string }>; application_url?: string; published?: string;
}

/* ------------------------------------------------------------------ */
/* The free source set                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every free/public connector, ready to register alongside the built-ins. Use this to
 * run the engine at $0 for company-side signals; add ./sources' PublicAtsSource,
 * EdgarSource, and WarnNoticeSource for the rest of the free coverage.
 */
export function freeSources(): SignalSource[] {
  return [
    new ExtraAtsSource(),
    new RemoteBoardsSource(),
    new ArbeitnowSource(),
    new JobicySource(),
    new TheMuseSource(),
    new HimalayasSource(),
    new WorkingNomadsSource(),
    new WeWorkRemotelySource(),
    new JobspressoSource(),
    new RemoteOkSource(),
    new AdzunaSource(),
    new FindworkSource(),
    new JobdataSource(),
    new HackerNewsHiringSource(),
    new UsaSpendingSource(),
    new GitHubOrgSource(),
    new NewsRssSource(),
    new ProductHuntSource(),
    new LayoffsFeedSource(),
  ];
}
