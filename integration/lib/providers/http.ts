/**
 * RecruiterOS · Providers
 * Shared HTTP base for every external integration.
 *
 * One consistent client so each provider file is just endpoints + shapes:
 *  - configured(): is the key present? (drives the Connected red/yellow/green)
 *  - request():    real fetch when keyed, dry-log no-op otherwise, so the whole
 *                  engine runs end to end with zero credentials and lights up the
 *                  moment a key is added, no code change.
 *  - verify():     each provider overrides with its real health endpoint.
 *
 * Per-workspace keys: when a request resolves a workspace's portal-saved keys it
 * runs inside `runWithCreds(keys, fn)`. env() then resolves that context first,
 * falling back to process.env — so the Connected "Test" verifies THIS workspace's
 * keys, and the always-on engine still works off env when no context is set.
 */

import { AsyncLocalStorage } from "async_hooks";

/** Per-request credential context (workspace-scoped). */
interface CredContext {
  keys: Record<string, string>;
  /**
   * Isolated = a white-label customer workspace. Inside an isolated context a
   * provider sees ONLY the keys handed to it; it must NOT fall back to the
   * deployment's process.env (the house/operator keys). This is what stops a
   * customer riding the operator's Telnyx/enrichment keys for free.
   */
  isolated: boolean;
}

const credCtx = new AsyncLocalStorage<CredContext>();

/**
 * Run `fn` with `keys` taking precedence over process.env for every provider.
 * Pass `{ isolated: true }` for a non-house workspace so the env fallback is
 * suppressed and the workspace can only use the keys explicitly given to it.
 */
export function runWithCreds<T>(
  keys: Record<string, string>,
  fn: () => T,
  opts?: { isolated?: boolean },
): T {
  return credCtx.run({ keys, isolated: !!(opts && opts.isolated) }, fn);
}

/**
 * Resolve a credential the workspace-aware way: the active runWithCreds() context
 * first, then process.env — EXCEPT inside an isolated (customer) context, where the
 * env fallback is suppressed so a customer can never ride the operator's house key.
 *
 * Standalone modules (SMS, voice clone, enrichment, LinkedIn) must read provider
 * keys through this, NOT `process.env.X` directly, or they bypass isolation even
 * when wrapped in withWorkspaceCreds. Reading at module-load time (a top-level
 * `const K = process.env.X`) is the same bug frozen in — always read at call time.
 */
export function cred(key: string): string {
  const ctx = credCtx.getStore();
  if (ctx) {
    if (ctx.keys[key]) return ctx.keys[key];
    if (ctx.isolated) return ""; // customer context: never fall through to house env
  }
  return process.env[key] ?? "";
}

/** Are we currently inside an isolated (white-label customer) credential context? */
export function isIsolatedContext(): boolean {
  return !!credCtx.getStore()?.isolated;
}

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  /** Last verify() result, if run. */
  ok?: boolean;
  error?: string;
  checkedAt?: string;
}

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export abstract class ProviderClient {
  abstract id: string;
  abstract label: string;
  /** Names of the env vars this provider needs (all required unless optional). */
  protected abstract envKeys: string[];
  protected abstract baseUrl: string;

  /** True when every required key is set (per-workspace context, then env). */
  configured(): boolean {
    return this.envKeys.every((k) => Boolean(this.env(k)));
  }

  protected env(key: string): string {
    return cred(key);
  }

  /** Per-provider auth headers; override. Default: none. */
  protected authHeaders(): Record<string, string> {
    return {};
  }

  /**
   * Perform a request. Returns the parsed JSON, or a `{ dryRun: true }` marker
   * when the provider is not configured (so callers never crash in dev).
   */
  protected async request<T = any>(opts: RequestOptions): Promise<T & { dryRun?: boolean }> {
    const url = this.url(opts.path, opts.query);
    if (!this.configured()) {
      console.info(`[${this.id}:dry] ${opts.method ?? "GET"} ${url}`, opts.body ?? "");
      return { dryRun: true } as T & { dryRun: boolean };
    }
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { "Content-Type": "application/json", ...this.authHeaders(), ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : {};
    if (!res.ok) {
      const err = new Error(`${this.id}_${res.status}`) as Error & { status: number; body: unknown };
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data as T;
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const base = this.baseUrl.replace(/\/$/, "");
    const p = path.startsWith("http") ? path : base + (path.startsWith("/") ? path : "/" + path);
    if (!query) return p;
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return qs ? `${p}${p.includes("?") ? "&" : "?"}${qs}` : p;
  }

  /** Health check. Override per provider; default reports configured-only. */
  async verify(): Promise<{ ok: boolean; error?: string }> {
    return { ok: this.configured(), error: this.configured() ? undefined : "not_configured" };
  }

  status(): ProviderStatus {
    return { id: this.id, label: this.label, configured: this.configured() };
  }
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}
