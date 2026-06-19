/**
 * RecruitersOS · In-Market · Free email deliverability verification
 *
 * The curated email is a free SYNTAX guess (first.last@domain). Before it reaches BD Bulk we
 * want to drop the ones that can't possibly deliver — for free, and WITHOUT hurting sender
 * reputation. This module is the internal, zero-cost verifier that feeds the existing
 * validation seam (curation.applyEmailValidation): the external paid validator (if ever wired)
 * still supersedes it, but on its own this removes the bulk of dead addresses at $0.
 *
 * Three free, safe signals (no SMTP handshake by default — RCPT probing from an app server is
 * unreliable and can get the IP blocklisted, so it's opt-in only):
 *   1. SYNTAX     — well-formed local@domain with a real dotted domain.
 *   2. ROLE       — info@, sales@, careers@ … are mailboxes, not PEOPLE; for 1:1 BD outreach
 *                   they're noise, so we treat them as not-deliverable-as-a-person.
 *   3. DISPOSABLE — throwaway domains never belong to a real employer.
 *   4. MX         — the domain must publish MX records (it can receive mail at all).
 *
 * Verdict model (deliberately conservative — we NEVER mark a guess "valid" we can't confirm):
 *   - "undeliverable" → role / disposable / malformed / no-MX  → marked invalid (won't enroll)
 *   - "ok"            → passes every free check                → left for the external validator
 *                       to confirm (or, with INMARKET_SMTP_VERIFY=1, an opt-in RCPT probe)
 * So this makes the funnel's `invalid` count REAL and stops dead emails from enrolling, while
 * never producing a false "valid".
 */

import { promises as dns } from "dns";
import net from "net";
import { mxStatus } from "./domain";

/** Role / functional mailboxes — real addresses, but not a PERSON to run 1:1 BD against. */
const ROLE_LOCALS = new Set([
  "info", "sales", "support", "contact", "hello", "admin", "help", "team", "office",
  "hr", "jobs", "careers", "recruiting", "talent", "people", "marketing", "press", "media",
  "billing", "accounts", "accounting", "finance", "legal", "privacy", "security", "abuse",
  "webmaster", "postmaster", "noreply", "no-reply", "donotreply", "mail", "newsletter",
  "general", "enquiries", "inquiries", "service", "customerservice", "feedback", "hi",
]);

/** A small set of common disposable / throwaway domains. */
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org",
  "throwaway.email", "yopmail.com", "trashmail.com", "getnada.com", "maildrop.cc",
  "sharklasers.com", "dispostable.com", "fakeinbox.com", "mailnesia.com",
]);

const EMAIL_RE = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export type Verdict = "undeliverable" | "ok";

export interface EmailCheck {
  email: string;
  verdict: Verdict;
  reason: string;
  /** true once an opt-in SMTP probe positively confirmed the mailbox (rare; off by default). */
  confirmed?: boolean;
}

