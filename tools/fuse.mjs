// RecruitersOS · MPC · SEND FUSE (owner mandate 2026-08-20: "nothing sends until it is verified and ready").
//
// Three protections the 8/19 incident showed were missing, all reading the same ground truth
// (the send ledgers + the NDR sweep's bounce notices) and all writing ONE ledger that every
// sender honors (batch.mjs, followup.mjs, the app's preflight gate) and the health board +
// sentinel watch:
//
//  1. FLEET FUSE. If the fleet's hard-bounce ratio over the last 24h crosses MPC_FUSE_MAX_RATIO
//     (5%) on at least MPC_FUSE_MIN_SENDS (100) sends, ALL cold sends stop and the fuse LATCHES.
//     It does not reset itself: a person clears it (send-fuse.mjs --clear) after looking.
//     The per-domain breaker (domain-rest.mjs) is too slow to be the first line; it benches
//     victims one at a time after the damage. The fuse stops the run while it is happening.
//  2. SOURCE BREAKERS. Every address carries the rung that produced it (emailSource). A rung
//     whose addresses bounce above MPC_SOURCE_MAX_RATIO (5%) on MPC_SOURCE_MIN_SENDS (30)+
//     sends in 7 days is PAUSED (48h, then 7d on a repeat inside 14 days) while every other
//     rung keeps sending. This cuts the CAUSE off instead of benching the domains it burned.
//  3. CANARY + BLAST-RADIUS (enforced in batch.mjs, recorded here). A sample of the addresses
//     about to be trusted on an older verdict is re-verified live before each run; a bad sample
//     latches the fleet fuse. Weaker-proof ("pattern") addresses only ever leave a fixed slice
//     of the fleet's domains, so a bad rung can burn that slice, never the fleet.
//
// The ledger is written by whoever evaluates last (batch.mjs before every run, send-fuse.mjs
// from the sweep timer); evaluation is deterministic from the inputs, so the two never fight.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";

export const FUSE_FILE = process.env.MPC_FUSE_FILE || "/data/snap_mpc_send_fuse_v1.json";
const DAY = 86_400_000, HOUR = 3_600_000;

/* ----------------------------- tiers + slice ----------------------------- */

/** Address rungs that return a RECORD for a person (a finder hit), vs rungs that DERIVE a
 *  pattern and ask a verifier to bless it. After the incident, the second family is the
 *  weaker proof and rides the canary slice of the fleet. */
export const FOUND_SOURCES = new Set(["koldinfo", "reoon_found", "smtp_found", "site_direct"]);
export function tierOf(source) { return FOUND_SOURCES.has(String(source || "")) ? "found" : "pattern"; }

export function djb2(s) { let h = 5381; for (const ch of String(s)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0; return h; }

/** A stable ~pct% slice of the fleet's domains (by hash, so it does not move as domains rest and
 *  revive). Pattern-tier volume is confined to this slice; found-tier volume prefers the rest. */
export function canarySlice(domains, pct = 25) {
  const uniq = [...new Set(domains.map((d) => String(d || "").toLowerCase()).filter(Boolean))];
  if (!uniq.length) return new Set();
  const want = Math.max(1, Math.round((uniq.length * pct) / 100));
  const ranked = uniq.map((d) => ({ d, h: djb2("slice:" + d) })).sort((a, b) => a.h - b.h || (a.d < b.d ? -1 : 1));
  return new Set(ranked.slice(0, want).map((x) => x.d));
}

/* ------------------------------ inputs ------------------------------ */

/** Send ledger rows (sent-*.jsonl) from the last `days` days. */
export function loadSentRows(outDir, days = 14) {
  const rows = [];
  if (!outDir || !existsSync(outDir)) return rows;
  const cutoff = new Date(Date.now() - days * DAY).toISOString();
  for (const f of readdirSync(outDir).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${outDir}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.to_email && (!r.at || r.at >= cutoff)) rows.push(r); } catch { /* skip */ }
    }
  }
  return rows;
}

