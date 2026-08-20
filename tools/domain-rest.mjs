// RecruitersOS · MPC · Domain rest fail-safe (the doctor's protocol, enforced).
//
// The deliverability tracker OBSERVES per-domain health; this is the layer that ACTS on it, so a
// domain showing burn signals is laid to rest automatically instead of waiting for a person to
// notice. Reads the deliverability audit, benches any SENDING domain that trips a burn signal,
// rests it for an escalating quarantine, and revives it only when the rest has fully elapsed AND
// the signals read clean again. Warm-up is never touched: a resting domain keeps warming so it
// regains strength; it just sends no cold mail.
//
// Burn signals (each with a minimum sample so 2-send noise never benches a healthy domain):
//   hard-fail rate  > 5% across 20+ sends      -> rest (list hygiene / rejection spike)
//   bounce notices  >= 5 and > 5% of sends     -> rest (post-send DSNs naming this domain)
//   warm-up reputation < 70%                   -> rest, minimum 7 days (reputation damage)
//   SPF, DKIM or MX missing from DNS           -> rest (cold mail would land in spam)
// DMARC p=none alone does NOT bench: dns-authfix raises it autonomously the same night.
//
// Quarantine escalates per bench within 30 days: 2 days, then 7, then 14. Revive requires the
// full rest served, every signal clear, and warm-up reputation back to 90%+ where measured. A
// domain still sick at expiry is re-benched at the next escalation, not quietly released.
//
// Writes the ledger batch.mjs and followup.mjs enforce on every run, stamps resting state onto
// the deliverability snapshot the cockpit reads, and emails the owner on every bench and revive
// through Resend (the ros-sentinel channel; the app being sick must not silence the alert).
//
//   node scripts/mpc/domain-rest.mjs           # evaluate + write ledger + alert
//
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from "node:fs";

const DELIV_FILE = process.env.MPC_DELIVERABILITY_FILE || "/data/snap_mpc_deliverability_v1.json";
const REST_FILE = process.env.MPC_REST_FILE || "/data/snap_mpc_domain_rest_v1.json";
const OUT_DIR = process.env.MPC_OUT_DIR || "/out";
const OWNER_TO = process.env.OWNER_EMAIL || "neadusall@gmail.com";
const MAIL_FROM = process.env.EMAIL_FROM || "RecruitersOS <onboarding@resend.dev>";
const RESEND_KEY = process.env.RESEND_API_KEY || "";

const DAY = 86_400_000;
const ESCALATION_DAYS = [2, 7, 14];
const REPUTATION_MIN_REST_DAYS = 7;
const STRIKE_WINDOW_DAYS = 30;
const REVIVE_REPUTATION_PCT = 90;

function log(msg) {
  console.log(msg);
  try { mkdirSync(OUT_DIR, { recursive: true }); appendFileSync(`${OUT_DIR}/domain-rest-${new Date().toISOString().slice(0, 10)}.log`, `${new Date().toISOString()} ${msg}\n`); } catch { /* best-effort */ }
}

/** The burn signals for one audit row. Empty array = healthy. */
function burnSignals(row) {
  const out = [];
  if (row.sent >= 20 && row.hardFailRatePct > 5) out.push({ why: `hard-fail ${row.hardFailRatePct}% across ${row.sent} sends`, cls: "standard" });
  // Minimum-sends floor (2026-08-20): a bounce RATE is meaningless on a handful of
  // sends. Parked fleets showed "26 notices against 2 sends" because lowercase
  // warm-up NDR subjects leak through the looks-campaign heuristic; benching an
  // idle domain for two weeks on that noise wastes real capacity. Below the floor
  // a domain benches only via the other signals (auth broken, reputation, hard-fail).
  if (row.bounces >= 5 && row.sent >= 25 && row.bounces > row.sent * 0.05) out.push({ why: `${row.bounces} bounce notices against ${row.sent} sends`, cls: "standard" });
  const rep = row.warmupReputationPct;
  if (rep != null && rep < 70) out.push({ why: `warm-up reputation ${rep}%`, cls: "reputation" });
  const a = row.auth;
  if (a && (!a.spf || !a.dkim || !a.mx)) {
    const miss = [!a.spf && "SPF", !a.dkim && "DKIM", !a.mx && "MX"].filter(Boolean).join("+");
    out.push({ why: `authentication broken (${miss} missing)`, cls: "standard" });
  }
  return out;
}

/** Benches inside the strike window, counted from history (extends included). */
function recentStrikes(entry, now) {
  return (entry?.history || []).filter((h) => (h.event === "benched" || h.event === "extended") && now - Date.parse(h.at) < STRIKE_WINDOW_DAYS * DAY).length;
}

function restDays(strikes, cls) {
  const base = ESCALATION_DAYS[Math.min(strikes, ESCALATION_DAYS.length - 1)];
  return cls === "reputation" ? Math.max(REPUTATION_MIN_REST_DAYS, base) : base;
}

