/**
 * RecruitersOS · Senders · per-domain deliverability health
 *
 * The rich health engine in lib/sending/* (SPF/DKIM/DMARC/PTR + bounce metrics)
 * only covers RecruitersOS-provisioned Postal domains. The bring-your-own-SMTP
 * inboxes tracked here (lib/senders) send over the recruiter's OWN domains, which
 * that engine never sees. This module gives those custom domains a light-weight
 * deliverability read: a live keyless DNS check of the four auth records receivers
 * care about (SPF/DKIM/DMARC/MX) plus a bounce rate rolled up from the inboxes'
 * own sent/bounced counters.
 *
 * No new deps and no keys: DNS is resolved over Google's DNS-over-HTTPS endpoint,
 * the same keyless approach the sending provisioner's verifier uses.
 */

import type { SenderInbox } from "./types";
import { getHealthCache, setHealthCache, listInboxes, workspacesWithInboxes } from "./store";

export interface SenderDomainHealth {
  domain: string;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  mx: boolean;
  inboxCount: number;
  sent: number;
  bounced: number;
  bounceRatePct: number;
}

/** DNS-over-HTTPS lookup (Google), keyless. Returns answer data strings. */
async function dohResolve(name: string, type: string): Promise<string[]> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, {
      headers: { accept: "application/dns-json" },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { Answer?: Array<{ data: string; type: number }> };
    return (j.Answer || []).map((a) => a.data.replace(/^"|"$/g, "").replace(/" "/g, ""));
  } catch {
    return [];
  }
}

function domainOf(email: string): string {
  const i = email.indexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase().trim() : "";
}

/** True when any TXT answer at the name contains the given (lower-cased) marker. */
function txtHas(answers: string[], marker: string): boolean {
  const m = marker.toLowerCase();
  return answers.some((a) => a.toLowerCase().includes(m));
}

async function checkDomain(domain: string, inboxes: SenderInbox[]): Promise<SenderDomainHealth> {
  // Mailcow (and most self-hosted stacks) publish the DKIM key under the `dkim`
  // selector by default; that's the selector this fleet was stood up with.
  const [apexTxt, dkimTxt, dmarcTxt, mx] = await Promise.all([
    dohResolve(domain, "TXT"),
    dohResolve(`dkim._domainkey.${domain}`, "TXT"),
    dohResolve(`_dmarc.${domain}`, "TXT"),
    dohResolve(domain, "MX"),
  ]);

  let sent = 0, bounced = 0;
  for (const m of inboxes) { sent += m.sent || 0; bounced += m.bounced || 0; }
  const bounceRatePct = sent > 0 ? Math.round((bounced / sent) * 1000) / 10 : 0;

  return {
    domain,
    spf: txtHas(apexTxt, "v=spf1"),
    // DKIM records sometimes omit the v= tag; the public key tag p= is the reliable signal.
    dkim: txtHas(dkimTxt, "v=dkim1") || txtHas(dkimTxt, "p="),
    dmarc: txtHas(dmarcTxt, "v=dmarc1"),
    mx: mx.length > 0,
    inboxCount: inboxes.length,
    sent,
    bounced,
    bounceRatePct,
  };
}

/**
 * Per-domain deliverability health across every distinct sending domain in the
 * given inbox set. One DNS pass + bounce rollup per domain, all domains resolved
 * concurrently. Sorted by inbox count (busiest domain first).
 */
export async function sendersDomainHealth(inboxes: SenderInbox[]): Promise<SenderDomainHealth[]> {
  const byDomain = new Map<string, SenderInbox[]>();
  for (const m of inboxes) {
    const d = domainOf(m.email);
    if (!d) continue;
    let arr = byDomain.get(d);
    if (!arr) { arr = []; byDomain.set(d, arr); }
    arr.push(m);
  }
  const out = await Promise.all([...byDomain.entries()].map(([d, ms]) => checkDomain(d, ms)));
  return out.sort((a, b) => b.inboxCount - a.inboxCount || a.domain.localeCompare(b.domain));
}

/* ------------------------------------------------------------------------- *
 * Cached health: the tab renders instantly from the last sweep instead of
 * hammering DNS on every view; a stale cache self-heals in the background,
 * and a cron-authed sweep can keep every workspace fresh on a timer.
 * ------------------------------------------------------------------------- */

export interface SendersHealthSnapshot {
  checkedAt: string;
  domains: SenderDomainHealth[];
  stale: boolean;
}

const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;   // consider a sweep fresh for 6 hours

/** One live check per workspace at a time — concurrent viewers share the run. */
const inFlight = new Map<string, Promise<SendersHealthSnapshot>>();

function isFresh(checkedAt: string): boolean {
  const t = Date.parse(checkedAt);
  return Number.isFinite(t) && Date.now() - t < HEALTH_TTL_MS;
}

/**
 * Run (or join) a live DNS sweep for the workspace and cache the result.
 * `force` re-checks even when the cache is fresh (the UI's Refresh button).
 */
export async function ensureSendersHealth(workspaceId: string, force = false): Promise<SendersHealthSnapshot> {
  const cached = await getHealthCache(workspaceId);
  if (cached && !force && isFresh(cached.checkedAt)) return { ...cached, stale: false };
  const running = inFlight.get(workspaceId);
  if (running) return running;
  const run = (async () => {
    try {
      const inboxes = await listInboxes(workspaceId);
      const domains = await sendersDomainHealth(inboxes);
      const checkedAt = new Date().toISOString();
      await setHealthCache(workspaceId, { checkedAt, domains });
      return { checkedAt, domains, stale: false };
    } finally {
      inFlight.delete(workspaceId);
    }
  })();
  inFlight.set(workspaceId, run);
  return run;
}

/**
 * Cache-first read for GET: returns the last sweep immediately (flagged stale
 * when past TTL) and kicks a background refresh so the next view is fresh.
 * Null when no sweep has ever run for the workspace.
 */
export async function peekSendersHealth(workspaceId: string): Promise<SendersHealthSnapshot | null> {
  const cached = await getHealthCache(workspaceId);
  if (!cached) return null;
  const fresh = isFresh(cached.checkedAt);
  if (!fresh) void ensureSendersHealth(workspaceId).catch(() => {});
  return { ...cached, stale: !fresh };
}

/** Refresh every workspace that has inboxes (cron-authed timer endpoint). */
export async function sweepSendersHealth(): Promise<{ workspaces: number; domains: number }> {
  const ids = await workspacesWithInboxes();
  let domains = 0;
  for (const ws of ids) {
    const s = await ensureSendersHealth(ws, true);
    domains += s.domains.length;
  }
  return { workspaces: ids.length, domains };
}
