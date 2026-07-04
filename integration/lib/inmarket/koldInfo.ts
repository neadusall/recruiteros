/**
 * RecruitersOS · In-Market · KoldInfo enrichment (CSV round-trip, the FIRST rung).
 *
 * KoldInfo has no public API — it's a session-gated Next.js app (Server Actions, no REST surface).
 * So the integration is a batch CSV round-trip the operator drives once a day:
 *
 *   1. koldinfo_export  → this module emits the named-but-unvalidated backlog (highest hiring-intent
 *                          first, capped to ~2x daily send need so we never enrich what we can't send)
 *                          as a CSV shaped to KoldInfo's upload template, each row carrying our ros_id.
 *   2. operator         → uploads to KoldInfo, runs the enrichment, downloads the result CSV.
 *   3. koldinfo_import  → parseKoldInfoCsv() re-links each returned address to its prospect (by ros_id,
 *                          else name+domain), then applyKoldInfoResults() (in curation.ts) RE-VERIFIES
 *                          every address through the Reoon credits we already own before trusting it,
 *                          and teaches the per-domain pattern cache from each confirmed hit.
 *
 * Why FIRST: a KoldInfo hit can skip BOTH the free naming research AND the permutation+Reoon walk for
 * that slot, and — because each confirm feeds the pattern cache — it unlocks every colleague at that
 * domain for ~1 Reoon credit. This is the low-hanging fruit lever: buy whole domains, not single rows.
 *
 * The column names below are placeholders (defensive aliases across the shapes a lead-gen export
 * typically uses). Swap the two ALIAS blocks the moment we see KoldInfo's real template + export —
 * nothing else changes. When Phase 2 (headless browser worker) lands it feeds the SAME two functions.
 */

import { parseCsv } from "../senders/csv";
import { splitFullName } from "./email";

/** A prospect prepared for the KoldInfo upload template. */
export interface KoldInfoExportRow {
  rosId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  domain: string;
  title: string;
  linkedin?: string;
}

/** A single parsed row from KoldInfo's result CSV, re-linked to our prospect. */
export interface KoldInfoResult {
  rosId?: string;            // our passthrough id when KoldInfo preserved the column
  email?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  company?: string;
  domain?: string;
  /** KoldInfo's own verdict when it ships one (valid / verified / catch-all / risky / invalid). */
  vendorStatus?: string;
}

/* ------------------------------------------------------------------ export ---- */

/** The CSV header we WRITE for KoldInfo's upload. Order is stable; ros_id first so it round-trips. */
const EXPORT_HEADER = ["ros_id", "first_name", "last_name", "full_name", "company", "domain", "title", "linkedin_url"] as const;

