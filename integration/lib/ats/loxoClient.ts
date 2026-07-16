/**
 * RecruitersOS · Loxo API client
 *
 * The read+write seam to Loxo's Open API. Every endpoint is formed from the
 * agency domain + slug and authenticates with a Bearer token, exactly as the
 * Loxo reference describes:
 *
 *     https://{domain}/api/{agency_slug}/{resource}
 *     Authorization: Bearer {api_key}
 *
 * Built from a per-workspace credential object (see credentials.ts), so one
 * deployment can serve many agencies. Read methods page through people and
 * companies for the sync engine; the webhook methods register/clean up the
 * real-time feed.
 *
 * Response shapes are read defensively (people | results | data, etc.) because
 * Loxo's list envelopes differ by resource and account.
 */

export interface LoxoCreds {
  domain: string; // e.g. "app.loxo.co"
  slug: string; // agency slug
  apiKey: string; // bearer token
}

export interface LoxoClientOptions {
  /** Minimum spacing between request STARTS, ms. Default 250 (≈4 req/s). */
  minIntervalMs?: number;
  /** Max retry attempts for a rate-limited/transient request. Default 6. */
  maxRetries?: number;
  /** Ceiling on any single backoff wait, ms. Default 30s. */
  maxBackoffMs?: number;
}

export interface LoxoPage<T> {
  items: T[];
  /** Cursor for the next page, when the resource is scroll-paginated. */
  scrollId?: string;
  /** Total count when the envelope reports it. */
  total?: number;
}

export class LoxoClient {
  private base: string;
  private key: string;
  private gate: RateGate;
  private baseIntervalMs: number;
  private maxRetries: number;
  private maxBackoffMs: number;

  constructor(creds: LoxoCreds, opts: LoxoClientOptions = {}) {
    const domain = creds.domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    this.base = `https://${domain}/api/${creds.slug}`;
    this.key = creds.apiKey;
    this.baseIntervalMs = opts.minIntervalMs ?? envInt("LOXO_MIN_INTERVAL_MS", 250);
    this.maxRetries = opts.maxRetries ?? envInt("LOXO_MAX_RETRIES", 6);
    this.maxBackoffMs = opts.maxBackoffMs ?? envInt("LOXO_MAX_BACKOFF_MS", 30_000);
    // One gate per client instance. syncLoxo() builds a single client for the
    // whole run, so the adaptive throttle state persists across every page and
    // every per-record detail fetch — that's what keeps a multi-thousand-request
    // sync under Loxo's limit instead of bursting it into a 429.
    this.gate = new RateGate(this.baseIntervalMs);
  }

