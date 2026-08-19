/**
 * RecruitersOS · Senders · new Email ID onboarding audit.
 *
 * Every inbox that enters a sender pool, from ANY import path (warm-up engine
 * sync, Sending.ac sync, CSV upload, future importers), is vetted within one
 * maintenance tick, BEFORE it can matter: the 2026-08 internal-SMTP saga
 * started with imports nobody test-drove (base64-stored passwords, a server IP
 * receivers were rejecting) and dashboards that only echoed the vendor's own
 * green lights. This audit asks the outside world instead:
 *
 *   - SMTP login: a real AUTH round-trip for boxes we hold credentials for
 *     (catches encoded-password imports, dead mailboxes, banned client IPs).
 *   - Domain posture: live SPF / DMARC / MX resolution + public blocklists
 *     (lib/sending/dnsProbe, real resolver answers, never vendor dashboards).
 *   - Mail server identity (own-SMTP fleets): the SMTP host's IPs must carry
 *     forward-confirmed rDNS (PTR that resolves back), the thing receivers
 *     check first and the thing nobody checks twice after setup day.
 *
 * Verdicts are stamped on the inbox (onboardAuditAt / onboardProblems), a
 * rolling report is snapshotted for the health board, and NEW problems email
 * the owner once (not every tick). Bounded per tick so a 1,500-box backfill
 * spreads over a day without hurting the cron. Fail-open on infrastructure
 * trouble: an audit that cannot run holds no mail hostage, it just stays
 * unstamped and retries next tick.
 */
import { promises as dns } from "node:dns";
import { loadSnapshot, saveSnapshot } from "../db";
import { listInboxes, saveInbox } from "./store";
import { verifyInbox, hasVerifiableSmtp } from "./smtp";
import type { SenderInbox } from "./types";

export interface OnboardFailure { subject: string; problems: string[] }
export interface OnboardRun { at: string; checked: number; failures: OnboardFailure[] }
interface OnboardSnap { runs?: OnboardRun[]; notifiedKey?: string }

const SNAP_KEY = "sender_onboarding_v1";

function perTick(): number {
  const n = Number(process.env.SENDER_ONBOARD_PER_TICK);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 60;
}
function loginsPerTick(): number {
  const n = Number(process.env.SENDER_ONBOARD_LOGINS_PER_TICK);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 30;
}

function timebox<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/**
 * Forward-confirmed rDNS for a mail host: each of its IPs needs a PTR, and the
 * PTR name must resolve back to that IP. Receivers run this exact test on every
 * connection; a host that fails it bounces before content is even read.
 */
async function fcrdnsProblems(host: string): Promise<string[]> {
  const problems: string[] = [];
  const ips = await timebox(dns.resolve4(host), 4000, [] as string[]);
  if (!ips.length) return [`mail server ${host} does not resolve`];
  for (const ip of ips.slice(0, 2)) {
    const ptrs = await timebox(dns.reverse(ip), 4000, [] as string[]);
    if (!ptrs.length) { problems.push(`mail server IP ${ip} has no reverse DNS (PTR)`); continue; }
    let confirmed = false;
    for (const p of ptrs.slice(0, 3)) {
      const back = await timebox(dns.resolve4(p), 4000, [] as string[]);
      if (back.includes(ip)) { confirmed = true; break; }
    }
    if (!confirmed) problems.push(`mail server IP ${ip} reverse DNS (${ptrs[0]}) does not resolve back to it`);
  }
  return problems;
}

