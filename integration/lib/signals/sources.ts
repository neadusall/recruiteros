/**
 * RecruiterOS · Signal Engine
 * Source abstraction + connectors.
 *
 * Every place a hiring signal can come from is wrapped behind one interface,
 * `SignalSource`, exactly like the LinkedIn Engine wraps every vendor behind
 * `LinkedInProvider` (../linkedin/provider.ts). The collector talks only to this
 * interface, so adding a data provider — Greenhouse, Crunchbase, SEC EDGAR, a state
 * WARN feed, an intent vendor, or the user's own webhook — never touches the rest of
 * the engine.
 *
 * Each connector is responsible for ONE thing: turn its provider's raw payloads into
 * normalized `Signal`s (status "raw"). Entity resolution, dedupe, and scoring happen
 * downstream in the collector, so connectors stay thin and independently testable.
 *
 * No vendor SDKs: connectors use `fetch` against documented REST/JSON endpoints for
 * version stability, the same decision made for the Telnyx and Unipile wrappers.
 */

import type {
  PullResult,
  Signal,
  SignalType,
  SourceKind,
  SourceRef,
} from "./types";
import { getDefinition } from "./registry";

/* ------------------------------------------------------------------ */
/* Connector contract                                                  */
/* ------------------------------------------------------------------ */

/** Options handed to every poll. */
export interface PullContext {
  /** Opaque cursor returned by the previous pull of this source (incremental). */
  cursor?: string;
  /** Only return observations newer than this ISO time, when the API supports it. */
  since?: string;
  /** Narrow the pull, e.g. to companies/domains a workspace is tracking. */
  watchlist?: {
    domains?: string[];
    companyNames?: string[];
    locations?: string[];
    keywords?: string[];
  };
  /** Soft cap on how many signals to emit this pass. */
  limit?: number;
}

/**
 * The contract every signal source must satisfy. Implementations are stateless w.r.t.
 * RecruiterOS data — they receive a cursor and return one normalized page.
 */
export interface SignalSource {
  /** Stable connector id, used in SourceRef.connector and for cursor storage. */
  readonly id: string;
  readonly kind: SourceKind;
  /** Signal types this source is capable of producing. */
  readonly emits: SignalType[];
  /** Human label for the integrations UI. */
  readonly label: string;
  /** True once required credentials/env are present. */
  isConfigured(): boolean;
  /** Pull one incremental page of normalized signals. */
  pull(ctx: PullContext): Promise<PullResult>;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Deterministic id for a signal from its provenance, so re-ingesting the same
 * artifact produces the same id (idempotent pulls). No randomness — matches the
 * project's avoidance of nondeterministic ids in pipelines.
 */
export function signalIdFrom(connector: string, externalId: string): string {
  return `sig_${connector}_${externalId}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120);
}

/**
 * Default dedupe key: same company-or-person + same type within the same ISO week is
 * treated as one signal (the collector merges sources into one record). Connectors may
 * override by passing a more specific key.
 */
export function defaultDedupeKey(type: SignalType, anchor: string, isoWeek: string): string {
  return `${type}:${anchor.toLowerCase()}:${isoWeek}`;
}

/** ISO-8601 week string (e.g. "2026-W22") from an ISO timestamp, no Date.now needed. */
export function isoWeekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;            // Mon=0
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((thursday.getTime() - firstThursday.getTime()) / 86_400_000 -
      ((firstThursday.getUTCDay() + 6) % 7) + 3) / 7,
  );
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Build a normalized "raw" Signal. Connectors call this so every signal is shaped
 * consistently and inherits the registry's motion. `ingestedAt` is supplied by the
 * caller (the collector stamps it) to keep connectors deterministic.
 */
export function makeSignal(input: {
  type: SignalType;
  title: string;
  detail: string;
  evidence?: Record<string, unknown>;
  source: SourceRef;
  eventAt: string;
  ingestedAt: string;
  /** Anchor for dedupe: a domain, company name, or person id. */
  anchor: string;
  /** Partial company/person hints the resolver will firm up later. */
  companyHint?: Signal["company"];
  personHint?: Signal["person"];
}): Signal {
  const def = getDefinition(input.type);
  const externalId = input.source.externalId ?? input.source.url ?? input.title;
  return {
    id: signalIdFrom(input.source.connector, externalId),
    type: input.type,
    motion: def.motion,
    status: "raw",
    title: input.title,
    detail: input.detail,
    company: input.companyHint,
    person: input.personHint,
    evidence: input.evidence ?? {},
    sources: [input.source],
    eventAt: input.eventAt,
    ingestedAt: input.ingestedAt,
    dedupeKey: defaultDedupeKey(input.type, input.anchor, isoWeekOf(input.eventAt)),
  };
}

/** Minimal JSON fetch with a clear error, shared by HTTP connectors. */
export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    throw new SourceError(`${init.method ?? "GET"} ${url} failed: ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export class SourceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SourceError";
  }
}

