/**
 * RecruitersOS · JD Sourcing · KoldInfo enrichment (CSV round-trip, the FIRST rung).
 *
 * Same operator-driven loop as the In-Market side (KoldInfo has no API): export the
 * candidates still missing an email as an upload-ready CSV, enrich in KoldInfo, import
 * the result back onto the SAME sourcing run. It runs BEFORE Laxis on purpose: KoldInfo
 * is the free first check, so Laxis credits (and the paid waterfall) are only spent on
 * what KoldInfo could not fill. KoldInfo returns emails only; cellphones still come from
 * the Laxis pass afterwards.
 *
 * The CSV format + parser are shared with lib/inmarket/koldInfo.ts (header aliases plus
 * content detection), so whatever KoldInfo names its export columns, the round-trip works.
 */

import { buildKoldInfoCsv, parseKoldInfoCsv } from "../inmarket/koldInfo";
import type { KoldInfoExportRow } from "../inmarket/koldInfo";
import type { CandidateRow } from "./types";

/** Same stable per-candidate key the sourcing route uses (LinkedIn URL, else name+company). */
function candidateKey(c: CandidateRow): string {
  return (c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`).toLowerCase().replace(/\/+$/, "");
}

/** Deterministic short passthrough id (djb2 → base36). Round-trips through KoldInfo's
 *  export so a result row re-attaches to its candidate even if the list was re-sorted. */
export function sourcingKoldId(c: CandidateRow): string {
  const key = candidateKey(c);
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return "sc_" + h.toString(36);
}

function norm(s: string | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Vendor verdicts we refuse to write onto a candidate (BD side discards these too). */
const BAD_STATUS = new Set(["invalid", "undeliverable", "not_found", "role"]);

/**
 * Build the KoldInfo upload CSV for a sourcing run: only rows still missing an email
 * (that is the whole point of the first rung), and only rows KoldInfo can identify
 * (a name or a LinkedIn URL). Rows already holding an email are counted as `skipped`.
 */
export function buildSourcingKoldInfoCsv(rows: CandidateRow[]): { csv: string; count: number; skipped: number } {
  const out: KoldInfoExportRow[] = [];
  let skipped = 0;
  for (const c of rows) {
    if ((c.email || "").trim()) { skipped++; continue; }
    const fullName = (c.fullName || "").trim();
    if (!fullName && !c.linkedinUrl) { skipped++; continue; }
    const [firstName, ...rest] = fullName.split(/\s+/);
    out.push({
      rosId: sourcingKoldId(c),
      firstName: firstName || "",
      lastName: rest.join(" "),
      fullName,
      company: (c.company || "").trim(),
      domain: "", // sourcing rows carry no company domain; KoldInfo resolves from company+name
      title: (c.title || "").trim(),
      linkedin: c.linkedinUrl,
    });
  }
  return { csv: buildKoldInfoCsv(out), count: out.length, skipped };
}

export interface SourcingKoldMerge {
  /** Result rows parseKoldInfoCsv could read (rows with an email). */
  parsed: number;
  /** Rows re-linked to a candidate on this run. */
  matched: number;
  /** Candidates that gained an email they didn't have. */
  emails: number;
  /** Rows dropped because KoldInfo's own verdict was invalid/undeliverable/role. */
  invalid: number;
  /** Rows we could not re-link to any candidate. */
  unmatched: number;
}

/**
 * Merge a KoldInfo result CSV back onto the run's candidates. Re-links by our sc_ id
 * first, else by name+company, else by a name that is unique on the run. Only fills an
 * email where the candidate has none (same only-fill-blanks discipline as the Laxis
 * merge), and never writes an address KoldInfo itself called invalid.
 */
export function mergeSourcingKoldInfoCsv(rows: CandidateRow[], csvText: string): SourcingKoldMerge {
  const results = parseKoldInfoCsv(csvText);
  const r: SourcingKoldMerge = { parsed: results.length, matched: 0, emails: 0, invalid: 0, unmatched: 0 };
  if (!results.length) return r;

  const byId = new Map<string, CandidateRow>();
  const byNameCompany = new Map<string, CandidateRow>();
  const byName = new Map<string, CandidateRow | null>(); // null = ambiguous, don't match on name alone
  for (const c of rows) {
    byId.set(sourcingKoldId(c), c);
    const n = norm(c.fullName);
    if (!n) continue;
    byNameCompany.set(n + "|" + norm(c.company), c);
    byName.set(n, byName.has(n) ? null : c);
  }

  const usedEmail = new Set(rows.map((c) => (c.email || "").toLowerCase()).filter(Boolean));
  for (const res of results) {
    const email = (res.email || "").toLowerCase().trim();
    if (!email) continue;
    if (BAD_STATUS.has((res.vendorStatus || "").toLowerCase().replace(/[\s-]+/g, "_"))) { r.invalid++; continue; }
    const name = norm(res.fullName || [res.firstName, res.lastName].filter(Boolean).join(" "));
    let c = res.rosId ? byId.get(res.rosId) : undefined;
    if (!c && name) c = byNameCompany.get(name + "|" + norm(res.company)) || byName.get(name) || undefined;
    if (!c) { r.unmatched++; continue; }
    r.matched++;
    if (!c.email && !usedEmail.has(email)) { c.email = email; usedEmail.add(email); r.emails++; }
  }
  return r;
}
