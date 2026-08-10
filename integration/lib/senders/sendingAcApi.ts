/**
 * RecruitersOS · Senders · Sending.ac Partner API client
 *
 * The Sending.ac fleet is provisioned as Microsoft 365 mailboxes, and the Smartlead
 * mirror we sync from carries an OAuth connection with NO SMTP password. That left
 * all ~1,450 mailboxes imported but unsendable from this platform: the rotation skips
 * any inbox without credentials, so the Sending.ac pool could be counted and never used.
 *
 * The Partner API is the way in. It is a PROVISIONING API, not a send API - there is no
 * "send message" endpoint and there never was. What it does expose is
 * `GET /mailboxes/{id}/credentials`, which returns the real IMAP + SMTP host, port,
 * username, password and encryption for every active mailbox. Those credentials are
 * exactly what `lib/senders/smtp.ts` sends through and `lib/senders/replySync.ts` reads
 * replies from, so pulling them once turns the whole fleet on with no other change.
 *
 * Shape of the upstream account (from the API's own vocabulary):
 *   User    - an end customer on the partner platform (our tenants)
 *   Sender  - a named grouping of domains + mailboxes under a user
 *   Domain  - a sending domain; the platform runs M365 + DNS for it
 *   Mailbox - one email account, with the IMAP/SMTP credentials we want
 *
 * We only ever READ here. Nothing in RecruitersOS creates, updates or deprovisions
 * upstream infrastructure, so no write verb is implemented: a bug on our side must
 * never be able to tear down a mailbox fleet someone is paying for.
 *
 * Auth is a bearer key from the partner dashboard (`sac_live_…` / `sac_test_…`). The
 * key prefix also picks the host, so a test key can never be pointed at production
 * infrastructure by a stale env var.
 */

const LIVE_BASE = "https://live-api.customers.ac/v1";
const SANDBOX_BASE = "https://sandbox-api.customers.ac/v1";

/** Upstream ceiling is 120 requests/minute/token; stay comfortably under it so a
 *  full-fleet credential pull never trips the limiter mid-run. */
const MIN_GAP_MS = 550;
const MAX_RETRIES = 4;

export interface SendingAcUser {
  id: string;
  email?: string;
  name?: string;
  status?: string;
}

export interface SendingAcSender {
  id: string;
  user_id?: string;
  name?: string;
  status?: string;
  domains_count?: number;
  mailboxes_count?: number;
}

export interface SendingAcCredentials {
  mailbox_id?: string;
  email?: string;
  imap?: { host: string; port: number; username: string; password: string; encryption?: string };
  smtp?: { host: string; port: number; username: string; password: string; encryption?: string };
}

export interface SendingAcMailbox {
  id: string;
  sender_id?: string;
  domain_id?: string;
  email: string;
  display_name?: string | null;
  status?: string;
  credentials?: SendingAcCredentials;
}

/** A failure the operator can act on, carrying the upstream machine-readable code. */
export class SendingAcApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SendingAcApiError";
  }
}

export function sendingAcKey(): string {
  return (process.env.SENDINGAC_API_KEY || "").trim();
}

export function sendingAcConfigured(): boolean {
  return sendingAcKey().length > 0;
}

/**
 * Is this a non-production key?
 *
 * The published spec says keys look like `sac_live_…` / `sac_test_…`, but the key
 * Sending.ac actually issued was `sk_sandbox_…`. Trusting the documented prefix alone
 * meant an unrecognised key fell through to the DEFAULT, and the default is live: a
 * sandbox key would have been aimed at production infrastructure. So match on the
 * environment word anywhere in the prefix rather than on one exact literal, and treat
 * anything unrecognised as non-live below.
 */
function keyLooksSandbox(k: string): boolean {
  return /^[a-z]+_(test|sandbox|dev)_/i.test(k) || /sandbox/i.test(k.split("_").slice(0, 2).join("_"));
}

/** Is this key unambiguously a production key? */
function keyLooksLive(k: string): boolean {
  return /^[a-z]+_(live|prod|production)_/i.test(k);
}

/**
 * Base URL for the configured key.
 *
 * SENDINGAC_API_BASE is the authority when set, and it is not optional in practice:
 * as of 2026-08-07 NEITHER documented host resolves in DNS (both NXDOMAIN) and the one
 * host that does, api.customers.ac, serves the dashboard and the spec but has no API
 * routes deployed. The constants below are what the spec advertises; the env var is how
 * this points at whatever Sending.ac actually ships without a code change.
 *
 * Absent an override, an unrecognised key is treated as sandbox. Guessing "live" for a
 * key we cannot classify is the one guess with a real downside.
 */
export function sendingAcBase(): string {
  const override = (process.env.SENDINGAC_API_BASE || "").trim();
  if (override) return override.replace(/\/+$/, "");
  return keyLooksLive(sendingAcKey()) ? LIVE_BASE : SANDBOX_BASE;
}

/** True when the configured key is not a production key (so: no real infrastructure). */
export function sendingAcIsSandbox(): boolean {
  const k = sendingAcKey();
  if (keyLooksLive(k)) return false;
  return keyLooksSandbox(k) || !!k; // unclassifiable but present: assume not live
}

/** Key fingerprint safe to render in the UI: prefix + last 4, never the secret. */
export function sendingAcKeyHint(): string {
  const k = sendingAcKey();
  if (!k) return "";
  // Any `<word>_<env>_` prefix, not just the two the spec named, so a key in an
  // unforeseen format still fingerprints readably instead of being sliced mid-secret.
  const m = /^([a-z]+_[a-z]+_)/i.exec(k);
  const prefix = m ? m[1] : k.slice(0, 4);
  return `${prefix}…${k.slice(-4)}`;
}

