/**
 * RecruiterOS · Public API
 * Transport-agnostic request/response shapes + integration domain types.
 *
 * The API layer is deliberately decoupled from any web framework. Handlers take a
 * normalized `ApiRequest` and return an `ApiResponse`; a thin adapter (Next.js route,
 * Express, or a serverless function) maps the platform's native req/res onto these.
 * That keeps the whole surface portable and unit-testable with plain objects — the same
 * "no framework coupling" rule the signals + LinkedIn engines follow.
 *
 * This is the contract a customer integrates against to plug their application into
 * RecruiterOS: authenticate with an API key, read the signal catalog, push their own
 * signals, run enrichment, and subscribe to webhooks.
 */

/** A normalized inbound HTTP request, framework-independent. */
export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Path without query string, e.g. "/v1/enrich". */
  path: string;
  /** Lower-cased header map. */
  headers: Record<string, string>;
  /** Parsed query params. */
  query: Record<string, string>;
  /** Parsed JSON body (already deserialized by the adapter), if any. */
  body?: unknown;
  /** Raw body bytes — needed for webhook signature verification. */
  rawBody?: string;
}

/** A normalized response the adapter writes back to the platform's native response. */
export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Authenticated caller context attached after the auth middleware runs. */
export interface AuthContext {
  workspaceId: string;
  keyId: string;
  scopes: ApiScope[];
}

/** Coarse permission scopes an API key may hold. */
export type ApiScope =
  | "signals:read"     // read the catalog + scored work-list
  | "signals:write"    // push signals in via the API/webhook
  | "enrich:read"      // run the contact waterfall
  | "campaigns:write"  // trigger/create campaigns
  | "config:write"     // manage providers + webhooks
  | "admin";           // everything

/** A request carrying its resolved auth context (post-middleware). */
export interface AuthedRequest extends ApiRequest {
  auth: AuthContext;
}

/* ------------------------------------------------------------------ */
/* Integration domain (what a customer configures to connect their app)*/
/* ------------------------------------------------------------------ */

/** An issued API key. The secret itself is never stored — only its hash. */
export interface ApiKey {
  id: string;              // public key id, e.g. "rk_live_8f...". Safe to display.
  workspaceId: string;
  /** SHA-256 of the full secret; compared on each request. */
  secretHash: string;
  scopes: ApiScope[];
  label: string;           // human label, e.g. "Production server"
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/** Credentials a workspace stores for an enrichment/data provider. */
export interface ProviderCredential {
  /** Provider id matching the enrichment provider, e.g. "icypeas_email". */
  providerId: string;
  /** The env-style keys this provider needs → their (encrypted-at-rest) values. */
  secrets: Record<string, string>;
  enabled: boolean;
  /** Position in the waterfall; lower runs first. */
  order: number;
}

/** A customer-registered webhook subscription. */
export interface WebhookSubscription {
  id: string;
  workspaceId: string;
  url: string;
  /** Events to deliver, e.g. ["signal.triggered", "enrichment.completed"]. */
  events: WebhookEvent[];
  /** Shared secret used to sign deliveries (HMAC-SHA256), like the Telnyx→GTM bridge. */
  signingSecret: string;
  active: boolean;
  createdAt: string;
}

export type WebhookEvent =
  | "signal.created"
  | "signal.triggered"
  | "enrichment.completed"
  | "campaign.created";

/** The full integration config for a workspace, returned by the config endpoints. */
export interface IntegrationConfig {
  workspaceId: string;
  keys: Array<Omit<ApiKey, "secretHash">>;  // never leak the hash
  providers: ProviderCredential[];
  webhooks: WebhookSubscription[];
}

/* ------------------------------------------------------------------ */
/* Standard error envelope                                             */
/* ------------------------------------------------------------------ */

export interface ApiError {
  error: {
    code: string;          // machine code, e.g. "unauthorized", "invalid_request"
    message: string;       // human message
    details?: unknown;     // field errors, etc.
  };
}

/** Build a standard error response. */
export function apiError(status: number, code: string, message: string, details?: unknown): ApiResponse {
  return { status, body: { error: { code, message, details } } satisfies ApiError };
}

/** Build a standard JSON success response. */
export function apiOk(body: unknown, status = 200): ApiResponse {
  return { status, body };
}
