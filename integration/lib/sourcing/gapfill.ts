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
import { sourceFromProviderId } from "./phoneSources";
import { enrich, cheapFirstContactWaterfall } from "../signals";
import { fillPhonesFromLandlineDb } from "./landlinePhones";
import { withWorkspaceCreds } from "../connected";
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
  // Workspace-cred context for the WHOLE gap-fill: the waterfall providers read
  // their keys via cred(), which only sees Setup-pasted keys inside this wrapper.
  // Without it, a phone-finder key saved in Setup never reached this code path.
  return withWorkspaceCreds(ws, () => gapFillInner(ws, rows));
}

async function gapFillInner(ws: string, rows: CandidateRow[]): Promise<GapFillResult> {
  // includeMobile too: the dedicated mobile listing (RAPIDAPI_MOBILE_HOST/PATH) joins
  // the waterfall the moment it is configured in Setup; unconfigured rungs self-skip.
  const plan = cheapFirstContactWaterfall({ includePhone: true, includeMobile: true });
  const phonePlan = { ...plan, steps: plan.steps.filter((s) => s.field !== "email") };
  let enrichedCount = 0;
  let phones = 0;
  let contactCacheHits = 0;
  // FREE rung first: our own LandlineDB (~2.5M named-person phone rows, ~960k explicit
  // cells) fills what it can before any cached-or-paid lookup runs. Blanks only.
  try { phones += await fillPhonesFromLandlineDb(rows); } catch { /* rung is optional */ }

  const fillOne = async (c: CandidateRow): Promise<void> => {
    const hasEmail = Boolean((c.email || "").trim());
    const hasPhone = Boolean((c.phone || "").trim());
    if (hasEmail && hasPhone) return;
    const personKey = c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`;
    const cached = await getCachedContact(ws, personKey);
    if (cached && (cached.email || cached.phone)) {
      if (cached.email && !hasEmail) { c.email = cached.email; enrichedCount++; }
      if (cached.phone && !hasPhone) { c.phone = cached.phone; c.phoneSource = cached.phoneSource; phones++; }
      contactCacheHits++;
      return;
    }
    const [first, ...rest] = (c.fullName || "").trim().split(/\s+/);
    try {
      const report = await enrich(hasEmail ? phonePlan : plan, {
        name: c.company, companyName: c.company, fullName: c.fullName,
        firstName: first, lastName: rest.join(" "), linkedinUrl: c.linkedinUrl, title: c.title,
        email: (c.email || "").trim() || undefined,
      }, { now: nowIso() });
      const e = report.subject.email;
      // A mobile-rung hit lands on its own field; for the candidate row it is simply
      // the best phone we have, so it backfills the generic phone slot.
      const ph = report.subject.phone
        ?? (report.resolved?.mobilePhone?.value as string | undefined);
      if (typeof e === "string" && !hasEmail) { c.email = e; enrichedCount++; }
      if (typeof ph === "string" && !hasPhone) {
        c.phone = ph;
        // Which listing produced it (generic phone or mobile rung): provenance for
        // the phone-accuracy metric.
        c.phoneSource = sourceFromProviderId(
          (report.resolved?.phone?.providerId as string | undefined) ??
          (report.resolved?.mobilePhone?.providerId as string | undefined),
        );
        phones++;
      }
      // Cache the row's settled answer (email + phone together), not just this lookup's.
      await putCachedContact(ws, personKey, {
        email: (c.email || "").trim() || undefined,
        phone: (c.phone || "").trim() || undefined,
        phoneSource: c.phoneSource,
      });
    } catch { /* leave unresolved */ }
  };

  // Rows resolve CONCURRENTLY (small pool) instead of strictly one after another:
  // same cache-first lookup and same waterfall per row, just no idle waiting
  // between rows. The pool stays small because the waterfall providers carry no
  // 429 retry of their own — a burst they'd reject would LOSE contacts, and a
  // 3-wide pool keeps the request rate near what sequential pacing produced.
  let next = 0;
  const workers = Math.min(3, rows.length);
  if (workers > 0) {
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) {
        const c = rows[next++];
        if (!c) return;
        await fillOne(c);
      }
    }));
  }
  return { enriched: enrichedCount, phones, cacheHits: contactCacheHits };
}
