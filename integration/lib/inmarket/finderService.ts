/**
 * RecruitersOS · In-Market · finder-service client (the ONE finder-of-record)
 *
 * recruiteros holds the leads; the email-validate service holds the finding logic (Findymail
 * provider that cracks catch-all -> Reoon fallback -> RackNerd SMTP pool for verification). Rather
 * than duplicate that waterfall here, recruiteros routes its misses to the service's POST /find and
 * applies the pre-verified addresses it returns. This collapses the two systems into one pipeline.
 *
 * Contract (email-validate/server.mjs):
 *   POST {INMARKET_FINDER_URL}/find   Authorization: Bearer {INMARKET_FINDER_TOKEN}
 *   body: { people: [{ first, last, name, domain, linkedin }] }   (<= 5000)
 *   -> { summary, results: [{ email, status, confidence, source }] }  (order-preserved)
 *      status: found | not_found | catch_all | invalid | unknown | suppressed
 *
 * ENV-GATED: a no-op unless INMARKET_FINDER_URL is set.
 */

const CHUNK = 100;
const HTTP_TIMEOUT_MS = 120_000; // provider + verify can be slow for a batch

export interface FoundRow { email: string | null; status: string; source?: string; confidence?: string }

export function finderServiceEnabled(): boolean {
  return !!(process.env.INMARKET_FINDER_URL || "").trim();
}

function baseUrl(): string {
  return (process.env.INMARKET_FINDER_URL || "").trim().replace(/\/$/, "");
}
function authHeader(): Record<string, string> {
  const t = (process.env.INMARKET_FINDER_TOKEN || "").trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export interface FindPerson { first?: string; last?: string; name?: string; domain?: string; linkedin?: string }

/** POST one chunk to the service. Returns results aligned to input order, or [] on failure. */
async function findChunk(people: FindPerson[]): Promise<FoundRow[]> {
  try {
    const res = await fetch(`${baseUrl()}/find`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeader() },
      body: JSON.stringify({ people }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const j: any = await res.json().catch(() => null);
    const results = Array.isArray(j?.results) ? j.results : [];
    return results.map((r: any) => ({
      email: (r && typeof r.email === "string" && r.email.includes("@")) ? r.email.toLowerCase() : null,
      status: String(r?.status ?? "unknown"),
      source: r?.source ? String(r.source) : undefined,
      confidence: r?.confidence ? String(r.confidence) : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Resolve verified emails for many people via the finder service, chunked. Returns results aligned
 * 1:1 with the input (missing/failed rows -> { email:null, status:"unknown" }). No-op ([] with the
 * right length) unless configured.
 */
export async function findManyViaService(people: FindPerson[]): Promise<FoundRow[]> {
  if (!finderServiceEnabled() || !people.length) return people.map(() => ({ email: null, status: "unknown" }));
  const out: FoundRow[] = [];
  for (let i = 0; i < people.length; i += CHUNK) {
    const chunk = people.slice(i, i + CHUNK);
    const got = await findChunk(chunk);
    for (let k = 0; k < chunk.length; k++) out.push(got[k] || { email: null, status: "unknown" });
  }
  return out;
}