/* ------------------------------------------------------------------ */
/* Connector: public ATS boards (Greenhouse / Lever / Ashby)           */
/* ------------------------------------------------------------------ */

/**
 * Public ATS job boards expose every open role as JSON with no auth. This is the
 * highest-signal, lowest-cost source: direct hiring intent straight from the company.
 * One connector covers the three dominant ATSs by board slug.
 *
 * The collector feeds it a watchlist of board slugs (resolved from tracked companies);
 * the connector emits a `job_posting` per role and lets the collector roll same-company
 * postings up into a `hiring_velocity` signal.
 */
export class PublicAtsSource implements SignalSource {
  readonly id = "public_ats";
  readonly kind: SourceKind = "ats_public";
  readonly emits: SignalType[] = ["job_posting", "job_repost", "evergreen_role"];
  readonly label = "Public ATS boards (Greenhouse · Lever · Ashby)";

  isConfigured(): boolean {
    return true; // no credentials required for public boards
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const slugs = (ctx.watchlist?.companyNames ?? []).slice(0, ctx.limit ?? 50);
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];

    for (const slug of slugs) {
      try {
        const roles = await this.fetchBoard(slug);
        for (const role of roles) {
          signals.push(
            makeSignal({
              type: "job_posting",
              title: `${slug} is hiring: ${role.title}`,
              detail: `Open role "${role.title}"${role.location ? ` in ${role.location}` : ""}. Direct hiring intent from the company's ATS.`,
              evidence: {
                roleTitle: role.title,
                location: role.location,
                function: role.department,
                postedAt: role.updatedAt,
                applyUrl: role.absoluteUrl,
              },
              source: {
                kind: this.kind,
                connector: this.id,
                url: role.absoluteUrl,
                externalId: `${slug}:${role.id}`,
                observedAt: now,
              },
              eventAt: role.updatedAt ?? now,
              ingestedAt: now,
              anchor: slug,
              companyHint: { id: "", name: slug },
            }),
          );
        }
      } catch (err) {
        warnings.push(`ATS board "${slug}": ${(err as Error).message}`);
      }
    }
    return { signals, warnings, nextPollAfter: undefined };
  }

  /** Try each known ATS shape for a board slug; return a normalized role list. */
  private async fetchBoard(slug: string): Promise<NormalizedRole[]> {
    // Greenhouse public board API
    try {
      const gh = await getJson<{ jobs: GreenhouseJob[] }>(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`,
      );
      return gh.jobs.map((j) => ({
        id: String(j.id),
        title: j.title,
        location: j.location?.name,
        department: j.departments?.[0]?.name,
        absoluteUrl: j.absolute_url,
        updatedAt: j.updated_at,
      }));
    } catch {
      /* fall through */
    }
    // Lever postings API
    try {
      const lv = await getJson<LeverPosting[]>(
        `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
      );
      return lv.map((p) => ({
        id: p.id,
        title: p.text,
        location: p.categories?.location,
        department: p.categories?.team,
        absoluteUrl: p.hostedUrl,
        updatedAt: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
      }));
    } catch {
      /* fall through */
    }
    // Ashby public job board API
    const ash = await getJson<{ jobs: AshbyJob[] }>(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    );
    return (ash.jobs ?? []).map((j) => ({
      id: j.id,
      title: j.title,
      location: j.location,
      department: j.department,
      absoluteUrl: j.jobUrl,
      updatedAt: j.publishedAt,
    }));
  }
}

