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
import { emailPermutations, emailDomainFrom, splitFullName } from "./email";

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
/* Email FINDER — verify MORE prospects the right way (opt-in)          */
/* ------------------------------------------------------------------ */

/** True when SMTP verification/finding is enabled. Off by default: it needs outbound port 25
 *  (commonly blocked on cloud hosts — on Hetzner you must request an unblock), and probing from a
 *  shared IP carries some blocklist risk, so it's an explicit opt-in. */
export function smtpEnabled(): boolean {
  return process.env.INMARKET_SMTP_VERIFY === "1" || process.env.INMARKET_EMAIL_FINDER === "1";
}

/** True when the Reoon Email Verifier is configured. Reoon confirms deliverability CLOUD-SIDE
 *  (a real mailbox check) with NO outbound port 25 — so it works on hosts like Hetzner that block
 *  port 25. This is what actually promotes a guessed address from "guess" to "validated_external". */
export function reoonEnabled(): boolean {
  return !!process.env.REOON_API_KEY;
}

/**
 * Verify a batch of emails through the Reoon Email Verifier API (power mode = real mailbox check).
 * Maps Reoon's verdict to the binary { email, valid } the curation seam expects:
 *   valid:true  — status "safe" / is_safe_to_send / is_deliverable     (mailbox confirmed)
 *   valid:false — invalid / disabled / disposable / spamtrap / no-MX    (definitively dead)
 *   omitted     — catch_all / unknown / role_account / inbox_full       (uncertain → stays pending)
 * We never assert a "valid" Reoon couldn't confirm. Bounded concurrency; transient errors leave the
 * address pending for the next tick. Same endpoint + mapping as the standalone email-validate tool.
 */
export async function verifyEmailsReoon(
  emails: string[],
  opts?: { concurrency?: number },
): Promise<Array<{ email: string; valid: boolean }>> {
  const key = process.env.REOON_API_KEY;
  if (!key) return [];
  const mode = process.env.REOON_VERIFY_MODE || "power";
  const uniq = [...new Set(emails.map((e) => (e || "").trim().toLowerCase()).filter(Boolean))];
  const out: Array<{ email: string; valid: boolean }> = [];
  const conc = Math.max(1, Math.min(opts?.concurrency ?? 6, 12));
  let i = 0;
  async function worker(): Promise<void> {
    while (i < uniq.length) {
      const email = uniq[i++];
      try {
        const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key!)}&mode=${encodeURIComponent(mode)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) continue; // transient → leave pending
        const r = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!r) continue;
        const status = String(r.status ?? "").toLowerCase();
        // Match the standalone email-validate mapping: ONLY "safe" is a confirmed mailbox.
        // (is_deliverable/is_safe_to_send alone over-trust free providers like Gmail, which
        // accept mail for non-existent users — hence Reoon is reliable for business domains.)
        if (status === "safe") out.push({ email, valid: true });
        else if (["invalid", "disabled", "disposable", "spamtrap"].includes(status) || r.mx_accepts_mail === false) out.push({ email, valid: false });
        // catch_all / unknown / role_account / inbox_full / anything else → omit (stays pending)
      } catch { /* leave pending; retried next tick */ }
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return out;
}

export interface FoundEmail { email: string; pattern: string; verified: true }

/**
 * EMAIL FINDER — the correct way to turn more guesses into VALID prospects. Instead of enrolling a
 * single blind guess (≈40% right → ≈60% bounce), walk the person's ranked permutations and
 * SMTP-verify each until the mail server ACCEPTS one. That accepted address is real.
 *
 * Catch-all guarded: many domains accept mail for ANY local-part, so an "accept" there proves
 * nothing. We first probe a random, certainly-nonexistent address — if THAT is accepted the domain
 * is catch-all and we bail (return null) rather than emit a confident-but-wrong address. Bounded
 * (a few probes), short-timeout, IP-rotated. No DATA is ever sent, so no mail is delivered.
 *
 * Returns the verified address (and the pattern that hit), or null when nothing verifies / SMTP is
 * off / the domain is catch-all or unreachable.
 */
export async function findVerifiedEmail(
  person: { firstName?: string; lastName?: string; fullName?: string },
  urlOrDomain: string,
  opts?: { max?: number },
): Promise<FoundEmail | null> {
  if (!smtpEnabled()) return null;
  const domain = emailDomainFrom(urlOrDomain);
  if (!domain) return null;
  if ((await mxStatus(domain).catch(() => "error" as const)) !== "mx") return null; // no MX → can't probe

  let first = person.firstName, last = person.lastName;
  if ((!first || !last) && person.fullName) {
    const s = splitFullName(person.fullName);
    first = first || s.firstName; last = last || s.lastName;
  }
  const perms = emailPermutations(first, last, domain);
  if (!perms.length) return null;

  // Catch-all detection: a random local that cannot exist. If the server accepts it, it accepts
  // everything → SMTP is uninformative here, so don't claim a find.
  const decoy = `nx-${Date.now().toString(36)}-zzq@${domain}`;
  if ((await smtpRcptProbe(decoy, domain).catch(() => null)) === true) return null;

  const max = Math.min(opts?.max ?? 4, perms.length);
  for (let i = 0; i < max; i++) {
    const ok = await smtpRcptProbe(perms[i].email, domain).catch(() => null);
    if (ok === true) return { email: perms[i].email, pattern: perms[i].pattern || "smtp_found", verified: true };
    // ok===false → that mailbox doesn't exist, try the next permutation; null → inconclusive, continue.
  }
  return null;
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