export function loadNdr(file = process.env.MPC_NDR_FILE || "/data/snap_mpc_ndr_v1.json") {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
export function ndrAgeHours(ndr, now = Date.now()) {
  const t = Date.parse((ndr && ndr.generatedAt) || 0);
  return Number.isFinite(t) ? (now - t) / HOUR : null;
}

/** A send that reached a receiving server (infra 404/429 failures never left the building). */
export function isRealSend(r) {
  if (!r || !r.to_email) return false;
  const err = String((r.result && r.result.error) || "");
  if (!(r.result && r.result.ok) && /^(404|429):/.test(err)) return false;
  return !!(r.result && r.result.ok);
}

/* ------------------------------ ledger ------------------------------ */

export function emptyLedger() {
  return {
    version: 1,
    updatedAt: null,
    fleet: { tripped: false, since: null, reason: null, by: null, scope: "fleet", clearedAt: null, clearedBy: null, domains: [] },
    window: null,
    sources: {},
    canary: null,
    belt: null,
    history: [],
  };
}
export function loadFuseLedger(file = FUSE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && j.fleet) { j.sources ||= {}; j.history ||= []; return j; }
  } catch { /* first run */ }
  return emptyLedger();
}
export function writeFuseLedger(ledger, file = FUSE_FILE) {
  ledger.updatedAt = new Date().toISOString();
  ledger.history = (ledger.history || []).slice(-50);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(ledger, null, 1));
  renameSync(tmp, file);
  return ledger;
}
function note(ledger, event, detail, at) {
  ledger.history = [...(ledger.history || []), { at: at || new Date().toISOString(), event, detail }].slice(-50);
}

/** Latch the fleet fuse. Idempotent: an already-tripped fuse keeps its first reason. */
export function tripFleet(ledger, { by = "manual", reason = "manual trip", scope = "fleet", now = Date.now() } = {}) {
  if (ledger.fleet.tripped) return false;
  const at = new Date(now).toISOString();
  ledger.fleet = { ...ledger.fleet, tripped: true, since: at, reason, by, scope, clearedAt: null, clearedBy: null };
  note(ledger, "fleet_tripped", `${by}: ${reason}`, at);
  return true;
}
/** Clear the fleet fuse. Bounces seen before clearedAt stop counting toward a re-trip. */
export function clearFleet(ledger, { by = "owner", now = Date.now() } = {}) {
  if (!ledger.fleet.tripped) return false;
  const at = new Date(now).toISOString();
  ledger.fleet = { ...ledger.fleet, tripped: false, clearedAt: at, clearedBy: by };
  note(ledger, "fleet_cleared", `${by}`, at);
  return true;
}
/** Manually release one source's pause (its window restarts at now). */
export function releaseSource(ledger, source, { by = "owner", now = Date.now() } = {}) {
  const s = ledger.sources[source];
  if (!s || !s.paused) return false;
  const at = new Date(now).toISOString();
  s.paused = false; s.until = null; s.releasedAt = at; s.releasedBy = by;
  note(ledger, "source_released", `${source} by ${by}`, at);
  return true;
}

/* ------------------------------ evaluation ------------------------------ */

export const DEFAULTS = {
  fuseMinSends: 100, fuseMaxRatio: 0.05, fuseWindowH: 24,
  sourceMinSends: 30, sourceMaxRatio: 0.05, sourceWindowD: 7, sourcePauseH: [48, 168], sourceStrikeD: 14,
};
export function configFromEnv(env = process.env) {
  const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    fuseMinSends: num("MPC_FUSE_MIN_SENDS", DEFAULTS.fuseMinSends),
    fuseMaxRatio: num("MPC_FUSE_MAX_RATIO", DEFAULTS.fuseMaxRatio),
    fuseWindowH: num("MPC_FUSE_WINDOW_H", DEFAULTS.fuseWindowH),
    sourceMinSends: num("MPC_SOURCE_MIN_SENDS", DEFAULTS.sourceMinSends),
    sourceMaxRatio: num("MPC_SOURCE_MAX_RATIO", DEFAULTS.sourceMaxRatio),
    sourceWindowD: num("MPC_SOURCE_WINDOW_D", DEFAULTS.sourceWindowD),
    sourcePauseH: DEFAULTS.sourcePauseH,
    sourceStrikeD: num("MPC_SOURCE_STRIKE_D", DEFAULTS.sourceStrikeD),
  };
}