interface NormalizedRole {
  id: string;
  title: string;
  location?: string;
  department?: string;
  absoluteUrl?: string;
  updatedAt?: string;
}
interface GreenhouseJob {
  id: number;
  title: string;
  updated_at: string;
  absolute_url: string;
  location?: { name?: string };
  departments?: { name?: string }[];
}
interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  categories?: { location?: string; team?: string };
}
interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  department?: string;
  jobUrl?: string;
  publishedAt?: string;
}

/* ------------------------------------------------------------------ */
/* Connector: SEC EDGAR full-text (funding / IPO / M&A filings)        */
/* ------------------------------------------------------------------ */

/**
 * SEC EDGAR exposes filings as JSON with no auth (a descriptive User-Agent is
 * required by SEC policy). Form D = a capital raise; S-1 = IPO intent; 8-K often
 * carries M&A and leadership changes. This connector turns recent filings into
 * capital/leadership signals for US entities.
 */
export class EdgarSource implements SignalSource {
  readonly id = "sec_edgar";
  readonly kind: SourceKind = "gov_filing";
  readonly emits: SignalType[] = ["funding_round", "ipo_or_s1", "acquisition", "board_change"];
  readonly label = "SEC EDGAR filings";

  private ua = process.env.SEC_EDGAR_USER_AGENT ?? "RecruiterOS signal-engine contact@recruitersos.co";

  isConfigured(): boolean {
    return Boolean(this.ua);
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const now = new Date().toISOString();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    // EDGAR full-text search; "forms" narrows to capital + IPO + material-event filings.
    const q = encodeURIComponent((ctx.watchlist?.keywords ?? []).join(" ") || "*");
    try {
      const data = await getJson<EdgarSearch>(
        `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=D,S-1,8-K&dateRange=custom`,
        { headers: { "User-Agent": this.ua } },
      );
      for (const hit of (data.hits?.hits ?? []).slice(0, ctx.limit ?? 50)) {
        const form = hit._source.file_type;
        const type = this.mapForm(form);
        if (!type) continue;
        const name = hit._source.display_names?.[0] ?? "Unknown filer";
        signals.push(
          makeSignal({
            type,
            title: `${name} filed ${form} with the SEC`,
            detail: `An SEC ${form} filing for ${name} — a dated, public ${this.describe(type)} signal.`,
            evidence: { filingType: form, filedAt: hit._source.file_date },
            source: {
              kind: this.kind,
              connector: this.id,
              url: `https://www.sec.gov/Archives/edgar/data/${hit._source.cik}/`,
              externalId: hit._id,
              observedAt: now,
            },
            eventAt: hit._source.file_date ?? now,
            ingestedAt: now,
            anchor: name,
            companyHint: { id: "", name },
          }),
        );
      }
    } catch (err) {
      warnings.push(`EDGAR: ${(err as Error).message}`);
    }
    return { signals, warnings };
  }

  private mapForm(form: string): SignalType | null {
    if (form.startsWith("D")) return "funding_round";
    if (form.startsWith("S-1")) return "ipo_or_s1";
    if (form.startsWith("8-K")) return "acquisition";
    return null;
  }
  private describe(t: SignalType): string {
    return t === "funding_round" ? "capital raise"
      : t === "ipo_or_s1" ? "IPO-intent"
      : "material-event";
  }
}

interface EdgarSearch {
  hits?: {
    hits?: Array<{
      _id: string;
      _source: {
        file_type: string;
        file_date?: string;
        cik?: string;
        display_names?: string[];
      };
    }>;
  };
}

/* ------------------------------------------------------------------ */
/* Connector: US WARN layoff notices                                   */
/* ------------------------------------------------------------------ */