/** Audit one workspace's unstamped inboxes. Returns how many were checked. */
async function auditWorkspace(
  ws: string,
  budget: { rows: number; logins: number },
  failures: OnboardFailure[],
): Promise<number> {
  const rows = (await listInboxes(ws)).filter((m) => !m.onboardAuditAt);
  if (!rows.length) return 0;
  const batch = rows
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")) // newest imports first
    .slice(0, budget.rows);

  // Domain posture: one probe per distinct domain (cached 6h in dnsProbe).
  const { probeDnsMany } = await import("../sending/dnsProbe");
  const domains = [...new Set(batch.map((m) => m.email.split("@")[1] || "").filter(Boolean))];
  const posture = await probeDnsMany(domains);
  const domainProblems = new Map<string, string[]>();
  for (const [d, p] of posture) {
    const probs: string[] = [];
    if (!p.mx) probs.push("domain has no MX record (mail cannot be received or replied to)");
    if (!p.spf) probs.push("SPF record missing (receivers will distrust every send)");
    if (!p.dmarc) probs.push("DMARC record missing");
    if (p.dnsbl?.listed) probs.push(`domain or its mail IP is on a public blocklist (${p.dnsbl.lists.join(", ")})`);
    if (probs.length) domainProblems.set(d, probs);
  }

  // Mail server identity, once per distinct own-SMTP host in the batch.
  const hostProblems = new Map<string, string[]>();
  for (const host of [...new Set(batch.filter((m) => m.provider === "own-smtp" && m.smtpHost).map((m) => m.smtpHost!.toLowerCase()))]) {
    try { hostProblems.set(host, await fcrdnsProblems(host)); } catch { /* retry next tick via unstamped rows */ }
  }

  const at = new Date().toISOString();
  let checked = 0;
  for (const m of batch) {
    const problems: string[] = [];
    const d = m.email.split("@")[1] || "";
    problems.push(...(domainProblems.get(d) || []));
    if (m.smtpHost && hostProblems.has(m.smtpHost.toLowerCase())) problems.push(...hostProblems.get(m.smtpHost.toLowerCase())!);
    if (hasVerifiableSmtp(m) && budget.logins > 0) {
      budget.logins--;
      try {
        const v = await verifyInbox(m);
        if (!v.ok) problems.push(`SMTP login failing: ${String(v.error || "auth rejected").slice(0, 120)}`);
      } catch (e: any) {
        problems.push(`SMTP login failing: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    m.onboardAuditAt = at;
    m.onboardProblems = problems.length ? problems : undefined;
    try { await saveInbox(m); } catch { /* one row */ }
    if (problems.length) failures.push({ subject: m.email, problems });
    checked++;
  }
  return checked;
}

/**
 * The cron entrypoint: audit inboxes that have never been audited, across every
 * sender workspace, within this tick's budget. Alerts the owner when the set of
 * failing subjects CHANGES (never a repeat email for a known, unchanged state).
 */
export async function auditPendingOnboards(): Promise<{ checked: number; failures: number; notified: boolean }> {
  const { listSenderWorkspaceIds } = await import("./store");
  const budget = { rows: perTick(), logins: loginsPerTick() };
  const failures: OnboardFailure[] = [];
  let checked = 0;
  for (const ws of await listSenderWorkspaceIds()) {
    if (budget.rows <= 0) break;
    const n = await auditWorkspace(ws, budget, failures);
    budget.rows -= n;
    checked += n;
  }
  if (!checked) return { checked: 0, failures: 0, notified: false };

  const prev = (await loadSnapshot<OnboardSnap>(SNAP_KEY)) || {};
  const run: OnboardRun = { at: new Date().toISOString(), checked, failures };
  const runs = [run, ...(prev.runs || [])].slice(0, 20);

  // Owner alert: once per distinct failure set, in plain words, no vendor names.
  let notified = false;
  let notifiedKey = prev.notifiedKey;
  const key = failures.map((f) => f.subject).sort().join(",");
  if (failures.length && key !== prev.notifiedKey) {
    try {
      const { notifyOwner, noticeConfigured } = await import("../owner/ownerNotice");
      if (noticeConfigured()) {
        const lines = failures.slice(0, 15).map((f) => `- ${f.subject}: ${f.problems.join("; ")}`);
        const more = failures.length > 15 ? `\n(and ${failures.length - 15} more, listed on the System Health board)` : "";
        const res = await notifyOwner({
          subject: `New Email IDs need attention (${failures.length})`,
          body: `The onboarding audit checked ${checked} newly imported Email IDs and found problems with ${failures.length}:\n\n${lines.join("\n")}${more}\n\nThese boxes are still tracked, but fix the listed items before relying on them for sending. The System Health board (New sender onboarding audit) shows the current state.`,
        });
        notified = !!res?.ok;
        if (notified) notifiedKey = key;
      }
    } catch { /* alerting is best-effort; the health board still shows it */ }
  }

  await saveSnapshot(SNAP_KEY, { runs, notifiedKey } satisfies OnboardSnap);
  return { checked, failures: failures.length, notified };
}
