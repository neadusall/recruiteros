/**
 * RecruiterOS · Loxo API client
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

  constructor(creds: LoxoCreds) {
    const domain = creds.domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    this.base = `https://${domain}/api/${creds.slug}`;
    this.key = creds.apiKey;
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

  /* ---------------- writes (RecruiterOS -> Loxo) ---------------- */

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

  private raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.key}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
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
  const items = (json?.[key] || json?.results || json?.data || []) as any[];
  return {
    items: Array.isArray(items) ? items : [],
    scrollId: json?.scroll_id || json?.scrollId || undefined,
    total: typeof json?.total === "number" ? json.total : undefined,
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
