// RecruitersOS · MPC · pre-send VERIFICATION BELT (owner mandate 2026-08-20).
//
// After the 8/19 incident (pattern guesses stamped "validated" hard-bounced at scale and
// benched all 21 cold domains at once), NOTHING cold-sends on a boolean flag any more. A
// recipient address must carry a verifier VERDICT the sender can read back:
//
//   proven        the verifier confirmed THIS mailbox (Reoon "safe"; bulk-era "valid"/"ok")
//   catch_all     the domain accepts anything; the person is unproven  -> never cold-sends here
//   dead          invalid / disabled / disposable / spamtrap / no MX    -> never sends, row invalidated
//   role          a shared inbox (info@, hr@): not a person             -> never sends
//   inconclusive  the verifier could not say                             -> held, retried later
//
// Where the verdict lives: the curation row (emailVerifyStatus + validatedAt, written by the
// app's bulk validator) or this belt's own cache (snap_mpc_verify_cache_v1, written by the
// live re-checks batch.mjs performs right before a send; the app's hourly cron folds those
// verdicts back into the store). A proven verdict older than MPC_VERIFY_MAX_AGE_D (30) days
// is STALE and gets re-checked: mailboxes close, people leave.
//
// One semantics for every consumer: interpretVerdict() is the single reading of a Reoon
// payload on the host side; the app's lib/inmarket/reoon.ts mirrors it and both carry tests.
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export const PROVEN_STATUSES = new Set(["safe", "valid", "deliverable", "ok"]);
export const DEAD_STATUSES = ["invalid", "undeliverable", "disabled", "spamtrap", "spam_trap", "rejected", "bounce", "disposable"];
export const VERIFY_CACHE_FILE = process.env.MPC_VERIFY_CACHE_FILE || "/data/snap_mpc_verify_cache_v1.json";
const DAY = 86_400_000;

export function normStatus(s) { return String(s || "").toLowerCase().trim().replace(/[\s-]+/g, "_"); }
export function isProvenStatus(s) { return PROVEN_STATUSES.has(normStatus(s)); }

/** Status word -> belt verdict, for statuses already persisted on a row (no payload flags). */
export function verdictOfStatus(status) {
  const s = normStatus(status);
  if (!s) return "inconclusive";
  if (s.includes("catch") || s.includes("accept_all")) return "catch_all";
  if (DEAD_STATUSES.some((d) => s.includes(d))) return "dead";
  if (s.includes("role")) return "role";
  if (PROVEN_STATUSES.has(s)) return "proven";
  return "inconclusive";
}

/**
 * Map ONE raw Reoon payload (single-verify or bulk-result shape) to a belt verdict.
 * Hard negatives first, then catch-all BEFORE any positive flag (on a catch-all domain
 * "safe to send" only means "will not bounce", never "this person exists"), then role
 * accounts, then the explicit positive status words. Anything else is inconclusive.
 * is_safe_to_send / is_deliverable alone NEVER prove a mailbox (free providers accept
 * mail for non-existent users); only the status word does.
 */
export function interpretVerdict(r) {
  if (!r || typeof r !== "object") return { verdict: "inconclusive", status: "" };
  const status = normStatus(r.status ?? r.result ?? r.state ?? "");
  const disposable = r.is_disposable === true || r.disposable === true;
  const roleAcct = r.is_role_account === true || r.is_role === true;
  const catchAll = r.is_catchall === true || r.is_catch_all === true || status.includes("catch") || status.includes("accept_all");
  if (disposable) return { verdict: "dead", status: status || "disposable" };
  if (DEAD_STATUSES.some((d) => status.includes(d))) return { verdict: "dead", status };
  if (r.is_deliverable === false || r.deliverable === false || r.mx_accepts_mail === false) return { verdict: "dead", status: status || "undeliverable" };
  if (catchAll) return { verdict: "catch_all", status: status || "catch_all" };
  if (roleAcct || status.includes("role")) return { verdict: "role", status: status || "role_account" };
  if (PROVEN_STATUSES.has(status)) return { verdict: "proven", status };
  return { verdict: "inconclusive", status: status || "unknown" };
}

