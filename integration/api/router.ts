/**
 * RecruitersOS · Public API
 * Framework-agnostic router + runtime adapters.
 *
 * `handle()` authenticates, dispatches to the right handler, and returns a normalized
 * `ApiResponse`. It knows nothing about Next.js, Express, or serverless — adapters at the
 * bottom map each runtime's native request/response onto ours. Mount once, run anywhere.
 */

import {
  apiError,
  type ApiRequest,
  type ApiResponse,
  type AuthedRequest,
} from "./types";
import { authenticate, type KeyStore } from "./auth";
import {
  getCatalog,
  postCollect,
  postBuildCampaign,
  postIngest,
  postEnrich,
  getConfig,
  postProvider,
  postWebhook,
  type HandlerDeps,
} from "./handlers";

/** One route table entry. */
interface Route {
  method: ApiRequest["method"];
  /** Exact path under the API root (no version prefix handling needed here). */
  path: string;
  run: (req: AuthedRequest, deps: HandlerDeps) => ApiResponse | Promise<ApiResponse>;
  /** When true, the route is reachable without auth (none today, reserved). */
  public?: boolean;
}

const ROUTES: Route[] = [
  { method: "GET", path: "/v1/signals/catalog", run: getCatalog },
  { method: "POST", path: "/v1/signals/collect", run: postCollect },
  { method: "POST", path: "/v1/campaigns/build", run: postBuildCampaign },
  { method: "POST", path: "/v1/signals/ingest", run: postIngest },
  { method: "POST", path: "/v1/enrich", run: postEnrich },
  { method: "GET", path: "/v1/config", run: getConfig },
  { method: "POST", path: "/v1/config/providers", run: postProvider },
  { method: "POST", path: "/v1/config/webhooks", run: postWebhook },
];

/** Normalize a path: strip trailing slash, collapse the API mount prefix if present. */
function normalizePath(path: string): string {
  const noQuery = path.split("?")[0];
  const trimmed = noQuery.replace(/\/+$/, "") || "/";
  // Allow mounting under /api: treat "/api/v1/..." and "/v1/..." the same.
  return trimmed.replace(/^\/api(?=\/v1\/)/, "");
}

export interface RouterOptions {
  store: KeyStore;
  deps: HandlerDeps;
}

/**
 * Authenticate + dispatch a normalized request. This is the single entry point an
 * adapter calls. Returns a normalized response the adapter writes back.
 */
export async function handle(req: ApiRequest, opts: RouterOptions): Promise<ApiResponse> {
  const path = normalizePath(req.path);
  const route = ROUTES.find((r) => r.method === req.method && r.path === path);
  if (!route) return apiError(404, "not_found", `No route for ${req.method} ${path}.`);

  if (route.public) {
    return route.run({ ...req, auth: { workspaceId: "", keyId: "", scopes: [] } }, opts.deps);
  }

  const result = await authenticate(req, opts.store, opts.deps.now());
  if (!result.ok) {
    return apiError(401, result.code, result.message);
  }
  try {
    return await route.run({ ...req, auth: result.auth }, opts.deps);
  } catch (err) {
    return apiError(500, "internal_error", (err as Error).message);
  }
}

/** The route table, for docs/inspection and to keep the OpenAPI spec in sync. */
export function routeTable(): Array<{ method: string; path: string }> {
  return ROUTES.map((r) => ({ method: r.method, path: r.path }));
}

/* ------------------------------------------------------------------ */
/* Adapter: Next.js App Router                                         */
/* ------------------------------------------------------------------ */

/**
 * Drop-in for an App Router catch-all route. Create
 *   app/api/[...slug]/route.ts
 * and re-export the verbs:
 *
 *   import { nextHandler } from "@/integration/api/router";
 *   const h = nextHandler({ store, deps });
 *   export const GET = h; export const POST = h; export const PUT = h; export const DELETE = h;
 */
export function nextHandler(opts: RouterOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));

    let rawBody: string | undefined;
    let body: unknown;
    if (request.method !== "GET" && request.method !== "DELETE") {
      rawBody = await request.text();
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return Response.json(
            { error: { code: "invalid_json", message: "Body is not valid JSON." } },
            { status: 400 },
          );
        }
      }
    }

    const res = await handle(
      {
        method: request.method as ApiRequest["method"],
        path: url.pathname,
        headers,
        query,
        body,
        rawBody,
      },
      opts,
    );
    return Response.json(res.body, { status: res.status, headers: res.headers });
  };
}

/* ------------------------------------------------------------------ */
/* Adapter: Node http / Express-style                                  */
/* ------------------------------------------------------------------ */

interface NodeReqLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown; // assume a json body-parser ran
}
interface NodeResLike {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(chunk: string): void;
}

/** Express/Connect-style handler: `app.use("/api", expressHandler({ store, deps }))`. */
export function expressHandler(opts: RouterOptions) {
  return async (req: NodeReqLike, res: NodeResLike): Promise<void> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : (v ?? "");
    }
    const [path, qs = ""] = (req.url ?? "/").split("?");
    const query: Record<string, string> = {};
    new URLSearchParams(qs).forEach((v, k) => (query[k] = v));

    const out = await handle(
      {
        method: (req.method ?? "GET") as ApiRequest["method"],
        path,
        headers,
        query,
        body: req.body,
        rawBody: typeof req.body === "string" ? req.body : undefined,
      },
      opts,
    );
    if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.setHeader("Content-Type", "application/json");
    res.statusCode = out.status;
    res.end(JSON.stringify(out.body));
  };
}
