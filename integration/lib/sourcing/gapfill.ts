/**
 * RecruitersOS · JD Sourcing · in-house contact gap-fill.
 *
 * The cheap-first contact waterfall over rows still missing an email or a phone.
 * Cache-first (a contact resolved for this person in any run is reused free), then the
 * configured waterfall providers. Rows that already hold an email get a PHONE-ONLY plan
 * (the known email doubles as a lookup key) instead of being skipped. Mutates the rows
 * in place; the CALLER persists the run.
 *
 * Shared by the sourcing route's `enrich` + `laxisStatus` actions and the overnight
 * queue processor.
 */

import type { CandidateRow } from "./types";
import { getCachedContact, putCachedContact } from "./cache";
import { enrich, cheapFirstContactWaterfall } from "../signals";
import { nowIso } from "../core/ids";

export interface GapFillResult {
  /** Candidates that gained an email. */
  enriched: number;
  /** Candidates that gained a phone. */
  phones: number;
  /** Rows answered from the contact cache (no lookup spent). */
  cacheHits: number;
}

export async function gapFillContacts(ws: string, rows: CandidateRow[]): Promise<GapFillResult> {
  const plan = cheapFirstContactWaterfall({ includePhone: true });
  const phonePlan = { ...plan, steps: plan.steps.filter((s) => s.field !== "email") };
  let enrichedCount = 0;
  let phones = 0;
  let contactCacheHits = 0;
  for (const c of rows) {
    const hasEmail = Boolean((c.email || "").trim());
    const hasPhone = Boolean((c.phone || "").trim());
    if (hasEmail && hasPhone) continue;
    const personKey = c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`;
    const cached = await getCachedContact(ws, personKey);
    if (cached && (cached.email || cached.phone)) {
      if (cached.email && !hasEmail) { c.email = cached.email; enrichedCount++; }
      if (cached.phone && !hasPhone) { c.phone = cached.phone; phones++; }
      contactCacheHits++;
      continue;
    }
    const [first, ...rest] = (c.fullName || "").trim().split(/\s+/);
    try {
      const report = await enrich(hasEmail ? phonePlan : plan, {
        name: c.company, companyName: c.company, fullName: c.fullName,
        firstName: first, lastName: rest.join(" "), linkedinUrl: c.linkedinUrl, title: c.title,
        email: (c.email || "").trim() || undefined,
      }, { now: nowIso() });
      const e = report.subject.email; const ph = report.subject.phone;
      if (typeof e === "string" && !hasEmail) { c.email = e; enrichedCount++; }
      if (typeof ph === "string" && !hasPhone) { c.phone = ph; phones++; }
      // Cache the row's settled answer (email + phone together), not just this lookup's.
      await putCachedContact(ws, personKey, {
        email: (c.email || "").trim() || undefined,
        phone: (c.phone || "").trim() || undefined,
      });
    } catch { /* leave unresolved */ }
  }
  return { enriched: enrichedCount, phones, cacheHits: contactCacheHits };
}
