/**
 * RecruitersOS · Live DNS posture probe
 *
 * Real resolver lookups (not the desired-record computation in dns.ts) for
 * domains whose mail is hosted upstream, e.g. the warm-up fleet. Answers one
 * question per domain: is its authentication posture (SPF / DKIM / DMARC / MX)
 * actually visible on the public internet right now?
 *
 * DKIM is probed across the common selector set since the hosting provider
 * picks the selector; "not found" therefore means "not visible on the usual
 * selectors", not proof of absence, and is surfaced as a soft warning only.
 *
 * Lookups are cached in-process (DNS posture changes rarely) and every query
 * is timeboxed so a dead resolver can never stall a request thread.
 */

import { promises as dns } from "dns";

export interface DnsblStatus {
  /** True when the domain or its mail IP answered positively on a blocklist. */
  listed: boolean;
  /** Which lists hit (e.g. "spamhaus-dbl", "spamhaus-zen"). Empty when clean. */
  lists: string[];
}

export interface DnsPosture {
  domain: string;
  spf: boolean;
  spfRecord?: string;
  dmarc: boolean;
  dmarcPolicy?: string;
  dkim: boolean;
  dkimSelector?: string;
  mx: boolean;
  mxHosts?: string[];
  /** Public spam-blocklist posture (best-effort; some resolvers refuse DNSBL queries). */
  dnsbl: DnsblStatus;
  checkedAt: string;
}

const TTL_MS = 6 * 60 * 60 * 1000; // 6h; posture changes rarely
const cache = new Map<string, { at: number; posture: DnsPosture }>();

// Order matters: the first hit wins, so the highest-prevalence selectors lead.
// selector1/selector2 are Microsoft 365's fixed pair (the bulk of the fleet);
// dkim/smtp/default cover the self-hosted mail server; the rest are common
// ESP selectors. Missing selector1/selector2 was why M365 domains showed a
// false "DKIM missing".
const DKIM_SELECTORS = ["selector1", "selector2", "dkim", "smtp", "default", "google", "k1", "s1", "mail", "mx", "s1024", "sig1"];

function timebox<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

async function txt(name: string): Promise<string[]> {
  const rows = await timebox(dns.resolveTxt(name), 3000, [] as string[][]);
  return rows.map((chunks) => chunks.join(""));
}

async function aRecords(name: string): Promise<string[]> {
  return timebox(dns.resolve4(name), 3000, [] as string[]);
}

/**
 * A DNSBL answer is a positive hit only in the designated 127.0.x.y ranges.
 * 127.255.x.y means the query was REFUSED (typically an open public resolver),
 * which must never read as "listed"; NXDOMAIN (empty here) means clean.
 */
function dnsblHit(answers: string[]): boolean {
  return answers.some((ip) => /^127\.0\.\d+\.\d+$/.test(ip) && !ip.startsWith("127.255."));
}

/**
 * Public spam-blocklist check for a sending domain: the domain itself against
 * Spamhaus DBL, and its A/MX IPs against Spamhaus ZEN. Best-effort by design:
 * refused or timed-out queries read as clean, so this can flag a real listing
 * but never false-alarms a healthy domain.
 */
async function probeDnsbl(domain: string, mxHosts: string[]): Promise<DnsblStatus> {
  const lists: string[] = [];
  try {
    if (dnsblHit(await aRecords(`${domain}.dbl.spamhaus.org`))) lists.push("spamhaus-dbl");
    const ips = new Set<string>(await aRecords(domain));
    if (mxHosts[0]) for (const ip of await aRecords(mxHosts[0])) ips.add(ip);
    for (const ip of [...ips].slice(0, 3)) {
      const reversed = ip.split(".").reverse().join(".");
      if (dnsblHit(await aRecords(`${reversed}.zen.spamhaus.org`))) { lists.push("spamhaus-zen"); break; }
    }
  } catch { /* best-effort */ }
  return { listed: lists.length > 0, lists };
}

export async function probeDns(domain: string): Promise<DnsPosture> {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.posture;

  const [rootTxt, dmarcTxt, mxRows] = await Promise.all([
    txt(domain),
    txt(`_dmarc.${domain}`),
    timebox(dns.resolveMx(domain), 3000, [] as { exchange: string; priority: number }[]),
  ]);

  const spfRecord = rootTxt.find((t) => /^v=spf1\b/i.test(t.trim()));
  const dmarcRecord = dmarcTxt.find((t) => /^v=DMARC1\b/i.test(t.trim()));
  const dmarcPolicy = dmarcRecord ? (/[;\s]p\s*=\s*([a-z]+)/i.exec(dmarcRecord)?.[1] || undefined) : undefined;

  const dkimRows = await Promise.all(DKIM_SELECTORS.map(async (sel) => ({
    sel,
    hit: (await txt(`${sel}._domainkey.${domain}`)).some((t) => /v=DKIM1|k=rsa|p=[A-Za-z0-9+/]/.test(t)),
  })));
  const dkimHit = dkimRows.find((r) => r.hit);
  const dkim = !!dkimHit;
  const dkimSelector = dkimHit?.sel;

  const dnsbl = await probeDnsbl(domain, mxRows.map((m) => m.exchange));

  const posture: DnsPosture = {
    domain,
    spf: !!spfRecord,
    spfRecord,
    dmarc: !!dmarcRecord,
    dmarcPolicy,
    dkim,
    dkimSelector,
    mx: mxRows.length > 0,
    mxHosts: mxRows.length ? mxRows.map((m) => m.exchange) : undefined,
    dnsbl,
    checkedAt: new Date().toISOString(),
  };
  cache.set(domain, { at: Date.now(), posture });
  return posture;
}

/** Cached posture only (no lookups). Lets a timeboxed caller pick up whatever
 *  an in-flight probe has already resolved, and the rest on its next poll. */
export function cachedDns(domain: string): DnsPosture | null {
  const hit = cache.get(domain);
  return hit && Date.now() - hit.at < TTL_MS ? hit.posture : null;
}

/** Probe many domains with bounded concurrency (best-effort, never throws). */
export async function probeDnsMany(domains: string[], concurrency = 8): Promise<Map<string, DnsPosture>> {
  const out = new Map<string, DnsPosture>();
  const queue = [...domains];
  async function worker() {
    for (;;) {
      const d = queue.shift();
      if (!d) return;
      try {
        out.set(d, await probeDns(d));
      } catch {
        /* best-effort */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length || 1) }, worker));
  return out;
}
