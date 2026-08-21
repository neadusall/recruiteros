/**
 * RecruitersOS · people-search client (fresh-linkedin-scraper via RapidAPI).
 *
 * ONE client, because the mistake it exists to prevent was made independently in two tools and
 * would have been made again in the third.
 *
 * ── THE BUG THIS FIXES ─────────────────────────────────────────────────────────────────────────
 *
 * This API does not signal failure with an HTTP status. It answers almost everything with
 * **HTTP 202** and puts the real outcome in the body:
 *
 *   {"success":false,"message":"Request failed with status 429: Too Many Requests","cost":1,...}
 *
 * Both callers checked `res.ok` (202 is ok), then read `j.data` (absent), got `[]`, and recorded
 * "nobody found". So:
 *   - rename-buyers wrote `no_name` to its ledger, meaning "this company has no such leader",
 *     for every call the provider throttled. 1,286 company+function pairs carry that verdict.
 *   - linkedin-resolve wrote `no_match` for the same reason.
 *   - The 429 backoff in rename-buyers tested `res.status === 429`, which can never be true,
 *     so it never once backed off.
 *
 * Measured 2026-08-21 while diagnosing a 6.9% owner find-rate: every probe returned the 429
 * envelope while the account had 12,382 of 20,000 monthly requests remaining. The quota was fine;
 * the provider's own upstream scraper was throttled. Note `"cost":1` on a failed call: a throttled
 * request still spends a credit, so the old behaviour burned quota AND recorded a false negative.
 *
 * ── THE CONTRACT ───────────────────────────────────────────────────────────────────────────────
 *
 * `searchPeople` returns a KIND, never a bare array, so a caller cannot accidentally read a
 * failure as an empty result:
 *
 *   people     the search ran and matched                     -> use `people`
 *   empty      the search ran and genuinely matched nobody    -> a real negative, safe to record
 *   ratelimit  provider throttled us                          -> retry later, record NOTHING
 *   apifail    validation or upstream error                   -> retry later, record NOTHING
 *   http       transport / non-2xx                            -> retry later, record NOTHING
 *
 * Only `empty` is evidence about the world. Everything else is evidence about us.
 */

const DEFAULT_PATH = "/api/v1/search/people?name={query}&page={page}&limit=10";

/** Pull the credentials the way every tool here does, so there is one shape to get wrong. */
export function peopleApiFrom(credsJson, workspaceId) {
  const k = (((credsJson[workspaceId] || {}).integrations || {}).jd_sourcing || {}).keys || {};
  if (!k.RAPIDAPI_KEY || !k.RAPIDAPI_PEOPLE_SEARCH_HOST) throw new Error("people API creds missing");
  return {
    key: k.RAPIDAPI_KEY,
    host: k.RAPIDAPI_PEOPLE_SEARCH_HOST,
    path: k.RAPIDAPI_PEOPLE_SEARCH_PATH || DEFAULT_PATH,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalise whatever shape the provider returns into {name, headline, url}. */
export function extractPeople(json) {
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return list
    .map((o) => ({
      fullName: String(o.full_name || o.fullName || o.name || "").trim(),
      headline: String(o.title || o.headline || "").trim(),
      url: String(o.url || o.profile_url || o.linkedin_url || "").split("?")[0],
    }))
    .filter((p) => p.fullName && !/^linkedin member$/i.test(p.fullName));
}

/**
 * Classify one response. Exported so the diagnostics and the tests can assert on the exact
 * envelope without going near the network.
 */
export function classify(status, body) {
  let json = null;
  try { json = typeof body === "string" ? JSON.parse(body) : body; } catch { /* not json */ }
  const people = extractPeople(json);
  if (people.length) return { kind: "people", people, message: "" };
  // The failure envelope: HTTP 2xx carrying success:false.
  if (json && json.success === false) {
    const message = String(json.message || "");
    return { kind: /\b429\b|too many requests/i.test(message) ? "ratelimit" : "apifail", people: [], message };
  }
  if (status < 200 || status >= 300) return { kind: "http", people: [], message: `HTTP ${status}` };
  return { kind: "empty", people: [], message: "" };
}

/**
 * Search, with real backoff on the body-level 429. `attempts` bounds the wait so one throttled
 * company can never stall a whole run; the caller records nothing and the pair is retried on a
 * later pass, which is the correct outcome for a transient refusal.
 */
export async function searchPeople(api, query, opts = {}) {
  const attempts = Number(opts.attempts ?? 3);
  const baseDelay = Number(opts.baseDelayMs ?? 8000);
  const timeoutMs = Number(opts.timeoutMs ?? 25_000);
  const path = api.path.replace("{query}", encodeURIComponent(query)).replace("{page}", String(opts.page ?? 1));

  let last = { kind: "http", people: [], message: "not attempted" };
  for (let i = 0; i < attempts; i++) {
    let res = null;
    try {
      res = await fetch(`https://${api.host}${path}`, {
        headers: { "X-RapidAPI-Key": api.key, "X-RapidAPI-Host": api.host, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = { kind: "http", people: [], message: String((e && e.message) || "network") };
      await sleep(baseDelay * (i + 1));
      continue;
    }
    const body = await res.text().catch(() => "");
    last = classify(res.status, body);
    // Quota headers are worth surfacing: a caller that sees remaining fall to zero should stop
    // rather than keep spending on refusals.
    const remaining = Number(res.headers.get("x-ratelimit-requests-remaining"));
    if (Number.isFinite(remaining)) last.remaining = remaining;
    if (last.kind === "people" || last.kind === "empty") return last;
    if (last.kind === "ratelimit") { await sleep(baseDelay * (i + 1)); continue; }
    return last;   // apifail / http: retrying the same bad request will not help
  }
  return last;
}