async function emailOwner(changes) {
  if (!changes.length) return;
  const lines = changes.map((c) => c.text);
  const count = (k) => changes.filter((c) => c.kind === k).length;
  const subject = `Domain rest: ${[
    count("benched") && `${count("benched")} benched`,
    count("extended") && `${count("extended")} extended`,
    count("revived") && `${count("revived")} revived`,
  ].filter(Boolean).join(", ")}`;
  const text = [
    "The domain rest fail-safe acted on the sending fleet:",
    "",
    ...lines,
    "",
    "A resting domain sends no cold email or follow-ups from any of its mailboxes. Warm-up keeps",
    "running so it regains strength, and it revives on its own once the rest is served and its",
    "signals read clean (warm-up reputation 90%+, authentication intact, no fresh bounce spike).",
    "No action is needed unless you want a domain back sooner: clear it from the rest ledger.",
    "Status lives in the portal under Senders (resting domains carry an amber pill).",
  ].join("\n");
  if (!RESEND_KEY) { log(`RESEND_API_KEY not set; owner email skipped (${subject})`); return; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [OWNER_TO], subject, text }),
      signal: AbortSignal.timeout(20_000),
    });
    log(r.ok ? `owner emailed: ${subject}` : `owner email failed: http ${r.status}`);
  } catch (e) { log(`owner email failed: ${e?.message || e}`); }
}

async function main() {
  if (!existsSync(DELIV_FILE)) { log("no deliverability audit yet; nothing to evaluate"); return; }
  const audit = JSON.parse(readFileSync(DELIV_FILE, "utf8"));
  const rows = audit.byDomain || [];
  if (!rows.length) { log("audit has no domains; nothing to evaluate"); return; }

  let ledger = { version: 1, updatedAt: null, domains: {} };
  if (existsSync(REST_FILE)) { try { ledger = JSON.parse(readFileSync(REST_FILE, "utf8")); ledger.domains ||= {}; } catch { /* fresh ledger */ } }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const changes = [];

  for (const row of rows) {
    const d = String(row.domain || "").toLowerCase();
    if (!d) continue;
    const entry = ledger.domains[d];
    const signals = burnSignals(row);

    if (entry && entry.state === "resting") {
      const served = !entry.until || now >= Date.parse(entry.until);
      const rep = row.warmupReputationPct;
      const reputationBack = rep == null || rep >= REVIVE_REPUTATION_PCT;
      if (served && signals.length === 0 && reputationBack) {
        entry.state = "cleared";
        entry.reason = undefined;
        entry.until = undefined;
        entry.history = [...(entry.history || []), { at: nowIso, event: "revived" }].slice(-20);
        changes.push({ kind: "revived", text: `REVIVED ${d}: rest served and signals clean${rep != null ? ` (warm-up ${rep}%)` : ""}. Back in rotation.` });
      } else if (served) {
        // Still sick at expiry: escalate rather than quietly release.
        const why = signals.map((s) => s.why).join("; ") || `warm-up reputation ${rep}% still under ${REVIVE_REPUTATION_PCT}%`;
        const cls = signals.some((s) => s.cls === "reputation") || !signals.length ? "reputation" : "standard";
        const days = restDays(recentStrikes(entry, now), cls);
        entry.until = new Date(now + days * DAY).toISOString();
        entry.reason = why;
        entry.history = [...(entry.history || []), { at: nowIso, event: "extended", reason: why, days }].slice(-20);
        changes.push({ kind: "extended", text: `EXTENDED ${d}: still unhealthy at expiry (${why}). Resting ${days} more days, until ${entry.until.slice(0, 10)}.` });
      }
      continue;
    }

    if (signals.length) {
      const why = signals.map((s) => s.why).join("; ");
      const cls = signals.some((s) => s.cls === "reputation") ? "reputation" : "standard";
      const days = restDays(recentStrikes(entry, now), cls);
      ledger.domains[d] = {
        state: "resting",
        reason: why,
        since: nowIso,
        until: new Date(now + days * DAY).toISOString(),
        history: [...(entry?.history || []), { at: nowIso, event: "benched", reason: why, days }].slice(-20),
      };
      changes.push({ kind: "benched", text: `BENCHED ${d} for ${days} days (${why}). Cold sends and follow-ups stop; warm-up continues.` });
    }
  }

  ledger.updatedAt = nowIso;
  const tmp = REST_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, REST_FILE);

  // Stamp resting state onto the audit snapshot so the cockpit shows it without a second fetch.
  let stamped = 0;
  for (const row of rows) {
    const e = ledger.domains[String(row.domain || "").toLowerCase()];
    if (e && e.state === "resting") { row.resting = { until: e.until, reason: e.reason }; stamped++; }
    else if (row.resting) delete row.resting;
  }
  audit.overall = audit.overall || {};
  audit.overall.domainsResting = stamped;
  const atmp = DELIV_FILE + ".tmp";
  writeFileSync(atmp, JSON.stringify(audit, null, 2));
  renameSync(atmp, DELIV_FILE);

  const restingNow = Object.entries(ledger.domains).filter(([, v]) => v.state === "resting");
  log(`domain-rest: ${changes.length} change(s), ${restingNow.length} domain(s) resting`);
  for (const c of changes) log(`  ${c.text}`);
  for (const [d, v] of restingNow) if (!changes.some((c) => c.text.includes(` ${d} `) || c.text.includes(` ${d}:`))) log(`  resting ${d} until ${String(v.until).slice(0, 10)} (${v.reason})`);
  await emailOwner(changes);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
