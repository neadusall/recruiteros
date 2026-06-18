/**
 * RecruitersOS · JD Sourcing — Laxis enrichment client.
 *
 * Laxis has no API, so a sidecar browser worker (../../../laxis-worker) drives the real
 * app.laxis.tech/prospect-search UI: it takes a CSV, uploads it, runs Laxis's enrichment,
 * and hands back the enriched CSV. This module is the app side of that contract — it
 * lives entirely in our process and only ever speaks JSON to the worker over the internal
 * Docker network. It does three things:
 *
 *   1. serialize the staged CandidateRow[] into a CSV in Laxis's import shape
 *   2. submit / poll a worker job (the same submit→poll→collect shape as deep-vet batches)
 *   3. merge the enriched CSV back onto the rows by a stable key (LinkedIn URL → name+company)
 *
 * Laxis is the FIRST enrichment pass; the existing cheap contact waterfall fills whatever
 * Laxis leaves blank (wired in the sourcing route). Nothing here fabricates contact data —
 * a row only gains an email/phone if Laxis actually returned one for it.
 */

import type { CandidateRow } from "./types";

const WORKER_URL = (process.env.LAXIS_WORKER_URL || "http://laxis-worker:3000").replace(/\/+$/, "");
const WORKER_TOKEN = process.env.LAXIS_WORKER_TOKEN || "";

/** True when a worker URL is configured. The worker itself reports whether creds are set. */
export function laxisWorkerConfigured(): boolean {
  return Boolean(process.env.LAXIS_WORKER_URL || process.env.LAXIS_WORKER_ENABLED === "1");
}

/**
 * Laxis caps a single prospect-search import at 1,000 contacts. We never send more than
 * this in one job; a larger staged list is enriched in sequential 1,000-row chunks
 * (the route paginates with a `start` offset). Overridable if Laxis raises the limit.
 */
export const MAX_LAXIS_UPLOAD = Number(process.env.LAXIS_MAX_UPLOAD || 1000);

/**
 * The exact import format Laxis prospect-search expects — two columns, snake_case headers:
 *
 *   email,linkedin_url
 *   example@example.com,https://www.linkedin.com/in/example
 *
 * linkedin_url is the identifier Laxis enriches from (and what we match the enriched export
 * back on); email is what we want Laxis to find, included blank when we don't have it yet.
 */
export const LAXIS_CSV_COLUMNS = ["email", "linkedin_url"] as const;

/* ----------------------------------------------------------------------------- */
/* CSV helpers — small, correct (handles quotes, commas, embedded newlines).      */
/* ----------------------------------------------------------------------------- */

function csvCell(value: string | undefined): string {
  const s = (value ?? "").toString();
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Parse a CSV string into header names + row objects keyed by header. RFC-4180-ish. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") records.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") records.push(row); }

  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((rec) => {
    const o: Record<string, string> = {};
    headers.forEach((h, idx) => { o[h] = (rec[idx] ?? "").trim(); });
    return o;
  });
  return { headers, rows };
}

/**
 * Serialize the staged candidates into Laxis's two-column import CSV (email, linkedin_url).
 * Laxis enriches from the linkedin_url, so rows WITHOUT a LinkedIn URL (and without an
 * email) are dropped — Laxis has nothing to key off them. Returns the CSV plus how many
 * rows were sent vs skipped, so the caller can tell the recruiter.
 */
export function serializeCandidatesCsv(rows: CandidateRow[]): { csv: string; sent: number; skipped: number } {
  const lines = [LAXIS_CSV_COLUMNS.join(",")];
  let sent = 0;
  let skipped = 0;
  for (const c of rows) {
    const li = (c.linkedinUrl || "").trim();
    const email = (c.email || "").trim();
    if (!li && !email) { skipped++; continue; } // nothing for Laxis to identify
    lines.push([csvCell(email), csvCell(li)].join(","));
    sent++;
  }
  return { csv: lines.join("\r\n") + "\r\n", sent, skipped };
}

/* ----------------------------------------------------------------------------- */
/* Worker transport                                                               */
/* ----------------------------------------------------------------------------- */

function authHeaders(): Record<string, string> {
  return WORKER_TOKEN ? { authorization: `Bearer ${WORKER_TOKEN}` } : {};
}

export interface LaxisJobStatus {
  jobId: string;
  status: "queued" | "running" | "done" | "error";
  stage?: string;
  enrichedCsv?: string;
  error?: string;
}

