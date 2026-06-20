/**
 * RecruitersOS · Egress IP rotation
 *
 * The Hire Signals engine pulls tens of thousands of free pages/day (public ATS boards, company
 * homepages for domain verification, news/RSS, GitHub). Free sources rate-limit PER SOURCE IP, so
 * a single server IP is the ceiling on volume. The fix the user chose: assign several extra
 * Hetzner IPs to the box and ROTATE outbound requests across them, so each source sees ~1/N of
 * our traffic and we stay 100% free while hitting 5K+ verified prospects/day.
 *
 * This binds each outbound socket to a specific local source address (undici `connect.localAddress`)
 * and round-robins across the configured pool. It is SCOPED — only the free-source fetches opt in
 * via `egressInit()`; paid/critical egress (Anthropic, Telnyx, …) keeps the default route, so a
 * mis-assigned IP can never silently break those.
 *
 * Configuration (all optional — with none set this module is a complete no-op and fetch behaves
 * exactly as before):
 *   INMARKET_EGRESS_IPS   = "1.2.3.4,1.2.3.5,…"   extra IPv4 source addresses assigned to the host
 *   INMARKET_EGRESS_IPV6  = "2a01:…::10,2a01:…::11" optional explicit IPv6 sources, OR
 *   INMARKET_EGRESS_IPV6_BASE = "2a01:…::"  +  INMARKET_EGRESS_IPV6_COUNT = "16"
 *                           → auto-generate N addresses from the free /64 (…::1 … …::N)
 *
 * The host must actually have these addresses on its interface (Hetzner routes them to the box;
 * `ip addr add <ip> dev eth0`). Until then, binding would fail — so we keep the default route as a
 * member of the rotation, guaranteeing requests still go out even if some IPs aren't up yet.
 */

import { Agent, type Dispatcher } from "undici";

let pool: Dispatcher[] | null = null;     // one dispatcher per source IP (+ the default route)
let labels: string[] = [];                // human labels, parallel to pool (for diagnostics)
let cursor = 0;
let built = false;

function ipv6FromBase(): string[] {
  const base = (process.env.INMARKET_EGRESS_IPV6_BASE || "").trim();
  const count = Math.max(0, Math.min(Number(process.env.INMARKET_EGRESS_IPV6_COUNT) || 0, 256));
  if (!base || !count) return [];
  // base like "2a01:4f8:abc:def::" → generate ::1 .. ::count (hex). The /64 is free on Hetzner.
  const out: string[] = [];
  const root = base.endsWith("::") ? base.slice(0, -1) : base; // keep one trailing ':'
  for (let i = 1; i <= count; i++) out.push(`${root}:${i.toString(16)}`);
  return out;
}

function parseList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build the rotation pool once, lazily. Cheap; safe to call on every request. */
function build(): void {
  if (built) return;
  built = true;
  const v4 = parseList("INMARKET_EGRESS_IPS");
  const v6 = [...parseList("INMARKET_EGRESS_IPV6"), ...ipv6FromBase()];
  const ips = [...v4, ...v6];
  if (!ips.length) { pool = null; return; } // not configured → no-op

  const dispatchers: Dispatcher[] = [];
  const lbl: string[] = [];
  for (const ip of ips) {
    try {
      // Bind every connection this agent opens to the given source IP. Keep timeouts tight so a
      // dead IP fails fast and the next request rotates past it rather than stalling the engine.
      dispatchers.push(new Agent({ connect: { localAddress: ip }, connectTimeout: 8_000 }));
      lbl.push(ip);
    } catch { /* skip an address Node won't accept */ }
  }
  // Always include the default route (no localAddress) as a fallback member, so the engine keeps
  // pulling even while some purchased IPs aren't yet configured on the interface.
  dispatchers.push(new Agent({ connectTimeout: 8_000 }));
  lbl.push("default");
  pool = dispatchers;
  labels = lbl;
}

/** True when at least one extra egress IP is configured (rotation is active). */
export function egressEnabled(): boolean {
  build();
  return !!pool && pool.length > 1; // >1 because the default route is always a member
}

/** The configured source-IP labels (for the engine-health / diagnostics surface). */
export function egressIps(): string[] {
  build();
  return labels.slice();
}

/** Next dispatcher in the rotation, or undefined when rotation isn't configured. */
export function nextDispatcher(): Dispatcher | undefined {
  build();
  if (!pool || !pool.length) return undefined;
  const d = pool[cursor % pool.length];
  cursor++;
  return d;
}

/** Next NON-default (real bound-IP) dispatcher in the rotation, or undefined when none is
 *  configured. Used by egressFetch so we can try a rotated IP first and fall back to the default
 *  route on failure — a dispatcher that round-robins onto the default route would defeat that. */
function nextRotatedDispatcher(): Dispatcher | undefined {
  build();
  if (!pool || pool.length <= 1) return undefined; // only the default route present
  // pool's last member is always the default route; rotate across the real IPs (all but the last).
  const realCount = pool.length - 1;
  const d = pool[cursor % realCount];
  cursor++;
  return d;
}

/**
 * Resilient free-source fetch: try a rotated source IP first, and on a CONNECT/NETWORK failure
 * (timeout, unreachable IPv6, DNS) retry ONCE on the default route. This is what stops a broken or
 * unroutable egress IP from silently killing the scraper (the "scraping idle" failure mode): the
 * request still goes out the main interface. HTTP error statuses do NOT throw, so a 4xx/5xx is
 * returned as-is (no wasteful double fetch). When rotation isn't configured it's a plain fetch.
 */
export async function egressFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const d = nextRotatedDispatcher();
  if (d) {
    try {
      return await fetch(url, { ...init, dispatcher: d } as RequestInit & { dispatcher: Dispatcher });
    } catch {
      /* rotated IP couldn't connect / timed out — fall through to the default route */
    }
  }
  // The fallback MUST get a FRESH abort signal. The rotated attempt above usually fails by FIRING the
  // caller's AbortSignal.timeout — reusing that already-aborted signal here would insta-abort the
  // fallback, silently killing it. That bug collapsed domain resolution (and team-page fetches) to
  // ~1% whenever IPv6 egress was flaky: every request timed out on the rotated IP and the "fallback"
  // never actually ran. A fresh 8s timeout makes the default-route fallback real.
  const { signal: _stale, ...rest } = init as RequestInit & { signal?: AbortSignal };
  return fetch(url, { ...rest, signal: AbortSignal.timeout(8000) });
}

let ipCursor = 0;
/**
 * Next raw source IP for non-fetch sockets (e.g. the opt-in SMTP RCPT probe's net.createConnection
 * localAddress), or undefined when rotation isn't configured / only the default route exists.
 */
export function nextSourceIp(): string | undefined {
  build();
  const real = labels.filter((l) => l !== "default");
  if (!real.length) return undefined;
  const ip = real[ipCursor % real.length];
  ipCursor++;
  return ip;
}

/**
 * Merge a rotating egress dispatcher into a fetch init. Use for FREE-SOURCE fetches only:
 *
 *   const res = await fetch(url, egressInit({ signal: AbortSignal.timeout(10_000), headers }));
 *
 * When no extra IPs are configured this returns `init` unchanged, so it's always safe to wrap.
 * `dispatcher` is an undici extension to RequestInit; cast keeps the DOM types happy.
 */
export function egressInit(init: RequestInit = {}): RequestInit {
  const d = nextDispatcher();
  if (!d) return init;
  return { ...init, dispatcher: d } as RequestInit & { dispatcher: Dispatcher } as RequestInit;
}