/**
 * Deterministic evaluation. Inputs: the ledger (latched state), real send rows, the NDR
 * sidecar (its `notices[]`: campaign bounces with at/rcpt/reason/source). Returns the
 * updated ledger + the list of state changes (for logging / owner email).
 */
export function evaluateFuse({ ledger, sentRows, ndr, now = Date.now(), config = configFromEnv() }) {
  ledger = ledger || emptyLedger();
  const changes = [];
  const nowIso = new Date(now).toISOString();
  const notices = Array.isArray(ndr && ndr.notices) ? ndr.notices.filter((n) => n && Number.isFinite(Date.parse(n.at || 0)) && n.reason !== "relay_auth") : null;
  const real = (sentRows || []).filter(isRealSend);
  const domains = [...new Set(real.map((r) => String(r.from || "").split("@")[1] || "").filter(Boolean))].sort();

  // ---- fleet window ----
  const winStart = now - config.fuseWindowH * HOUR;
  const clearedAt = Date.parse(ledger.fleet.clearedAt || 0);
  const countFrom = Math.max(winStart, Number.isFinite(clearedAt) ? clearedAt : 0);
  const sends = real.filter((r) => Date.parse(r.at || 0) >= countFrom).length;
  const bounces = notices ? notices.filter((n) => Date.parse(n.at) >= countFrom).length : null;
  const ratio = bounces != null && sends > 0 ? bounces / sends : null;
  ledger.window = {
    at: nowIso, windowH: config.fuseWindowH, sends, bounces, ratio: ratio == null ? null : Math.round(ratio * 10000) / 10000,
    minSends: config.fuseMinSends, maxRatio: config.fuseMaxRatio,
    ndrAt: (ndr && ndr.generatedAt) || null,
    available: notices != null,
  };
  ledger.fleet.domains = domains;
  if (notices != null && sends >= config.fuseMinSends && ratio > config.fuseMaxRatio) {
    if (tripFleet(ledger, { by: "auto", reason: `fleet hard-bounce ratio ${(ratio * 100).toFixed(1)}% (${bounces} bounces / ${sends} sends in ${config.fuseWindowH}h) over the ${config.fuseMaxRatio * 100}% limit`, scope: "fleet", now })) {
      changes.push({ kind: "fleet_tripped", text: `FUSE TRIPPED: ${ledger.fleet.reason}. All cold sends and follow-ups are stopped until a person clears the fuse.` });
    }
  }

  // ---- source breakers ----
  const srcWinStart = now - config.sourceWindowD * DAY;
  const bySrc = {};
  for (const r of real) {
    const at = Date.parse(r.at || 0);
    if (at < srcWinStart) continue;
    const src = r.email_source || null;
    if (!src) continue; // pre-belt rows carry no source: unattributable, never counted
    const e = bySrc[src] || (bySrc[src] = { sent: 0, bounces: 0 });
    const s = ledger.sources[src];
    const from = s && s.releasedAt ? Math.max(srcWinStart, Date.parse(s.releasedAt)) : srcWinStart;
    if (at >= from) e.sent++;
  }
  if (notices) {
    for (const n of notices) {
      const src = n.source || null;
      if (!src) continue;
      const at = Date.parse(n.at);
      const s = ledger.sources[src];
      const from = s && s.releasedAt ? Math.max(srcWinStart, Date.parse(s.releasedAt)) : srcWinStart;
      if (at < from) continue;
      const e = bySrc[src] || (bySrc[src] = { sent: 0, bounces: 0 });
      e.bounces++;
    }
  }
  const allSrc = new Set([...Object.keys(bySrc), ...Object.keys(ledger.sources)]);
  for (const src of allSrc) {
    const e = bySrc[src] || { sent: 0, bounces: 0 };
    const s = ledger.sources[src] || (ledger.sources[src] = { paused: false, until: null, since: null, strikes: [], reason: null, releasedAt: null });
    s.sent = e.sent; s.bounces = e.bounces; s.ratio = e.sent ? Math.round((e.bounces / e.sent) * 10000) / 10000 : null;
    s.tier = tierOf(src);
    if (s.paused) {
      if (s.until && now >= Date.parse(s.until)) {
        s.paused = false; s.releasedAt = nowIso; s.releasedBy = "auto"; s.until = null;
        s.sent = 0; s.bounces = 0; s.ratio = null; // the window restarts at release: what happened before it was served by the pause
        note(ledger, "source_released", `${src} (pause served)`, nowIso);
        changes.push({ kind: "source_released", text: `SOURCE RELEASED: ${src} served its pause; its next sends are a fresh probe (the canary slice limits what it can touch).` });
      }
      continue;
    }
    if (notices && e.sent >= config.sourceMinSends && e.bounces / e.sent > config.sourceMaxRatio) {
      const strikes = (s.strikes || []).filter((t) => now - Date.parse(t) < config.sourceStrikeD * DAY);
      const hours = config.sourcePauseH[Math.min(strikes.length, config.sourcePauseH.length - 1)];
      s.paused = true; s.since = nowIso; s.until = new Date(now + hours * HOUR).toISOString();
      s.strikes = [...strikes, nowIso];
      s.reason = `${e.bounces} bounces / ${e.sent} sends (${((e.bounces / e.sent) * 100).toFixed(1)}%) in ${config.sourceWindowD}d`;
      note(ledger, "source_paused", `${src}: ${s.reason} for ${hours}h`, nowIso);
      changes.push({ kind: "source_paused", text: `SOURCE PAUSED: ${src} addresses are bouncing (${s.reason}). That rung sends nothing for ${hours}h; every other rung keeps sending.` });
    }
  }
  return { ledger, changes };
}

