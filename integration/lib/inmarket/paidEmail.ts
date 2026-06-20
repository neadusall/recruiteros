/**
 * RecruitersOS · In-Market · cheap-first paid email fallback (Icypeas)
 *
 * Free resolution (team-page deep pull + first.last guess) handles most cases, but it can't form
 * a deliverable email when we have a NAME but no domain, or the only guess is on a no-MX domain.
 * This is the conversion fallback: the cheapest credible finder (Icypeas, ~$0.003/email) resolves
 * AND verifies a real address from name + domain-or-company. It is the same cheapest-first policy
 * the rest of the engine follows — free first, this only on the misses.
 *
 * ENV-GATED: returns null (a no-op, zero spend) unless ICYPEAS_API_KEY + ICYPEAS_API_SECRET are
 * set, so it never costs anything until you opt in. Add the keys to .env.production to switch the
 * Named → Contactable conversion on.
 */

const TIMEOUT_MS = 10_000;

export interface PaidEmail {
  email: string;
  /** True when the provider graded the result as high-certainty (treat as deliverable). */
  verified: boolean;
  via: "icypeas";
}

/** True once the cheap finder is configured. */
export function paidEmailEnabled(): boolean {
  return !!(process.env.ICYPEAS_API_KEY && process.env.ICYPEAS_API_SECRET);
}

function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const flat = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = flat[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const nest of ["data", "result", "results", "item", "items"]) {
    const n = flat[nest];
    if (n && typeof n === "object") {
      const hit = pick(Array.isArray(n) ? n[0] : n, keys);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Resolve + verify a work email for a named person via Icypeas. `domainOrCompany` should be the
 * resolved domain when we have one (best precision) or the company name as a fallback. Returns null
 * on any miss/error/timeout, or when not configured.
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://app.icypeas.com/api/email-search", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: process.env.ICYPEAS_API_KEY!,
        "X-ROCK-SECRET": process.env.ICYPEAS_API_SECRET!,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ firstname: first, lastname: last, domainOrCompany }),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json().catch(() => null);
    const email = pick(data, ["email", "value", "work_email"]);
    if (!email || !email.includes("@")) return null;
    const certainty = (pick(data, ["certainty", "status", "state"]) ?? "").toLowerCase();
    const verified = certainty.includes("ultra") || certainty.includes("sure") || certainty.includes("valid");
    return { email, verified, via: "icypeas" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
