/**
 * BD Bulk — the 200K/month top-of-funnel engine.
 *
 * GET  /api/bdbulk                          -> readiness: is the sending pool live + today's headroom
 * POST /api/bdbulk
 *   { action: "parse",   csv }              -> column mapping + row count + a small sample (no full echo)
 *   { action: "preview", csv, sample? }     -> enrich + assemble emails for the first `sample` rows (review before launch)
 *   { action: "launch",  csv, offset?, limit?, sender?, fromName? }
 *                                           -> enrich + assemble + SEND a window through the owned sending pool;
 *                                              returns a per-batch summary + `remaining` so the client/cron drains it.
 *
 * The client holds the raw CSV text and re-POSTs it with an advancing `offset` rather
 * than round-tripping 200K parsed rows. Parsing is cheap next to enrich+send.
 *
 * The personalization engine is lib/bd/bulkMpc (one cheap LLM call per unique lead at
 * enrich time, deterministic assembly on send). Sending goes through lib/providers/mta
 * -> the warmed domains/mailboxes pool, which enforces caps, rotation, and suppression.
 * BD motion only.
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import { enrichRows, assembleEmail, type BulkBdRow, type BulkCandidate } from "../../../lib/bd/bulkMpc";
import { sendEmail, mtaPreferred } from "../../../lib/providers/mta";
import { listDomains, listMailboxes, serverDailyCap, listServers } from "../../../lib/sending";

/** Hard cap on rows sent per launch call — the pool's caps gate the real rate; this
 *  just keeps one HTTP request bounded. The client/cron re-calls with the next offset. */
const LAUNCH_BATCH = Number(process.env.BDBULK_LAUNCH_BATCH || 200);
/** How many rows to enrich+show in the preview step. */
const PREVIEW_DEFAULT = 8;

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const [domains, mailboxes, servers] = await Promise.all([
    listDomains(ws), listMailboxes(ws), listServers(ws),
  ]);
  const activeDomains = domains.filter((d) => d.status === "active" && !d.pausedReason);
  const sendableMailboxes = mailboxes.filter((m) => m.status !== "paused" && activeDomains.some((d) => d.id === m.domainId));
  // Today's remaining headroom = sum of per-mailbox remaining, capped by per-IP ceilings.
  const mailboxHeadroom = sendableMailboxes.reduce((n, m) => n + Math.max(0, m.dailyCap - m.sentToday), 0);
  const serverHeadroom = servers.reduce((n, s) => n + Math.max(0, serverDailyCap(s) - (s.sentToday ?? 0)), 0);

  return ok({
    ready: mtaPreferred() && sendableMailboxes.length > 0,
    mtaPreferred: mtaPreferred(),
    pool: {
      activeDomains: activeDomains.length,
      sendableMailboxes: sendableMailboxes.length,
      remainingToday: Math.min(mailboxHeadroom, serverHeadroom || mailboxHeadroom),
    },
    // Surfaced so the tab can tell the user to go provision/warm the pool first.
    setupHint: sendableMailboxes.length === 0
      ? "No warmed mailboxes yet. Add + warm sending domains in the Sending tab before launching."
      : null,
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const b = await body<any>(req);
  if (!b || typeof b.action !== "string") return fail("missing action");

  if (b.action === "parse") {
    if (typeof b.csv !== "string" || !b.csv.trim()) return fail("empty csv");
    const parsed = parseCsv(b.csv);
    if (!parsed.rows.length) return fail("no data rows found");
    const { rows, missing } = toBulkRows(parsed);
    return ok({
      count: rows.length,
      columns: parsed.headers,
      mapping: parsed.mapping,
      missingRequired: missing,           // e.g. ["companyLocation"] — tell the user before they launch
      withEmail: rows.filter((r) => r.email).length,
      sample: rows.slice(0, 5),           // a few rows so the UI can confirm the mapping looks right
    });
  }

  if (b.action === "preview") {
    if (typeof b.csv !== "string" || !b.csv.trim()) return fail("empty csv");
    const { rows } = toBulkRows(parseCsv(b.csv));
    if (!rows.length) return fail("no rows");
    const sample = rows.slice(0, Math.max(1, Math.min(Number(b.sample) || PREVIEW_DEFAULT, 25)));
    const enriched = await enrichRows(sample);
    const emails = sample.map((row, i) => ({ row, enrichment: enriched[i], email: assembleEmail(row, enriched[i], i) }));
    return ok({ previews: emails });
  }

  if (b.action === "launch") {
    if (!mtaPreferred()) return fail("sending pool not enabled (SENDING_EMAIL_PROVIDER=mta)", 409);
    if (typeof b.csv !== "string" || !b.csv.trim()) return fail("empty csv");
    const { rows } = toBulkRows(parseCsv(b.csv));
    if (!rows.length) return fail("no rows");

    const offset = Math.max(0, Number(b.offset) || 0);
    const limit = Math.max(1, Math.min(Number(b.limit) || LAUNCH_BATCH, LAUNCH_BATCH));
    const window = rows.slice(offset, offset + limit);
    if (!window.length) return ok({ done: true, offset, sent: 0, remaining: 0 });

    const enriched = await enrichRows(window);
    const sender: string | undefined = typeof b.sender === "string" ? b.sender : undefined;
    const fromName: string | undefined = typeof b.fromName === "string" ? b.fromName : undefined;

    const summary = { attempted: 0, sent: 0, suppressed: 0, noCapacity: 0, errors: 0 };
    let capacityHit = false;
    for (let i = 0; i < window.length; i++) {
      const row = window[i];
      const to = (row as any).email as string | undefined;
      if (!to) { summary.errors++; continue; }
      const mail = assembleEmail(row, enriched[i], offset + i);
      summary.attempted++;
      const res = await sendEmail(ws, {
        to,
        subject: mail.subject,
        plainBody: mail.body,
        htmlBody: `<p>${escapeHtml(mail.body)}</p>`,
        fromName,
        replyTo: sender,
      });
      if (res.ok) summary.sent++;
      else if (res.skipped === "suppressed") summary.suppressed++;
      else if (res.skipped === "no_capacity") { summary.noCapacity++; capacityHit = true; break; } // pool full for today; stop the batch
      else summary.errors++;
    }

    const processed = offset + summary.attempted;
    return ok({
      ...summary,
      offset,
      processed,
      remaining: Math.max(0, rows.length - processed),
      capacityHit,   // true -> pool is at today's ceiling; resume tomorrow / after warmup ramps
      done: processed >= rows.length,
    });
  }

  return fail("unknown action");
}

/* ------------------------------------------------------------------ */
/* CSV parsing + column mapping                                        */
/* ------------------------------------------------------------------ */

interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  mapping: Record<string, string>; // canonical field -> source header
}

