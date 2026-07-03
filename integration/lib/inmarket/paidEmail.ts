/**
 * RecruitersOS · In-Market · cheap-first paid email fallback (Icypeas) — the RESIDUAL finder.
 *
 * Every free path is exhausted for our lead mix: permutation+Reoon caps ~40%, and a measured sweep
 * of GitHub + SearXNG-dork + site-crawl over real cold-domain misses returned ~10% (most of that
 * role mailboxes, not people). The decision-makers' real addresses simply aren't published anywhere
 * a crawler reaches and aren't guessable — they only live in a data-backed provider's network.
 * Icypeas is the cheapest such finder (only charged on a hit, credits roll over), so this is the
 * ONLY-on-the-misses residual: name + domain -> the provider's real address, which we then re-verify
 * through the Reoon credits we already own before trusting it.
 *
 * Icypeas is ASYNCHRONOUS: submit the search (get an id back), then poll the read endpoint until the
 * search completes. Fully ENV-GATED: a no-op (zero spend) unless ICYPEAS_API_KEY + ICYPEAS_API_SECRET
 * are set. NOTE: the exact auth header + result field names are confirmed on first live run with a
 * real key — pick() below is defensive across the documented shapes so a small naming difference
 * doesn't break resolution.
 */

const SUBMIT_URL = "https://app.icypeas.com/api/email-search";
const READ_URL = "https://app.icypeas.com/api/bulk-single-searchs/read";
const HTTP_TIMEOUT_MS = 12_000;
const POLL_TRIES = 8;
const POLL_DELAY_MS = 4_000;

export interface PaidEmail {
  email: string;
  /** True when the provider graded the result as high-certainty (treat as deliverable). */
  verified: boolean;
  certainty: string;
  via: "icypeas";
}

/** True once the cheap finder is configured. */
export function paidEmailEnabled(): boolean {
  return !!(process.env.ICYPEAS_API_KEY && process.env.ICYPEAS_API_SECRET);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function authHeaders(): Record<string, string> {
  return {
    Authorization: process.env.ICYPEAS_API_KEY!,
    "X-ROCK-SECRET": process.env.ICYPEAS_API_SECRET!,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** Depth-first pick of the first non-empty string under any of `keys` (searches nested containers). */
function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const flat = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = flat[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const nest of ["data", "result", "results", "item", "items", "search", "searches", "output"]) {
    const n = flat[nest];
    if (n && typeof n === "object") {
      const hit = pick(Array.isArray(n) ? n[0] : n, keys);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** A completed search has a terminal status; anything else means "still processing, poll again". */
function isTerminal(status: string): boolean {
  const s = status.toLowerCase();
  return ["found", "debited", "complete", "completed", "done", "finished", "no_result", "not_found", "none", "failed", "error"].some((t) => s.includes(t));
}

async function submitSearch(first: string, last: string, domainOrCompany: string): Promise<string | null> {
  try {
    const res = await fetch(SUBMIT_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ firstname: first, lastname: last, domainOrCompany }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j: unknown = await res.json().catch(() => null);
    // submit returns the search item's id (documented as `_id`, defensively also `id`)
    return pick(j, ["_id", "id", "searchId", "requestId"]) ?? null;
  } catch {
    return null;
  }
}

async function readResult(id: string): Promise<{ done: boolean; email?: string; certainty?: string }> {
  try {
    const res = await fetch(READ_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return { done: false };
    const j: unknown = await res.json().catch(() => null);
    const status = (pick(j, ["status", "state"]) ?? "").toLowerCase();
    if (status && !isTerminal(status)) return { done: false };
    const email = pick(j, ["email", "value", "work_email", "workEmail", "mail"]);
    const certainty = pick(j, ["certainty", "level", "confidence"]) ?? status;
    return { done: true, email, certainty };
  } catch {
    return { done: false };
  }
}

/**
 * Resolve a work email for a named person via Icypeas (submit -> poll). `domainOrCompany` should be
 * the resolved domain when we have one (best precision) or the company name as a fallback. Returns
 * null on any miss/error/timeout, or when not configured. Only a HIT is billed by Icypeas.
 */
export async function findEmailIcypeas(
  firstName: string | undefined,
  lastName: string | undefined,
  domainOrCompany: string | undefined,
): Promise<PaidEmail | null> {
  if (!paidEmailEnabled()) return null;
  const first = (firstName || "").trim();
  const last = (lastName || "").trim();
  if ((!first && !last) || !domainOrCompany) return null;

  const id = await submitSearch(first, last, domainOrCompany);
  if (!id) return null;

  for (let i = 0; i < POLL_TRIES; i++) {
    await sleep(POLL_DELAY_MS);
    const r = await readResult(id);
    if (!r.done) continue;
    if (!r.email || !r.email.includes("@")) return null; // completed, no address found
    const certainty = (r.certainty ?? "").toLowerCase();
    const verified = ["verified", "valid", "ultra", "sure", "deliverable", "found"].some((s) => certainty.includes(s));
    return { email: r.email.toLowerCase(), verified, certainty, via: "icypeas" };
  }
  return null; // never reached terminal in the poll window → treat as miss (not billed on no-result)
}
