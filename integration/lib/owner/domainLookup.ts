/**
 * RecruitersOS · Owner · Domain registry lookup (OWNER ONLY)
 *
 * Domain dates are public record, so the spend register should never make the owner type
 * them in. RDAP is the ICANN-mandated successor to WHOIS: a free, keyless, JSON API that
 * every gTLD registry must serve, and it carries exactly the three fields the Spend master
 * needs per domain: when it was registered, when it expires, and who it is registered with.
 *
 *   https://rdap.org/domain/<name>   bootstrap that redirects to the authoritative registry
 *
 * Renewal PRICE is the one thing RDAP cannot know (it is a registrar commercial term), so
 * that stays an owner-entered field. Everything else refreshes itself.
 *
 * Failure is always soft: a domain that will not resolve keeps whatever dates it already
 * has rather than blanking them, because a stale date is far more useful than no date.
 */

const TIMEOUT_MS = 12_000;
/** Politeness cap: RDAP endpoints are free infrastructure, so refreshes run in small waves. */
const CONCURRENCY = 4;

export interface DomainFacts {
  domain: string;
  /** ISO date the domain was first registered. */
  registeredAt?: string;
  /** ISO date the current registration expires. */
  expiresAt?: string;
  /** Registrar name as the registry reports it, e.g. "Dynadot Inc". */
  registrar?: string;
  /** Set when the lookup failed, for display rather than for throwing. */
  error?: string;
}

interface RdapEvent { eventAction?: string; eventDate?: string }
interface RdapEntity { roles?: string[]; vcardArray?: unknown }
interface RdapDomain { events?: RdapEvent[]; entities?: RdapEntity[] }

/** Pull the display name out of the jCard blob registries wrap registrar names in. */
function registrarName(entities: RdapEntity[] | undefined): string | undefined {
  for (const e of entities || []) {
    if (!(e.roles || []).includes("registrar")) continue;
    const card = e.vcardArray as [string, Array<[string, unknown, string, unknown]>] | undefined;
    for (const row of card?.[1] || []) {
      if (row[0] === "fn" && typeof row[3] === "string" && row[3].trim()) return row[3].trim();
    }
  }
  return undefined;
}

function eventDate(events: RdapEvent[] | undefined, action: string): string | undefined {
  for (const e of events || []) {
    if ((e.eventAction || "").toLowerCase() === action && e.eventDate) return e.eventDate;
  }
  return undefined;
}

/** Look one domain up. Never throws: a failure comes back as { error }. */
export async function lookupDomain(domain: string): Promise<DomainFacts> {
  const name = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return { domain, error: "not a domain name" };
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(name)}`, {
      headers: { Accept: "application/rdap+json, application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { domain: name, error: `registry returned ${res.status}` };
    const data = (await res.json().catch(() => null)) as RdapDomain | null;
    if (!data) return { domain: name, error: "unreadable registry response" };
    return {
      domain: name,
      registeredAt: eventDate(data.events, "registration"),
      expiresAt: eventDate(data.events, "expiration"),
      registrar: registrarName(data.entities),
    };
  } catch (e) {
    return { domain: name, error: (e as Error).name === "TimeoutError" ? "registry timed out" : "registry unreachable" };
  }
}

/** Look many up in small waves so a 40-domain fleet refreshes without hammering RDAP. */
export async function lookupDomains(domains: string[]): Promise<DomainFacts[]> {
  const out: DomainFacts[] = [];
  for (let i = 0; i < domains.length; i += CONCURRENCY) {
    out.push(...(await Promise.all(domains.slice(i, i + CONCURRENCY).map(lookupDomain))));
  }
  return out;
}

/** Whole days until expiry; negative once expired. null when the date is unknown. */
export function daysUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.now()) / 86_400_000);
}
