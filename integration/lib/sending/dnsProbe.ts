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
  checkedAt: string;
}

const TTL_MS = 6 * 60 * 60 * 1000; // 6h; posture changes rarely
const cache = new Map<string, { at: number; posture: DnsPosture }>();

const DKIM_SELECTORS = ["smtp", "default", "google", "k1", "s1", "mail"];

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
