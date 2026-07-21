/**
 * RecruitersOS · Loxo Jobs -> Job Library
 *
 * Pulls every Job from the connected Loxo agency into the central Job Library
 * (lib/jobs), keyed by Loxo's own job id, so the library IS the agency's live
 * job list: new jobs appear, edited descriptions refresh, closed/filled jobs
 * flip to Closed, all automatically on every sync tick. From there the same
 * records feed AI Vetting desks, JD Sourcing runs, and OS Text pushes with no
 * copy and paste.
 *
 * Runs inside syncLoxo (every scheduler tick) and on demand from the Job
 * Library's "Pull from Loxo" button. Never throws: trouble is reported in the
 * result so the people/company sync that already landed is never failed.
 */

import { ensureJobsReady, upsertAtsJd, getJdByProvider, setJdStatus } from "../jobs";
import type { LoxoClient } from "./loxoClient";

export interface JobsSyncReport {
  scanned: number;
  added: number;
  updated: number;
  /** Jobs whose Loxo updated_at matched our stamp: no detail fetch, no upsert. */
  unchanged: number;
  error?: string;
}

const MAX_JOB_PAGES = 60; // 60 pages covers thousands of jobs; bounds one run
const DETAIL_CONCURRENCY = 4;

/** Pull all jobs for one workspace into the Job Library. */
export async function syncLoxoJobs(workspaceId: string, client: LoxoClient): Promise<JobsSyncReport> {
  const report: JobsSyncReport = { scanned: 0, added: 0, updated: 0, unchanged: 0 };
  try {
    await ensureJobsReady();
    const seen = new Set<string>();
    let pageSize = 0; // learned from the largest page; a shorter page = the last one
    let scrollId: string | undefined;
    for (let page = 1; page <= MAX_JOB_PAGES; page++) {
      // Speak both pagination styles: a returned scroll cursor wins (some
      // accounts serve the scroll style here); otherwise page numbers.
      const res = await client.listJobs(scrollId ? { scrollId } : { page });
      if (!res.items.length) break;

      // Guard against an account whose jobs endpoint ignores `page`: a page
      // that contributes nothing new means we're re-reading the same list.
      const fresh = res.items.filter((j) => {
        const id = j?.id != null ? String(j.id) : "";
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (!fresh.length) break;
      report.scanned += fresh.length;

      // Skip jobs whose Loxo updated_at matches what we stored last time: no
      // detail fetch, no upsert. This is what keeps the every-15-min tick to a
      // handful of list requests instead of re-reading the whole agency.
      const work = fresh.filter((item) => {
        const id = String(item.id);
        const itemUpdated = firstString(item?.updated_at, item?.updatedAt);
        const existing = getJdByProvider(workspaceId, id);
        const sameStatus = existing ? (jobIsOpen(item) ? "open" : "closed") === existing.status : false;
        if (existing && itemUpdated && existing.providerUpdatedAt === itemUpdated && sameStatus) {
          report.unchanged++;
          return false;
        }
        return true;
      });

      // The list may omit the description; hydrate those from the detail
      // endpoint (bounded concurrency, the client's rate gate does the pacing).
      const full = await hydrateJobs(work, client);
      for (const job of full) {
        const mapped = mapLoxoJob(job);
        if (!mapped) continue;
        const r = upsertAtsJd(workspaceId, mapped);
        if (r.created) report.added++;
        else if (r.changed) report.updated++;
      }

      scrollId = res.scrollId;
      pageSize = Math.max(pageSize, res.items.length);
      if (!scrollId && res.items.length < pageSize) break; // short page = last page on any page size
    }
    // One line when something actually happened (or broke), so prod logs show
    // the pull working without narrating every quiet tick.
    if (report.added || report.updated || report.error) {
      console.log(
        `[jobs] loxo sync ws=${workspaceId}: ${report.scanned} scanned, ${report.added} new, ${report.updated} updated, ${report.unchanged} unchanged${report.error ? `, error: ${report.error}` : ""}`,
      );
    }
    return report;
  } catch (e: any) {
    report.error = e?.message ?? "jobs_sync_failed";
    console.error(`[jobs] loxo sync failed ws=${workspaceId}:`, report.error);
    return report;
  }
}

/** Pull and upsert a SINGLE job by id (webhook create/update). */
export async function syncOneLoxoJob(workspaceId: string, client: LoxoClient, jobId: string): Promise<boolean> {
  await ensureJobsReady();
  const job = await client.getJob(jobId);
  if (!job) return false;
  const mapped = mapLoxoJob(job);
  if (!mapped) return false;
  upsertAtsJd(workspaceId, mapped);
  return true;
}

/** A job deleted in Loxo closes here (pairings and history are kept). */
export async function closeLoxoJob(workspaceId: string, jobId: string): Promise<boolean> {
  await ensureJobsReady();
  const jd = getJdByProvider(workspaceId, jobId);
  if (!jd) return false;
  setJdStatus(workspaceId, jd.id, "closed");
  return true;
}

/* ---------------- mapping ---------------- */

function mapLoxoJob(job: any): { providerId: string; title?: string; company?: string; text: string; open: boolean; providerUpdatedAt?: string } | null {
  const id = job?.id != null ? String(job.id) : "";
  if (!id) return null;
  const providerUpdatedAt = firstString(job?.updated_at, job?.updatedAt) || undefined;
  const title = firstString(job?.title, job?.published_name, job?.name);
  const company = firstString(job?.company?.name, job?.company_name, typeof job?.company === "string" ? job.company : "");
  const city = firstString(job?.city, job?.macro_address);
  const state = firstString(job?.state_code, job?.state?.name, typeof job?.state === "string" ? job.state : "");
  const loc = [city, state].filter(Boolean).join(", ");

  let text = stripHtml(firstString(job?.description, job?.description_text, job?.public_description, job?.internal_notes));
  const hadBody = Boolean(text);
  if (!text) {
    // Keep the record even when Loxo has no description yet: the header lines
    // make it usable, and the next sync fills the body in once it's written.
    text = [title || "Untitled role", company, loc].filter(Boolean).join("\n") +
      "\n\nNo job description text on this Loxo job yet. Add it in Loxo and it fills in here automatically on the next sync.";
  } else if (title && !text.slice(0, 200).toLowerCase().includes(title.toLowerCase())) {
    // Lead with the role header so downstream AI (desk auto-fill, sourcing
    // brief) always sees title/company/location even in a body that omits them.
    text = [title, company, loc].filter(Boolean).join("\n") + "\n\n" + text;
  }

  // A job stored WITHOUT a real description gets no skip stamp, so every tick
  // re-checks it until the JD is written in Loxo (or a failed detail fetch
  // succeeds): the placeholder must heal on its own, not wait for a job edit.
  return { providerId: id, title, company, text, open: jobIsOpen(job), providerUpdatedAt: hadBody ? providerUpdatedAt : undefined };
}

function jobIsOpen(job: any): boolean {
  const names = [job?.status, job?.job_status, job?.job_status_name, job?.status_name]
    .map((s: any) => (typeof s === "string" ? s : s?.name || ""))
    .join(" ")
    .toLowerCase();
  if (/closed|filled|lost|cancel|archiv|inactive/.test(names)) return false;
  if (job?.active === false) return false;
  if (job?.closed_at) return false;
  return true;
}

function firstString(...vals: any[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Loxo descriptions are HTML; flatten to readable plain text. */
function stripHtml(s: string): string {
  if (!s) return "";
  return s
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Swap items missing a description for their full detail record. */
async function hydrateJobs(items: any[], client: LoxoClient): Promise<any[]> {
  const out: any[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      const hasBody = firstString(item?.description, item?.description_text, item?.public_description);
      if (hasBody || item?.id == null) {
        out[idx] = item;
        continue;
      }
      const full = await client.getJob(item.id).catch(() => null);
      // Loxo's job DETAIL omits updated_at (verified live 2026-07-21); only the
      // LIST item carries it. Fold the list stamp onto the detail record or the
      // unchanged-skip can never engage and every tick re-reads every job.
      out[idx] = full
        ? { ...full, updated_at: full.updated_at ?? item.updated_at, updatedAt: full.updatedAt ?? item.updatedAt }
        : item;
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, items.length) }, worker));
  return out;
}