/**
 * WARN Act notices are the gold standard of layoff signals: official, dated, and they
 * name the site and affected count. There is no single national API, so this connector
 * reads a normalized aggregate feed (configurable URL — point it at a self-hosted
 * scraper of state dashboards or a partner feed). It is the strongest recruiting-side
 * source we have.
 */
export class WarnNoticeSource implements SignalSource {
  readonly id = "warn_notices";
  readonly kind: SourceKind = "gov_filing";
  readonly emits: SignalType[] = ["warn_notice", "office_closure"];
  readonly label = "US WARN layoff notices";

  private feedUrl = process.env.WARN_FEED_URL ?? "";

  isConfigured(): boolean {
    return Boolean(this.feedUrl);
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    if (!this.isConfigured()) {
      return { signals: [], warnings: ["WARN_FEED_URL not configured"] };
    }
    const now = new Date().toISOString();
    const rows = await getJson<WarnRow[]>(this.feedUrl);
    const signals = rows.slice(0, ctx.limit ?? 100).map((r) =>
      makeSignal({
        type: r.closure ? "office_closure" : "warn_notice",
        title: `${r.company} filed a WARN notice in ${r.state}`,
        detail: `${r.affected ?? "Multiple"} roles affected at ${r.site ?? r.company}, effective ${r.effectiveDate}. ${r.affected ?? "Strong"} people will be on the market — reach them first.`,
        evidence: {
          affectedCount: r.affected,
          effectiveDate: r.effectiveDate,
          site: r.site,
          state: r.state,
        },
        source: {
          kind: this.kind,
          connector: this.id,
          url: r.sourceUrl,
          externalId: r.id,
          observedAt: now,
        },
        eventAt: r.noticeDate ?? now,
        ingestedAt: now,
        anchor: r.company,
        companyHint: { id: "", name: r.company },
      }),
    );
    return { signals };
  }
}

interface WarnRow {
  id: string;
  company: string;
  site?: string;
  state: string;
  affected?: number;
  noticeDate?: string;
  effectiveDate: string;
  closure?: boolean;
  sourceUrl?: string;
}

/* ------------------------------------------------------------------ */
/* Connector: People graph (LinkedIn via Unipile) — availability       */
/* ------------------------------------------------------------------ */

/**
 * Reuses the same provider (Unipile) the LinkedIn Engine uses, but for *listening*
 * instead of sending: profile changes, "open to work" flags, employment changes, and
 * tenure milestones across a tracked candidate pool. These are the candidate-side
 * signals that tell you the moment a person becomes reachable.
 *
 * The actual employment-change webhook normalization lives in the collector's webhook
 * handler; this poll path covers periodic profile re-checks for a watchlist.
 */
export class PeopleGraphSource implements SignalSource {
  readonly id = "people_graph";
  readonly kind: SourceKind = "people_graph";
  readonly emits: SignalType[] = [
    "open_to_work",
    "tenure_milestone",
    "job_change",
    "profile_update",
    "promotion_passed_over",
  ];
  readonly label = "People graph (LinkedIn profile changes)";

  private dsn = process.env.UNIPILE_DSN ?? "";
  private apiKey = process.env.UNIPILE_API_KEY ?? "";

  isConfigured(): boolean {
    return Boolean(this.dsn && this.apiKey);
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    if (!this.isConfigured()) {
      return { signals: [], warnings: ["UNIPILE_DSN / UNIPILE_API_KEY not configured"] };
    }
    // Watchlist-driven profile re-check. The provider returns the delta since `since`.
    const now = new Date().toISOString();
    const ids = (ctx.watchlist?.companyNames ?? []).slice(0, ctx.limit ?? 50);
    const signals: Signal[] = [];
    const warnings: string[] = [];
    for (const profileId of ids) {
      try {
        const p = await getJson<UnipileProfileDelta>(
          `https://${this.dsn}/api/v1/users/${encodeURIComponent(profileId)}/changes?since=${encodeURIComponent(ctx.since ?? "")}`,
          { headers: { "X-API-KEY": this.apiKey } },
        );
        for (const change of p.changes ?? []) {
          const type = this.mapChange(change.kind);
          if (!type) continue;
          signals.push(
            makeSignal({
              type,
              title: `${p.name} — ${getDefinition(type).label.toLowerCase()}`,
              detail: change.summary ?? `${p.name} had a ${type.replace(/_/g, " ")} change.`,
              evidence: change.data ?? {},
              source: {
                kind: this.kind,
                connector: this.id,
                externalId: `${profileId}:${change.id}`,
                observedAt: now,
              },
              eventAt: change.at ?? now,
              ingestedAt: now,
              anchor: profileId,
              personHint: {
                id: "",
                fullName: p.name,
                providerProfileId: profileId,
                linkedinUrl: p.publicUrl,
                headline: p.headline,
              },
            }),
          );
        }
      } catch (err) {
        warnings.push(`People graph "${profileId}": ${(err as Error).message}`);
      }
    }
    return { signals, warnings };
  }