let lastCallAt = 0;

async function pace(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/**
 * One GET against the Partner API.
 *
 * 429 and 5xx are retried with the server's `Retry-After` when it sends one; every
 * other status is surfaced as a typed error carrying the upstream code, because the
 * codes are the difference between "your key is wrong" (`auth.invalid_key`), "your key
 * lacks a scope" (`auth.insufficient_scope`) and "this mailbox isn't provisioned yet"
 * (`resource.not_ready`) - three problems with three different fixes, and the operator
 * should be told which one they have.
 */
async function apiGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const key = sendingAcKey();
  if (!key) throw new SendingAcApiError("SENDINGAC_API_KEY is not set", "auth.missing_key", 0);

  const url = new URL(sendingAcBase() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await pace();
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // Network/timeout: worth another go, the fleet pull is long-running.
      lastErr = e instanceof Error ? e : new Error(String(e));
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }

    if (res.ok) return (await res.json()) as T;

    let code = `http.${res.status}`;
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch { /* non-JSON body: the status line above stands */ }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 60) * 1000
        : 1000 * Math.pow(2, attempt);
      lastErr = new SendingAcApiError(message, code, res.status);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    throw new SendingAcApiError(message, code, res.status);
  }
  throw lastErr || new SendingAcApiError("Sending.ac request failed", "server.error", 0);
}

interface Paged<T> {
  data: T[];
  pagination?: { has_more?: boolean; next_cursor?: string | null };
}

/**
 * Walk every page of a list endpoint.
 *
 * `maxPages` is a runaway guard, not a coverage limit: at the API's 100-record page
 * ceiling the default covers 20,000 records, far past any real fleet. If it ever trips
 * the caller is told, because a silently truncated fleet pull would read as "all your
 * mailboxes are credentialed" while leaving some dark.
 */
async function listAll<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  maxPages = 200,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const res = await apiGet<Paged<T>>(path, { ...params, "page[size]": 100, "page[after]": cursor });
    items.push(...(res.data || []));
    pages++;
    const next = res.pagination?.next_cursor;
    if (!res.pagination?.has_more || !next) return { items, truncated: false };
    if (pages >= maxPages) return { items, truncated: true };
    cursor = next;
  }
}

export async function listUsers(): Promise<SendingAcUser[]> {
  return (await listAll<SendingAcUser>("/users")).items;
}

export async function listSenders(filter: { userId?: string; status?: string } = {}): Promise<SendingAcSender[]> {
  return (await listAll<SendingAcSender>("/senders", {
    "filter[user_id]": filter.userId,
    "filter[status]": filter.status,
  })).items;
}

/**
 * Every mailbox on a sender, credentials included.
 *
 * `include=credentials` is the whole point of this client: it returns IMAP + SMTP
 * logins inline, one request per 100 mailboxes, instead of an extra round trip per
 * mailbox against the dedicated credentials endpoint. On a 1,450-mailbox fleet that is
 * ~15 requests rather than ~1,450 - the difference between a pull that finishes and one
 * that spends 15 minutes being rate-limited.
 *
 * Credentials only exist for `active` mailboxes upstream; anything still provisioning
 * comes back without them and is imported credential-less, exactly as before.
 */
export async function listMailboxes(
  senderId: string,
  opts: { credentials?: boolean; status?: string } = {},
): Promise<{ mailboxes: SendingAcMailbox[]; truncated: boolean }> {
  const { items, truncated } = await listAll<SendingAcMailbox>(`/senders/${encodeURIComponent(senderId)}/mailboxes`, {
    include: opts.credentials === false ? undefined : "credentials",
    "filter[status]": opts.status,
  });
  return { mailboxes: items, truncated };
}

/** Credentials for one mailbox. The fallback when a list response omitted them. */
export async function getMailboxCredentials(mailboxId: string): Promise<SendingAcCredentials> {
  const res = await apiGet<{ data: SendingAcCredentials }>(`/mailboxes/${encodeURIComponent(mailboxId)}/credentials`);
  return res.data;
}

export interface SendingAcPing {
  ok: boolean;
  sandbox: boolean;
  keyHint: string;
  base: string;
  senders?: number;
  mailboxes?: number;
  error?: string;
  errorCode?: string;
}

/**
 * Cheapest possible proof the key works: one page of senders.
 *
 * Used by the readiness row and the probe script so an operator learns the key is
 * wrong from a one-line check, not from a fleet import that half-finishes.
 */
export async function pingSendingAc(): Promise<SendingAcPing> {
  const base = { sandbox: sendingAcIsSandbox(), keyHint: sendingAcKeyHint(), base: sendingAcBase() };
  if (!sendingAcConfigured()) {
    return { ok: false, ...base, error: "SENDINGAC_API_KEY is not set", errorCode: "auth.missing_key" };
  }
  try {
    const senders = await listSenders();
    const mailboxes = senders.reduce((n, s) => n + (Number(s.mailboxes_count) || 0), 0);
    return { ok: true, ...base, senders: senders.length, mailboxes };
  } catch (e) {
    const err = e instanceof SendingAcApiError ? e : null;
    return {
      ok: false,
      ...base,
      error: e instanceof Error ? e.message : String(e),
      errorCode: err?.code || "server.error",
    };
  }
}