/* ------------------------------ owner email ------------------------------ */

export async function notifyOwner(changes, { subjectPrefix = "Send fuse" } = {}) {
  if (!changes || !changes.length) return false;
  const RESEND_KEY = process.env.RESEND_API_KEY || "";
  const to = process.env.OWNER_EMAIL || "neadusall@gmail.com";
  const from = process.env.EMAIL_FROM || "RecruitersOS <onboarding@resend.dev>";
  const kinds = [...new Set(changes.map((c) => c.kind))];
  const subject = `${subjectPrefix}: ${kinds.map((k) => k.replace(/_/g, " ")).join(", ")}`;
  const text = [
    "The send fuse acted on the cold-email fleet:",
    "",
    ...changes.map((c) => c.text),
    "",
    "What this layer does: the fleet fuse stops every cold send when the fleet's 24-hour bounce ratio",
    "crosses the limit, and it stays stopped until a person clears it. A source breaker pauses only the",
    "address rung that is bouncing, so the rest keeps sending. The canary re-checks a sample of older",
    "verdicts before each run and trips the fuse if they have gone bad.",
    "",
    "To clear the fleet fuse after you have looked (on the ros box):",
    "  bash /opt/recruiteros/tools/send-fuse.sh --clear",
    "Status: bash /opt/recruiteros/tools/send-fuse.sh --status, or the System Health board.",
  ].join("\n");
  if (!RESEND_KEY) { console.log(`RESEND_API_KEY not set; owner email skipped (${subject})`); return false; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(20_000),
    });
    console.log(r.ok ? `owner emailed: ${subject}` : `owner email failed: http ${r.status}`);
    return r.ok;
  } catch (e) { console.log(`owner email failed: ${(e && e.message) || e}`); return false; }
}