/** Submit a CSV to the worker. Returns the worker's job id to poll. */
export async function submitLaxisJob(csv: string): Promise<string> {
  const res = await fetch(`${WORKER_URL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ csv }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw Object.assign(new Error(`laxis_worker_submit_failed: ${res.status} ${detail}`), { status: 502 });
  }
  const data = (await res.json()) as { jobId?: string };
  if (!data.jobId) throw Object.assign(new Error("laxis_worker_no_job_id"), { status: 502 });
  return data.jobId;
}

/** Poll a worker job. */
export async function getLaxisJob(jobId: string): Promise<LaxisJobStatus> {
  const res = await fetch(`${WORKER_URL}/jobs/${encodeURIComponent(jobId)}`, { headers: authHeaders() });
  if (res.status === 404) return { jobId, status: "error", error: "job_not_found (worker may have restarted)" };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw Object.assign(new Error(`laxis_worker_poll_failed: ${res.status} ${detail}`), { status: 502 });
  }
  return (await res.json()) as LaxisJobStatus;
}

/* ----------------------------------------------------------------------------- */
/* Merge enriched CSV back onto the candidate rows                                 */
/* ----------------------------------------------------------------------------- */

/** Normalize a LinkedIn URL so the input and Laxis's export match despite www/protocol/
 *  trailing-slash/query differences. linkedin.com/in/jane === https://www.linkedin.com/in/jane/ */
function normLinkedin(url: string): string {
  return (url || "")
    .trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

/** Stable match key: normalized LinkedIn URL when present, else name+company. Used to
 *  re-attach Laxis's enriched rows to the right candidate. */
export function laxisCandKey(c: { linkedinUrl?: string; fullName?: string; company?: string }): string {
  if (c.linkedinUrl && c.linkedinUrl.trim()) return normLinkedin(c.linkedinUrl);
  return `${(c.fullName ?? "").toLowerCase().trim()}|${(c.company ?? "").toLowerCase().trim()}`;
}

/** Find the first header whose name matches `re`, preferring headers that also match `prefer`. */
function pickHeader(headers: string[], re: RegExp, prefer?: RegExp): string | undefined {
  const hits = headers.filter((h) => re.test(h));
  if (!hits.length) return undefined;
  if (prefer) {
    const preferred = hits.find((h) => prefer.test(h));
    if (preferred) return preferred;
  }
  return hits[0];
}

export interface LaxisMergeResult {
  /** How many candidate rows were matched to an enriched record. */
  matched: number;
  /** How many rows gained an email they didn't have. */
  emails: number;
  /** How many rows gained a phone they didn't have. */
  phones: number;
  /** Enriched records that couldn't be matched to any candidate (diagnostics). */
  unmatched: number;
}

/**
 * Merge an enriched CSV back onto the candidate rows. Matches each enriched record to a
 * candidate by LinkedIn URL first, then name+company. Only fills email/phone that the
 * candidate is missing — never overwrites data we already have, never invents a value.
 * Mutates `rows` in place and returns counts.
 */
export function mergeEnrichedCsv(rows: CandidateRow[], enrichedCsv: string): LaxisMergeResult {
  const { headers, rows: records } = parseCsv(enrichedCsv);
  const result: LaxisMergeResult = { matched: 0, emails: 0, phones: 0, unmatched: 0 };
  if (!records.length) return result;

  // Header-tolerant column detection — Laxis label names vary.
  const hLinkedin = pickHeader(headers, /linked\s?in|profile\s*url/i);
  const hName = pickHeader(headers, /full\s*name|^name$/i) || pickHeader(headers, /name/i);
  const hCompany = pickHeader(headers, /company|organi[sz]ation|employer/i);
  const hEmail = pickHeader(headers, /e-?mail/i, /work|business|verified|primary/i);
  const hPhone = pickHeader(headers, /phone|mobile|tel|direct/i, /mobile|direct|work/i);

  const byKey = new Map<string, CandidateRow>();
  for (const c of rows) byKey.set(laxisCandKey(c), c);

  // Laxis writes the literal string "null" (and sometimes "N/A"/"-") for missing fields.
  const clean = (v: string | undefined): string => {
    const s = (v || "").trim();
    return /^(null|n\/?a|none|-|undefined)$/i.test(s) ? "" : s;
  };

  for (const rec of records) {
    const liKey = hLinkedin ? laxisCandKey({ linkedinUrl: rec[hLinkedin] }) : "";
    const nameKey = laxisCandKey({ fullName: hName ? rec[hName] : "", company: hCompany ? rec[hCompany] : "" });
    const c = (liKey && byKey.get(liKey)) || byKey.get(nameKey);
    if (!c) { result.unmatched++; continue; }
    result.matched++;

    const email = hEmail ? clean(rec[hEmail]) : "";
    const phone = hPhone ? clean(rec[hPhone]) : "";
    if (email && !c.email && /@/.test(email)) { c.email = email; result.emails++; }
    if (phone && !c.phone) { c.phone = phone; result.phones++; }
  }
  return result;
}
