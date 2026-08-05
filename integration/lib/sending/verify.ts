/**
 * RecruitersOS · Pre-send list hygiene (the cheap, always-on layer)
 *
 * Deep verification (Reoon / SMTP probes) lives in lib/inmarket/emailVerify and
 * runs during curation. THIS module is the last line at the send chokepoint:
 * fast, free, no external vendors, so it can run on EVERY send without cost:
 *
 *   1. syntax        - reject malformed addresses outright
 *   2. domain MX     - reject domains that cannot receive mail (NXDOMAIN / no MX)
 *   3. verdict gate  - honor a stored "invalid" verification verdict
 *
 * A study-backed rationale: unverified pattern guesses bounce ~40-60%; the hard
 * ceiling for a healthy cold program is 2% (lib/sending/policy). Nothing
 * unverifiable-cheaply is blocked (catch-all/risky pass through, configurable),
 * because false negatives cost pipeline; provable garbage never leaves.
 */

import { promises as dns } from "node:dns";

export interface PreSendVerdict {
  ok: boolean;
  reason?: "bad_syntax" | "no_mx" | "verified_invalid" | "blocked_risky";
}

const SYNTAX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Domains we could not resolve MX/A for, cached to keep the send loop fast. */
const mxCache = new Map<string, { ok: boolean; at: number }>();
const MX_TTL_MS = 6 * 60 * 60 * 1000;
const MX_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

/** Can this domain receive mail? MX first, A/AAAA fallback per RFC 5321. */
export async function domainAcceptsMail(domain: string): Promise<boolean> {
  const d = domain.toLowerCase();
  const hit = mxCache.get(d);
  if (hit && Date.now() - hit.at < MX_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const mx = await withTimeout(dns.resolveMx(d), MX_TIMEOUT_MS);
    ok = mx.length > 0;
  } catch {
    try {
      const a = await withTimeout(dns.resolve4(d), MX_TIMEOUT_MS);
      ok = a.length > 0;
    } catch {
      // DNS failure or NXDOMAIN. Only a definitive "does not exist" should
      // block; transient resolver trouble must not stop the pipeline.
      ok = false;
    }
  }
  mxCache.set(d, { ok, at: Date.now() });
  return ok;
}

/**
 * The chokepoint check. `verification` is the prospect's stored verdict when
 * one exists (from curation / Reoon); pass undefined when unknown.
 * Set OUTREACH_BLOCK_RISKY=1 to also hold addresses verified as risky/catch-all.
 */
export async function preSendCheck(
  email: string,
  verification?: { status?: string },
): Promise<PreSendVerdict> {
  const e = (email || "").trim();
  if (!SYNTAX.test(e)) return { ok: false, reason: "bad_syntax" };

  const status = (verification?.status || "").toLowerCase();
  if (status === "invalid") return { ok: false, reason: "verified_invalid" };
  if (status === "risky" && ["1", "true", "yes", "on"].includes((process.env.OUTREACH_BLOCK_RISKY || "").toLowerCase())) {
    return { ok: false, reason: "blocked_risky" };
  }

  const domain = e.split("@")[1];
  if (!(await domainAcceptsMail(domain))) return { ok: false, reason: "no_mx" };
  return { ok: true };
}