function parts(email: string): { local: string; domain: string } | null {
  const e = (email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return null;
  const at = e.lastIndexOf("@");
  return { local: e.slice(0, at), domain: e.slice(at + 1) };
}

/**
 * Free deliverability check for ONE email. MX is cached per domain by the caller's batch
 * (we still resolve here so a single check works standalone). Best-effort: a DNS failure is
 * treated as undeliverable only when MX is the deciding factor.
 */
export async function checkEmailFree(
  email: string,
  opts?: { smtp?: boolean; mx?: "mx" | "none" | "error" },
): Promise<EmailCheck> {
  const p = parts(email);
  if (!p) return { email, verdict: "undeliverable", reason: "malformed" };
  if (ROLE_LOCALS.has(p.local)) return { email, verdict: "undeliverable", reason: "role_account" };
  if (DISPOSABLE.has(p.domain)) return { email, verdict: "undeliverable", reason: "disposable" };

  // Only a DEFINITIVELY dead domain (NXDOMAIN) is undeliverable. "no MX but the domain exists"
  // and transient DNS failures stay "ok" (pending) — we must NEVER permanently suppress a real
  // prospect because of one DNS hiccup or an implicit-MX mail setup.
  const mx = opts?.mx ?? (await mxStatus(p.domain));
  if (mx === "none") return { email, verdict: "undeliverable", reason: "domain_not_found" };

  // Opt-in only: an SMTP RCPT probe that POSITIVELY confirms the mailbox. Off by default
  // because it's unreliable (greylisting, catch-all, server bans). When it confirms, great;
  // anything else falls through to "ok" (left for the external validator), never "invalid".
  if (opts?.smtp || process.env.INMARKET_SMTP_VERIFY === "1") {
    const confirmed = await smtpRcptProbe(email, p.domain).catch(() => null);
    if (confirmed === true) return { email, verdict: "ok", reason: "smtp_confirmed", confirmed: true };
    if (confirmed === false) return { email, verdict: "undeliverable", reason: "smtp_rejected" };
  }

  return { email, verdict: "ok", reason: "passes_free_checks" };
}

/**
 * Batch verifier: groups by domain so MX is resolved ONCE per domain (not per address), then
 * checks every email. Returns the verdicts in `applyEmailValidation` shape
 * ({ email, valid }) — undeliverable → valid:false. "ok" rows are returned with valid:true
 * ONLY when an SMTP probe confirmed them; otherwise they're omitted so they stay pending for
 * the external validator (we never assert a "valid" we can't prove).
 */
export async function verifyEmailsFree(
  emails: string[],
  opts?: { smtp?: boolean },
): Promise<Array<{ email: string; valid: boolean }>> {
  const uniq = [...new Set(emails.map((e) => (e || "").trim().toLowerCase()).filter(Boolean))];
  // Resolve MX status once per domain (transient failures default to "error" → never suppressed).
  const domains = [...new Set(uniq.map((e) => e.slice(e.lastIndexOf("@") + 1)).filter(Boolean))];
  const mxByDomain = new Map<string, "mx" | "none" | "error">();
  await Promise.all(domains.map(async (d) => { mxByDomain.set(d, await mxStatus(d).catch(() => "error" as const)); }));

  const out: Array<{ email: string; valid: boolean }> = [];
  for (const email of uniq) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const c = await checkEmailFree(email, { smtp: opts?.smtp, mx: mxByDomain.get(domain) }).catch(() => null);
    if (!c) continue;
    if (c.verdict === "undeliverable") out.push({ email, valid: false });
    else if (c.confirmed) out.push({ email, valid: true });
    // "ok" but unconfirmed → omit (stays pending for the external validator)
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Opt-in SMTP RCPT probe (off by default — see note above)            */
/* ------------------------------------------------------------------ */

/**
 * Best-effort SMTP RCPT check. Returns true (accepted), false (hard-rejected), or null
 * (inconclusive: greylist, catch-all, timeout, blocked). Conservative + short-timeout. Never
 * sends a DATA payload, so no mail is ever delivered. OFF unless explicitly enabled.
 */
async function smtpRcptProbe(email: string, domain: string): Promise<boolean | null> {
  const mx = await dns.resolveMx(domain).catch(() => [] as Array<{ priority: number; exchange: string }>);
  if (!mx.length) return null;
  const host = mx.sort((a, b) => a.priority - b.priority)[0].exchange;
  const from = process.env.INMARKET_SMTP_FROM || "verify@recruiteros.app";

  // Rotate the SMTP probe's source IP across the egress pool too (when configured), so a single
  // host's MTA doesn't see every RCPT probe from one IP.
  let localAddress: string | undefined;
  try { localAddress = (await import("../net/egress")).nextSourceIp(); } catch { /* no rotation */ }

  return new Promise<boolean | null>((resolve) => {
    const sock = net.createConnection(localAddress ? { port: 25, host, localAddress } : { port: 25, host });
    let stage = 0;
    let settled = false;
    const done = (v: boolean | null) => { if (!settled) { settled = true; try { sock.write("QUIT\r\n"); sock.end(); } catch {} resolve(v); } };
    sock.setTimeout(6_000, () => done(null));
    sock.on("error", () => done(null));
    sock.on("data", (buf) => {
      const line = buf.toString();
      const code = parseInt(line.slice(0, 3), 10);
      if (stage === 0) { if (code === 220) { sock.write(`HELO recruiteros.app\r\n`); stage = 1; } else done(null); }
      else if (stage === 1) { if (code < 400) { sock.write(`MAIL FROM:<${from}>\r\n`); stage = 2; } else done(null); }
      else if (stage === 2) { if (code < 400) { sock.write(`RCPT TO:<${email}>\r\n`); stage = 3; } else done(null); }
      else if (stage === 3) { if (code >= 200 && code < 300) done(true); else if (code >= 500 && code < 560) done(false); else done(null); }
    });
  });
}
