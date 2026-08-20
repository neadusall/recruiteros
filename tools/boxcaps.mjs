/**
 * RecruitersOS · MPC · Per-box daily cap (shared by every cold lane)
 *
 * WHY THIS EXISTS. The per-box cap lived inside batch.mjs's send path, so it protected
 * touch 1 and nothing else. followup.mjs had no per-box cap at all: it sends touch 2/3
 * from whatever mailbox sent touch 1, bounded only by a global daily number. On
 * 2026-08-20 that put 12 of 45 live boxes over their 2/day cap on follow-up volume
 * alone (noah.w@lumeadvisorygroup.com sent 6), and left 939 follow-ups queued across
 * 107 over-cap boxes on the 17 RESTING domains — up to 13 on a single mailbox. Every
 * one of those fires the day its domain revives, which is how a domain benched for
 * bouncing gets burned again on its first day back.
 *
 * A mailbox's daily cap is a property of the MAILBOX, not of whichever lane happens to
 * be drafting. So it lives here, both lanes import it, and both count the same ledgers
 * (sent-*.jsonl covers touch 1 AND sent-followup-*.jsonl, so the budget is shared).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";

const SENDERS = process.env.MPC_SENDERS_FILE || "/data/snap_senders_v1.json";
const REST_FILE = process.env.MPC_REST_FILE || "/data/snap_mpc_domain_rest_v1.json";
const OUT = process.env.MPC_OUT_DIR || "/out";

export const PER_BOX = Number(process.env.MPC_PER_BOX_DAILY || 2);
export const GOOGLE_RAMP = String(process.env.MPC_GOOGLE_RAMP || "8,14,20")
  .split(",").map((n) => Math.max(1, Number(n) || 0)).filter(Boolean);

export const domOf = (email) => String(String(email).split("@")[1] || "").toLowerCase();

/** Domains the rest ledger has benched right now. Fail-open: an unreadable ledger
 *  benches nothing, exactly as the sender has always behaved. */
export function restingDomains() {
  try {
    const r = JSON.parse(readFileSync(REST_FILE, "utf8"));
    const now = Date.now();
    return new Set(Object.entries(r.domains || {})
      .filter(([, v]) => v && v.state === "resting" && (!v.until || Date.parse(v.until) > now))
      .map(([d]) => d.toLowerCase()));
  } catch { return new Set(); }
}

/** Every cold touch each box has made TODAY, across both lanes. followup.mjs writes
 *  sent-followup-*.jsonl, which this pattern deliberately matches: touch 2 spends the
 *  same mailbox budget as touch 1. */
export function sentTodayByBox() {
  const counts = new Map();
  const today = new Date().toISOString().slice(0, 10);
  if (!existsSync(OUT)) return counts;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.from && (r.at || "").slice(0, 10) === today) counts.set(r.from, (counts.get(r.from) || 0) + 1); } catch { /* skip */ }
    }
  }
  return counts;
}

/** When each box made its FIRST cold send ever. Anchors the Google lane's ramp so a box
 *  added later starts its own gentle curve instead of inheriting the fleet's. */
export function firstSendByBox() {
  const first = new Map();
  if (!existsSync(OUT)) return first;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const r = JSON.parse(s);
        if (r && r.from && r.at && (!first.has(r.from) || r.at < first.get(r.from))) first.set(r.from, r.at);
      } catch { /* skip */ }
    }
  }
  return first;
}

/** Per-box cold cap by lane. Google boxes ramp weekly from THEIR OWN first cold send;
 *  everything else sits at the flat per-box number. */
export function capForBox(b, firstSend) {
  if (b.google) {
    const at = firstSend.get(b.email);
    const week = at ? Math.floor(Math.max(0, Date.now() - Date.parse(at)) / (7 * 86_400_000)) : 0;
    return GOOGLE_RAMP[Math.min(week, GOOGLE_RAMP.length - 1)];
  }
  return b.kind === "smtp" ? Math.min(PER_BOX, b.dailyCap || PER_BOX) : PER_BOX;
}

/**
 * Cap lookup keyed by MAILBOX ADDRESS, for a lane that knows the address but not the
 * box object (followup.mjs sends as whoever sent touch 1). Reads the senders store so
 * a Gmail-hosted box gets its Google ramp rather than the flat number — the same
 * distinction sendCapacity() used to miss by trusting the `provider` label alone.
 */
export function capByEmail() {
  const firstSend = firstSendByBox();
  const caps = new Map();
  let rows = [];
  try {
    const s = JSON.parse(readFileSync(SENDERS, "utf8"));
    rows = s.inboxes || (s.state && s.state.inboxes) || [];
  } catch { return { capOf: () => PER_BOX, caps }; }
  for (const m of rows) {
    if (!m || !m.email) continue;
    const google = /^smtp\.gmail\.com$/i.test(m.smtpHost || "") || m.provider === "google";
    const kind = m.provider === "sending-ac" ? "api" : "smtp";
    caps.set(String(m.email).toLowerCase(), capForBox({ email: m.email, google, kind, dailyCap: m.dailyCap }, firstSend));
  }
  // An address with no row left in the store still gets the conservative flat cap; a
  // missing row must never read as "unlimited".
  return { capOf: (email) => caps.get(String(email).toLowerCase()) ?? PER_BOX, caps };
}