function csvCell(v: string | undefined): string {
  const s = (v ?? "").replace(/\r?\n/g, " ").trim();
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The header row to write. Defaults to EXPORT_HEADER; override the NAMES (same order, same count)
 *  via KOLDINFO_EXPORT_HEADER if KoldInfo's upload template needs specific column names — no deploy. */
function exportHeader(): string[] {
  const env = (process.env.KOLDINFO_EXPORT_HEADER || "").split(",").map((s) => s.trim()).filter(Boolean);
  return env.length === EXPORT_HEADER.length ? env : EXPORT_HEADER.slice();
}

/** Serialize prepared rows to an upload-ready CSV string. */
export function buildKoldInfoCsv(rows: KoldInfoExportRow[]): string {
  const lines = [exportHeader().join(",")];
  for (const r of rows) {
    lines.push([
      csvCell(r.rosId), csvCell(r.firstName), csvCell(r.lastName), csvCell(r.fullName),
      csvCell(r.company), csvCell(r.domain), csvCell(r.title), csvCell(r.linkedin),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ import ---- */

/** Defensive header aliases for KoldInfo's RESULT export — extend when we see the real columns. */
const IMPORT_ALIASES = {
  rosId: ["ros_id", "rosid", "id", "external_id", "reference", "ref"],
  email: ["email", "work_email", "work email", "business_email", "business email", "email_address", "email address", "professional_email"],
  firstName: ["first_name", "first name", "firstname", "first"],
  lastName: ["last_name", "last name", "lastname", "last"],
  fullName: ["full_name", "full name", "fullname", "name", "contact", "person"],
  company: ["company", "company_name", "company name", "organization", "employer"],
  domain: ["domain", "company_domain", "website", "company_website"],
  vendorStatus: ["status", "email_status", "verification", "verification_status", "result", "deliverability", "state", "confidence"],
} as const;

type Field = keyof typeof IMPORT_ALIASES;

function detect(header: string[]): Partial<Record<Field, number>> {
  const norm = (header || []).map((h) => h.toLowerCase().trim().replace(/^﻿/, ""));
  const map: Partial<Record<Field, number>> = {};
  (Object.keys(IMPORT_ALIASES) as Field[]).forEach((field) => {
    for (const alias of IMPORT_ALIASES[field]) {
      const idx = norm.indexOf(alias);
      if (idx >= 0) { map[field] = idx; break; }
    }
  });
  return map;
}

// Content signatures — used to identify the key columns when the HEADER name is unknown/renamed.
// This is what makes the importer format-agnostic: KoldInfo can label its export however it likes.
const RE_EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
const RE_DOMAIN = /^(?!.*@)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const RE_ROSID = /^cp_[a-z0-9_]+$/i;
const STATUS_WORDS = new Set([
  "valid", "invalid", "catch-all", "catch_all", "catchall", "accept_all", "accept-all", "risky",
  "verified", "unverified", "deliverable", "undeliverable", "unknown", "not_found", "found", "safe", "role",
]);

/** Index of the column whose non-empty cells best match `pred` (fraction ≥ min), excluding taken cols. */
function detectByContent(grid: string[][], pred: (v: string) => boolean, min: number, taken: Set<number>): number {
  const cols = grid[0]?.length ?? 0;
  let best = -1, bestFrac = min;
  for (let c = 0; c < cols; c++) {
    if (taken.has(c)) continue;
    let hits = 0, total = 0;
    for (let r = 1; r < grid.length; r++) {
      const v = (grid[r][c] ?? "").trim();
      if (!v) continue;
      total++;
      if (pred(v)) hits++;
    }
    if (total >= 1) { const frac = hits / total; if (frac >= bestFrac) { bestFrac = frac; best = c; } }
  }
  return best;
}

/**
 * Parse a KoldInfo result CSV into re-linkable rows. Header names are matched first (IMPORT_ALIASES);
 * any key column the header didn't resolve is then identified BY CONTENT (email / ros_id / domain /
 * status signatures) — so the round-trip works regardless of what KoldInfo names its export columns.
 * Only rows carrying a usable email are returned (a no-hit row from KoldInfo is dropped).
 */
export function parseKoldInfoCsv(text: string): KoldInfoResult[] {
  const grid = parseCsv(text);
  if (grid.length < 2) return [];
  const map = detect(grid[0]);
  const taken = new Set<number>(Object.values(map).filter((v): v is number => v !== undefined));
  const fill = (f: Field, pred: (v: string) => boolean, min: number) => {
    if (map[f] !== undefined) return;
    const c = detectByContent(grid, pred, min, taken);
    if (c >= 0) { map[f] = c; taken.add(c); }
  };
  // Content fallback for the columns that actually drive matching + verdict.
  fill("email", (v) => RE_EMAIL.test(v), 0.5);
  fill("rosId", (v) => RE_ROSID.test(v), 0.5);
  fill("domain", (v) => RE_DOMAIN.test(v), 0.6);
  fill("vendorStatus", (v) => STATUS_WORDS.has(v.toLowerCase()), 0.6);
  if (map.email === undefined) return []; // no email column by name OR content → nothing to import
  const at = (row: string[], f: Field): string | undefined => {
    const i = map[f];
    if (i === undefined) return undefined;
    const v = (row[i] ?? "").trim();
    return v || undefined;
  };
  const out: KoldInfoResult[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const email = (at(row, "email") || "").toLowerCase();
    if (!email || !email.includes("@")) continue;
    out.push({
      rosId: at(row, "rosId"),
      email,
      firstName: at(row, "firstName"),
      lastName: at(row, "lastName"),
      fullName: at(row, "fullName"),
      company: at(row, "company"),
      domain: at(row, "domain"),
      vendorStatus: at(row, "vendorStatus"),
    });
  }
  return out;
}

/* ---------------------------------------------------------------- matching ---- */

/** Normalized key for name+domain fallback matching when ros_id didn't survive the round-trip. */
export function koldInfoMatchKey(fullName: string | undefined, domain: string | undefined, email?: string): string {
  const dom = (domain || (email ? email.split("@")[1] : "") || "").toLowerCase().trim();
  let first = "", last = "";
  if (fullName) { const s = splitFullName(fullName); first = s.firstName || ""; last = s.lastName || ""; }
  return (first + "|" + last + "|" + dom).toLowerCase().replace(/[^a-z0-9|.]/g, "");
}