  /** Cheap authenticated GET used by the "Test connection" button. */
  async ping(): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const res = await this.raw("GET", "/job_categories");
      if (res.ok) return { ok: true, status: res.status };
      return { ok: false, status: res.status, error: await errText(res) };
    } catch (e: any) {
      return { ok: false, status: 0, error: e?.message ?? "network_error" };
    }
  }

  /** One page of people. Pass `scrollId` to continue a scroll, else page 1. */
  async listPeople(opts: { perPage?: number; scrollId?: string; updatedAfter?: string } = {}): Promise<LoxoPage<any>> {
    const q = pageQuery(opts);
    const json = await this.get(`/people${q}`);
    return readPage(json, "people");
  }

  async getPerson(id: string | number): Promise<any | null> {
    return this.get(`/people/${id}`).catch(() => null);
  }

  async listCompanies(opts: { perPage?: number; scrollId?: string; updatedAfter?: string } = {}): Promise<LoxoPage<any>> {
    const q = pageQuery(opts);
    const json = await this.get(`/companies${q}`);
    return readPage(json, "companies");
  }

  async getCompany(id: string | number): Promise<any | null> {
    return this.get(`/companies/${id}`).catch(() => null);
  }

  /* ---------------- activity / communication history ---------------- */

  /**
   * The agency's activity vocabulary (GET /activity_types). Names are
   * per-agency and customizable, so callers map by NAME, never hardcode ids.
   */
  async listActivityTypes(): Promise<any[]> {
    const json = await this.get(`/activity_types`).catch(() => null);
    if (!json) return [];
    return (json.activity_types || json.results || json.data || (Array.isArray(json) ? json : [])) as any[];
  }

  /**
   * One page of the unified activity log (GET /person_events). Supports the
   * documented incremental window (`created_at_start`) and scroll cursor, so a
   * poll after the first full pass only reads what's new.
   */
  async listPersonEvents(opts: { scrollId?: string; createdAtStart?: string; personId?: string | number } = {}): Promise<LoxoPage<any>> {
    const p = new URLSearchParams();
    if (opts.scrollId) p.set("scroll_id", opts.scrollId);
    if (opts.createdAtStart) p.set("created_at_start", opts.createdAtStart);
    if (opts.personId != null) p.set("person_id", String(opts.personId));
    const s = p.toString();
    const json = await this.get(`/person_events${s ? `?${s}` : ""}`);
    return readPage(json, "person_events");
  }

  /** One page of tracked emails sent through Loxo (GET /email_tracking). */
  async listEmailTracking(opts: { scrollId?: string; createdAtStart?: string } = {}): Promise<LoxoPage<any>> {
    const p = new URLSearchParams();
    if (opts.scrollId) p.set("scroll_id", opts.scrollId);
    if (opts.createdAtStart) p.set("created_at_start", opts.createdAtStart);
    const s = p.toString();
    const json = await this.get(`/email_tracking${s ? `?${s}` : ""}`);
    return readPage(json, "email_tracking");
  }

  /** One page of SMS sent/received through Loxo (GET /sms). */
  async listSms(opts: { scrollId?: string; createdAtStart?: string } = {}): Promise<LoxoPage<any>> {
    const p = new URLSearchParams();
    if (opts.scrollId) p.set("scroll_id", opts.scrollId);
    if (opts.createdAtStart) p.set("created_at_start", opts.createdAtStart);
    const s = p.toString();
    const json = await this.get(`/sms${s ? `?${s}` : ""}`);
    return readPage(json, "sms");
  }

  /**
   * Log an activity on a person (POST /person_events). Loxo's write endpoints
   * take FORM-ENCODED bodies with bracket notation (person_event[field]), not
   * JSON (confirmed by Loxo's own reference and real integrations).
   */
  async createPersonEvent(fields: {
    personId: string | number;
    activityTypeId?: string | number;
    notes?: string;
    createdAt?: string;
  }): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
    const form = new URLSearchParams();
    form.set("person_event[person_id]", String(fields.personId));
    if (fields.activityTypeId != null) form.set("person_event[activity_type_id]", String(fields.activityTypeId));
    if (fields.notes) form.set("person_event[notes]", fields.notes);
    if (fields.createdAt) form.set("person_event[created_at]", fields.createdAt);
    try {
      const res = await this.rawForm("POST", `/person_events`, form);
      if (!res.ok) return { ok: false, status: res.status, error: await errText(res) };
      const json = await res.json().catch(() => ({} as any));
      const id = json?.id ?? json?.person_event?.id;
      return { ok: true, status: res.status, id: id != null ? String(id) : undefined };
    } catch (e: any) {
      return { ok: false, status: 0, error: e?.message ?? "network_error" };
    }
  }

  /* ---------------- webhooks ---------------- */

  async listWebhooks(): Promise<any[]> {
    const json = await this.get(`/webhooks`).catch(() => null);
    if (!json) return [];
    return (json.webhooks || json.results || json.data || (Array.isArray(json) ? json : [])) as any[];
  }

  async createWebhook(
    item_type: string,
    action: string,
    endpoint_url: string,
  ): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
    const res = await this.raw("POST", `/webhooks`, { item_type, action, endpoint_url });
    if (!res.ok) return { ok: false, status: res.status, error: await errText(res) };
    const json = await res.json().catch(() => ({} as any));
    const id = json?.id ?? json?.webhook?.id;
    return { ok: true, status: res.status, id: id != null ? String(id) : undefined };
  }

  async deleteWebhook(id: string | number): Promise<boolean> {
    const res = await this.raw("DELETE", `/webhooks/${id}`);
    return res.ok;
  }

  /* ---------------- writes (RecruitersOS -> Loxo) ---------------- */

  /** Create a Person. `person` is the Loxo-shaped body (see map.ts). */
  async createPerson(person: Record<string, unknown>): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
    return this.write("POST", "/people", { person });
  }

  /** Update a Person by Loxo id. */
  async updatePerson(id: string | number, person: Record<string, unknown>): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
    return this.write("PUT", `/people/${id}`, { person });
  }

  async createCompany(company: Record<string, unknown>): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
    return this.write("POST", "/companies", { company });
  }

  async updateCompany(id: string | number, company: Record<string, unknown>): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
    return this.write("PUT", `/companies/${id}`, { company });
  }

  /** Shared write path: returns the new/updated record id when Loxo reports one. */
  private async write(method: string, path: string, body: unknown): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
    try {
      const res = await this.raw(method, path, body);
      if (!res.ok) return { ok: false, status: res.status, error: await errText(res) };
      const json = await res.json().catch(() => ({}));
      const id = json?.id ?? json?.person?.id ?? json?.company?.id;
      return { ok: true, status: res.status, id: id != null ? String(id) : undefined };
    } catch (e: any) {
      return { ok: false, status: 0, error: e?.message ?? "network_error" };
    }
  }

  /* ---------------- low level ---------------- */

  private async get(path: string): Promise<any> {
    const res = await this.raw("GET", path);
    if (!res.ok) {
      throw Object.assign(new Error(`loxo_${res.status}`), { status: res.status, detail: await errText(res) });
    }
    return res.json().catch(() => ({}));
  }

  /**
   * Single low-level request — rate-limited and retry-aware.
   *
   * Every call passes through the shared RateGate so request STARTS are spaced
   * out. On a 429 (or a 5xx for an idempotent GET) we back off and retry,
   * honoring Loxo's Retry-After header when present, and we widen the
   * steady-state spacing (adaptive throttle) so the rest of the run runs gentler;
   * sustained success relaxes it back toward the baseline.
   *
   * Writes (POST/PUT/DELETE) are retried ONLY on 429 — a rate-limited request
   * never reached Loxo's data layer, so retrying can't duplicate. 5xx and network
   * errors on writes are surfaced rather than retried, to avoid double-creates.
   */
  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    return this.send(method, path, payload, body !== undefined ? "application/json" : undefined);
  }

  /** Form-encoded write (Loxo's person_events endpoint takes form bodies). */
  private async rawForm(method: string, path: string, form: URLSearchParams): Promise<Response> {
    return this.send(method, path, form.toString(), "application/x-www-form-urlencoded");
  }

  private async send(method: string, path: string, payload?: string, contentType?: string): Promise<Response> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.key}`,
    };
    if (contentType) headers["content-type"] = contentType;
    const isGet = method.toUpperCase() === "GET";

    let attempt = 0;
    while (true) {
      await this.gate.acquire();
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: payload });
      } catch (e) {
        // Network/transport failure: safe to retry only for idempotent GETs.
        if (isGet && attempt < this.maxRetries) {
          attempt++;
          await sleep(backoffMs(attempt, this.maxBackoffMs));
          continue;
        }
        throw e;
      }

      const retryable = res.status === 429 || (isGet && res.status >= 500 && res.status <= 599);
      if (retryable && attempt < this.maxRetries) {
        attempt++;
        if (res.status === 429) this.gate.slowDown();
        const wait = retryAfterMs(res.headers) ?? backoffMs(attempt, this.maxBackoffMs);
        // Drain the body so the socket is released before we wait + retry.
        await res.arrayBuffer().catch(() => {});
        await sleep(Math.min(wait, this.maxBackoffMs));
        continue;
      }

      if (res.ok) this.gate.relax(this.baseIntervalMs);
      return res;
    }
  }
}

/* ---------------- helpers ---------------- */

function pageQuery(opts: { perPage?: number; scrollId?: string; updatedAfter?: string }): string {
  // Loxo's People and Companies list endpoints paginate by SCROLL CURSOR only.
  // `page`/`per_page` belong to the jobs endpoint; sending `per_page` here makes
  // Loxo reject the request with HTTP 422. We therefore send only `scroll_id`
  // (omitted on the first page) and let Loxo control the page size.
  //
  // `updated_at_min` is intentionally NOT sent: it isn't a confirmed parameter
  // on these endpoints and an unrecognized param also 422s. Sync runs a full
  // scroll each time; upserts are idempotent so re-scanning is safe. Re-add an
  // incremental filter only once Loxo's exact param name is verified.
  const p = new URLSearchParams();
  if (opts.scrollId) p.set("scroll_id", opts.scrollId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Normalize Loxo's varied list envelopes into { items, scrollId, total }. */
function readPage(json: any, key: string): LoxoPage<any> {
  if (Array.isArray(json)) return { items: json };
  const items = (json?.[key] || json?.results || json?.events || json?.data || []) as any[];
  return {
    items: Array.isArray(items) ? items : [],
    scrollId: json?.scroll_id || json?.scrollId || undefined,
    total:
      typeof json?.total === "number" ? json.total : typeof json?.total_count === "number" ? json.total_count : undefined,
  };
}

async function errText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return "";
  }
}

/* ---------------- rate limiting ---------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Full-jitter exponential backoff: a random wait in [base, base·2^attempt], capped. */
function backoffMs(attempt: number, cap: number): number {
  const base = 500;
  const ceil = Math.min(cap, base * 2 ** attempt);
  // Jitter across the whole window so concurrent retriers don't resynchronize.
  return base + Math.floor(Math.random() * Math.max(1, ceil - base));
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, if present. */
function retryAfterMs(headers: Headers): number | null {
  const v = headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

/**
 * Spaces out request STARTS to a minimum interval, serialized across every
 * concurrent caller (all the hydrate workers share one gate). The interval is
 * adaptive: a 429 widens it (slowDown), a clean response narrows it back toward
 * the baseline (relax). This is the steady-state throttle that keeps us under
 * Loxo's limit without hand-tuning caller concurrency.
 */
class RateGate {
  private intervalMs: number;
  private readonly maxIntervalMs = 5_000;
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /** Resolves only once it is this caller's turn AND the spacing has elapsed. */
  acquire(): Promise<void> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    return prev.then(async () => {
      const wait = this.last + this.intervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      release();
    });
  }

  /** Widen spacing after a rate-limit signal (multiplicative increase). */
  slowDown(): void {
    this.intervalMs = Math.min(this.maxIntervalMs, Math.ceil(this.intervalMs * 1.5) + 50);
  }

  /** Drift back toward the baseline after a clean response (gentle decrease). */
  relax(baseMs: number): void {
    if (this.intervalMs > baseMs) {
      this.intervalMs = Math.max(baseMs, Math.floor(this.intervalMs * 0.9));
    }
  }
}