  private mapChange(kind: string): SignalType | null {
    switch (kind) {
      case "open_to_work": return "open_to_work";
      case "tenure": return "tenure_milestone";
      case "employer_change": return "job_change";
      case "profile_edit": return "profile_update";
      case "title_stagnation": return "promotion_passed_over";
      default: return null;
    }
  }
}

interface UnipileProfileDelta {
  name: string;
  headline?: string;
  publicUrl?: string;
  changes?: Array<{
    id: string;
    kind: string;
    summary?: string;
    at?: string;
    data?: Record<string, unknown>;
  }>;
}

/* ------------------------------------------------------------------ */
/* Connector: Webhook intake (partner / user-pushed signals)           */
/* ------------------------------------------------------------------ */

/**
 * A passive source: it does not poll. Partners (or the user's own systems — including
 * the Telnyx phone project's signed `call.summarized` events) POST normalized payloads
 * which the collector hands here for shaping. This is how RecruiterOS becomes a
 * platform: any system that sees a hiring signal can feed it in.
 */
export class WebhookSource implements SignalSource {
  readonly id = "webhook";
  readonly kind: SourceKind = "webhook";
  readonly emits: SignalType[] = []; // any — determined by payload
  readonly label = "Inbound webhook";

  isConfigured(): boolean {
    return true;
  }

  /** Poll is a no-op; webhooks are pushed, not pulled. */
  async pull(): Promise<PullResult> {
    return { signals: [] };
  }

  /** Shape one inbound payload into a normalized Signal. Called by the HTTP handler. */
  ingest(payload: WebhookSignalPayload, ingestedAt: string): Signal {
    return makeSignal({
      type: payload.type,
      title: payload.title,
      detail: payload.detail,
      evidence: payload.evidence ?? {},
      source: {
        kind: this.kind,
        connector: payload.connector ?? this.id,
        url: payload.url,
        externalId: payload.externalId,
        observedAt: payload.observedAt ?? ingestedAt,
      },
      eventAt: payload.eventAt ?? ingestedAt,
      ingestedAt,
      anchor: payload.anchor,
      companyHint: payload.company,
      personHint: payload.person,
    });
  }
}

export interface WebhookSignalPayload {
  type: SignalType;
  title: string;
  detail: string;
  anchor: string;
  evidence?: Record<string, unknown>;
  connector?: string;
  url?: string;
  externalId?: string;
  observedAt?: string;
  eventAt?: string;
  company?: Signal["company"];
  person?: Signal["person"];
}

/* ------------------------------------------------------------------ */
/* Source registry                                                     */
/* ------------------------------------------------------------------ */

/**
 * The set of sources the collector will poll. Add a connector here once and the whole
 * engine picks it up. Mirror of `getProvider()` in the LinkedIn Engine, but plural.
 */
export function defaultSources(): SignalSource[] {
  return [
    new PublicAtsSource(),
    new EdgarSource(),
    new WarnNoticeSource(),
    new PeopleGraphSource(),
    new WebhookSource(),
  ];
}

/** Only the sources that have their credentials/config in place. */
export function configuredSources(sources = defaultSources()): SignalSource[] {
  return sources.filter((s) => s.isConfigured());
}