/** Minimal RFC-4180-ish CSV parser: quotes, escaped quotes, CRLF, commas in quotes. */
function parseCsv(text: string): ParsedCsv {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) records.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x.trim() !== "")) records.push(row); }

  const headers = (records.shift() || []).map((h) => h.trim());
  const rows = records.map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
  return { headers, rows, mapping: guessMapping(headers) };
}

/** Map source headers to our canonical fields by fuzzy name match. */
function guessMapping(headers: string[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const find = (...subs: string[]) =>
    headers.find((h) => { const n = norm(h); return subs.some((s) => n === s) ; }) ||
    headers.find((h) => { const n = norm(h); return subs.some((s) => n.includes(s)); });

  const m: Record<string, string> = {};
  const first = find("firstname", "first", "fname", "givenname");
  if (first) m.firstName = first;
  const title = find("title", "jobtitle", "position", "role");
  if (title) m.title = title;
  const company = find("company", "companyname", "employer", "account", "organization", "org");
  if (company) m.company = company;
  // location can be one column, or city + state we join later
  const loc = find("companylocation", "location", "citystate", "metro");
  if (loc) m.companyLocation = loc;
  const city = find("city");
  if (city) m.city = city;
  const state = find("state", "region", "province");
  if (state) m.state = state;
  const email = find("email", "emailaddress", "workemail");
  if (email) m.email = email;
  const domain = find("companydomain", "website", "domain", "companyurl");
  if (domain) m.companyDomain = domain;
  // optional real-candidate columns (unlock the NAMED-competitor hook honestly)
  const candFrom = find("candidatefrom", "fromcompany", "currentemployer", "candidatecompany");
  if (candFrom) m.candFrom = candFrom;
  const candRole = find("candidaterole", "candidatetitle");
  if (candRole) m.candRole = candRole;
  const candCity = find("candidatecity", "candidatelocation");
  if (candCity) m.candCity = candCity;
  const candProof = find("proofpoint", "candidateproof", "achievement");
  if (candProof) m.candProof = candProof;
  return m;
}

/** Build typed BulkBdRow[] from a parsed CSV, reporting which required fields are absent. */
function toBulkRows(p: ParsedCsv): { rows: Array<BulkBdRow & { email?: string }>; missing: string[] } {
  const m = p.mapping;
  const required = ["firstName", "title", "company", "companyLocation"] as const;
  const missing = required.filter((k) => {
    if (k === "companyLocation") return !m.companyLocation && !(m.city || m.state);
    return !m[k];
  });

  const rows = p.rows.map((r) => {
    const location = m.companyLocation
      ? r[m.companyLocation]
      : [m.city && r[m.city], m.state && r[m.state]].filter(Boolean).join(", ");
    const candidate: BulkCandidate | undefined =
      m.candFrom || m.candRole || m.candCity || m.candProof
        ? {
            fromCompany: m.candFrom ? r[m.candFrom] || undefined : undefined,
            role: m.candRole ? r[m.candRole] || undefined : undefined,
            currentCity: m.candCity ? r[m.candCity] || undefined : undefined,
            proofPoint: m.candProof ? r[m.candProof] || undefined : undefined,
          }
        : undefined;
    return {
      firstName: m.firstName ? r[m.firstName] : "",
      title: m.title ? r[m.title] : "",
      company: m.company ? r[m.company] : "",
      companyLocation: location || "",
      companyDomain: m.companyDomain ? r[m.companyDomain] || undefined : undefined,
      email: m.email ? r[m.email] || undefined : undefined,
      candidate,
    };
  });
  return { rows, missing };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