/** One live Reoon verification. Never throws: {error} on transport trouble (held, not cached). */
export async function reoonVerifyOne(email, opts = {}) {
  const key = opts.key ?? process.env.REOON_API_KEY;
  const mode = opts.mode ?? (process.env.REOON_VERIFY_MODE || "power");
  const timeoutMs = opts.timeoutMs ?? 45_000;
  if (!key) return { error: "no_key" };
  const fetchFn = opts.fetch || fetch;
  try {
    const res = await fetchFn(`https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}&mode=${encodeURIComponent(mode)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { error: `http_${res.status}` };
    const j = await res.json().catch(() => null);
    if (!j || typeof j !== "object") return { error: "bad_json" };
    if (String(j.status || "").toLowerCase() === "error" || j.api_status === "error") return { error: String(j.reason || j.message || "api_error").slice(0, 80) };
    return { raw: j, ...interpretVerdict(j) };
  } catch (e) {
    return { error: (e && (e.name === "TimeoutError" || e.name === "AbortError")) ? "timeout" : String((e && e.message) || e).slice(0, 80) };
  }
}

/** Verify many addresses with bounded concurrency. Map email -> reoonVerifyOne result. */
export async function verifyMany(emails, opts = {}) {
  const uniq = [...new Set(emails.map((e) => String(e || "").toLowerCase().trim()).filter(Boolean))];
  const out = new Map();
  const conc = Math.max(1, Math.min(Number(opts.concurrency) || 6, 12));
  let i = 0;
  async function worker() { while (i < uniq.length) { const e = uniq[i++]; out.set(e, await reoonVerifyOne(e, opts)); } }
  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}

/* ------------------------------ belt cache ------------------------------ */

export function loadVerifyCache(file = VERIFY_CACHE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && j.entries && typeof j.entries === "object") return j;
  } catch { /* first run */ }
  return { version: 1, updatedAt: null, entries: {} };
}

export function saveVerifyCache(cache, file = VERIFY_CACHE_FILE, { now = Date.now(), maxEntries = 60_000, maxAgeDays = 90 } = {}) {
  const entries = Object.entries(cache.entries || {})
    .filter(([, v]) => v && Number.isFinite(Date.parse(v.at || 0)) && now - Date.parse(v.at) < maxAgeDays * DAY)
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
    .slice(0, maxEntries);
  const out = { version: 1, updatedAt: new Date(now).toISOString(), entries: Object.fromEntries(entries) };
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(out));
  renameSync(tmp, file);
  return out;
}

/**
 * Is this row's address PROVEN right now, without spending a credit? Reads the freshest
 * verdict across the curation row and the belt cache (a newer live check beats an older
 * bulk stamp, in either direction).
 *   { state: "proven", via: "store"|"cache", at, status }
 *   { state: "stale" }          proven, but older than maxAgeDays -> re-check
 *   { state: "dead"|"catch_all"|"role" }   never sends (row is invalidated by the app cron)
 *   { state: "unproven" }       no verdict, or an inconclusive one -> re-check
 */
export function proofOf(row, cache, { now = Date.now(), maxAgeDays = 30 } = {}) {
  const email = String((row && row.likelyEmail) || "").toLowerCase().trim();
  if (!email) return { state: "unproven", reason: "no address" };
  const cands = [];
  const c = cache && cache.entries ? cache.entries[email] : null;
  if (c && Number.isFinite(Date.parse(c.at || 0))) cands.push({ via: "cache", at: Date.parse(c.at), status: normStatus(c.status), verdict: c.verdict || verdictOfStatus(c.status) });
  if (row.emailVerifyStatus) {
    const at = Date.parse(row.validatedAt || 0);
    cands.push({ via: "store", at: Number.isFinite(at) ? at : 0, status: normStatus(row.emailVerifyStatus), verdict: verdictOfStatus(row.emailVerifyStatus) });
  }
  if (!cands.length) return { state: "unproven", reason: "no verifier verdict on file" };
  cands.sort((a, b) => b.at - a.at);
  const best = cands[0];
  if (best.verdict === "dead" || best.verdict === "role" || best.verdict === "catch_all") return { state: best.verdict, via: best.via, at: best.at, status: best.status };
  if (best.verdict === "proven") {
    if (now - best.at > maxAgeDays * DAY) return { state: "stale", via: best.via, at: best.at, status: best.status };
    return { state: "proven", via: best.via, at: best.at, status: best.status };
  }
  return { state: "unproven", reason: `verdict ${best.status || "unknown"}`, via: best.via, at: best.at };
}
