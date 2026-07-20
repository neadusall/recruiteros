/**
 * RecruitersOS · JD Sourcing · KoldInfo enrichment (CSV round-trip, the FIRST rung).
 *
 * Same operator-driven loop as the In-Market side (KoldInfo has no API): export the
 * candidates still missing an email or a phone as an upload-ready CSV, enrich in
 * KoldInfo, import the result back onto the SAME sourcing run. It runs BEFORE Laxis on
 * purpose: KoldInfo is the cheap first check, so Laxis credits (and the paid waterfall)
 * are only spent on what KoldInfo could not fill. KoldInfo's enrichment export ships
 * BOTH person_email and person_phone/person_sanitized_phone (verified 2026-07-15);
 * line type is unknown, so OS Text's Telnyx validation remains the mobile filter.
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
 * OR a phone (KoldInfo fills both, and only matched rows cost tokens), and only rows
 * KoldInfo can identify (a name or a LinkedIn URL; its enrichment keys on the URL).
 * Rows already holding an email AND a phone are counted as `skipped`.
 */
export function buildSourcingKoldInfoCsv(rows: CandidateRow[]): { csv: string; count: number; skipped: number } {
  const out: KoldInfoExportRow[] = [];
  let skipped = 0;
  for (const c of rows) {
    if ((c.email || "").trim() && (c.phone || "").trim()) { skipped++; continue; }
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

/** Split a freeform location ("Dallas, Texas, United States", "Dallas, TX",
 *  "Greater Dallas Area") into a best-effort {city, state} for the DB filter query. */
export function splitLocation(loc: string | undefined): { city: string; state: string } {
  const raw = (loc || "").trim();
  if (!raw) return { city: "", state: "" };
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const clean = (s: string) => s.replace(/\b(greater|metropolitan|metro|area|region|the|and|surrounding)\b/gi, "").replace(/[-/].*$/, "").replace(/\s+/g, " ").trim();
  let city = clean(parts[0] || "");
  let state = "";
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/united states|usa|u\.s\.|america|canada|uk|united kingdom/i.test(p)) continue;
    state = p; break;
  }
  return { city, state };
}

/**
 * Build the KoldInfo DATABASE-lookup CSV (People DB + Business Email DB, name + city/state) —
 * the door that needs NO LinkedIn URL, so it reaches candidates the LinkedIn-URL enrichment
 * cannot. Only rows still missing an email OR a phone, and only rows we can identify by name.
 * Carries city/state (parsed from the candidate's location, else the run's) so the DB filter
 * can disambiguate the right person. Rows already holding an email AND a phone are `skipped`.
 */
export function buildKoldInfoDbCsv(
  rows: CandidateRow[],
  runLocation?: string,
): { csv: string; count: number; skipped: number } {
  const header = ["ros_id", "full_name", "company", "title", "city", "state"];
  const csvCell = (v: string) => { const s = (v ?? "").replace(/\r?\n/g, " ").trim(); return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [header.join(",")];
  let count = 0, skipped = 0;
  const runLoc = splitLocation(runLocation);
  for (const c of rows) {
    if ((c.email || "").trim() && (c.phone || "").trim()) { skipped++; continue; }
    const fullName = (c.fullName || "").trim();
    if (!fullName) { skipped++; continue; }
    const loc = splitLocation(c.location);
    const city = loc.city || runLoc.city;
    const state = loc.state || runLoc.state;
    lines.push([sourcingKoldId(c), fullName, (c.company || "").trim(), (c.title || "").trim(), city, state].map(csvCell).join(","));
    count++;
  }
  return { csv: lines.join("\n") + "\n", count, skipped };
}

export interface SourcingKoldMerge {
  /** Result rows parseKoldInfoCsv could read (rows with an email or a phone). */
  parsed: number;
  /** Rows re-linked to a candidate on this run. */
  matched: number;
  /** Candidates that gained an email they didn't have. */
  emails: number;
  /** Candidates that gained a phone they didn't have (KoldInfo ships person_phone too). */
  phones: number;
  /** Emails dropped because KoldInfo's own verdict was invalid/undeliverable/role. */
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
  const r: SourcingKoldMerge = { parsed: results.length, matched: 0, emails: 0, phones: 0, invalid: 0, unmatched: 0 };
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
    const phone = (res.phone || "").trim();
    if (!email && !phone) continue;
    // A vendor-invalid verdict poisons the EMAIL only; a phone on the same row is still usable.
    const badEmail = BAD_STATUS.has((res.vendorStatus || "").toLowerCase().replace(/[\s-]+/g, "_"));
    const name = norm(res.fullName || [res.firstName, res.lastName].filter(Boolean).join(" "));
    let c = res.rosId ? byId.get(res.rosId) : undefined;
    if (!c && name) c = byNameCompany.get(name + "|" + norm(res.company)) || byName.get(name) || undefined;
    if (!c) { r.unmatched++; continue; }
    r.matched++;
    if (email && badEmail) r.invalid++;
    if (email && !badEmail && !c.email && !usedEmail.has(email)) { c.email = email; usedEmail.add(email); r.emails++; }
    if (phone && !c.phone) { c.phone = phone; c.phoneSource = "koldinfo"; r.phones++; }
  }
  return r;
}
