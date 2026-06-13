/**
 * RecruitersOS · Data enrichment
 *
 * Two jobs:
 *   1. enrichRecord — fill a warehouse record's missing email/phone via the
 *      cheapest-first contact waterfall (same engine Prospects uses).
 *   2. backfillFromWarehouse — the FREE step campaign enrichment runs first:
 *      look the person up in the warehouse and return any contact we already own,
 *      so we only spend on a paid lookup for the genuine gaps.
 */

import { nowIso } from "../core/ids";
import { saveRecord, findRecordForPerson } from "./store";
import type { DataRecord } from "./types";

/** Resolve missing email/phone for a stored record. Persists what it finds. */
export async function enrichRecord(
  rec: DataRecord,
  field?: "email" | "phone",
): Promise<{ record: DataRecord; found: { email: boolean; phone: boolean } }> {
  const [first, ...rest] = (rec.fullName || "").trim().split(/\s+/);
  let email = rec.email;
  let phone = rec.phone || rec.directPhone;

  try {
    const { cheapFirstContactWaterfall, enrich } = await import("../signals");
    const report = await enrich(
      cheapFirstContactWaterfall(),
      {
        name: rec.company,
        companyName: rec.company,
        domain: rec.companyDomain,
        fullName: rec.fullName,
        firstName: first,
        lastName: rest.join(" "),
        linkedinUrl: rec.linkedinUrl,
        title: rec.title,
      },
      { now: nowIso() },
    );
    const e = report.subject.email;
    const ph = report.subject.phone;
    if (typeof e === "string") email = e;
    if (typeof ph === "string") phone = ph;
  } catch {
    /* leave unresolved; user can retry or add manually */
  }

  const found = {
    email: field !== "phone" && !!email && email !== rec.email,
    phone: field !== "email" && !!phone && phone !== (rec.phone || rec.directPhone),
  };
  if (field !== "phone" && email) rec.email = email;
  if (field !== "email" && phone && !rec.phone) rec.phone = phone;
  if (found.email || found.phone) rec.enrichedAt = nowIso();
  await saveRecord(rec);
  return { record: rec, found };
}

/**
 * FREE first pass: pull contact from the warehouse for a lead being added to a
 * campaign. Returns only values the caller is missing. Read-only — does not spend.
 */
export async function backfillFromWarehouse(
  workspaceId: string,
  who: { fullName?: string; company?: string; linkedinUrl?: string; email?: string; phone?: string },
): Promise<{ email?: string; phone?: string; matched: boolean }> {
  const rec = await findRecordForPerson(workspaceId, who);
  if (!rec) return { matched: false };
  return {
    email: !who.email && rec.email ? rec.email : undefined,
    phone: !who.phone && (rec.phone || rec.directPhone) ? rec.phone || rec.directPhone : undefined,
    matched: true,
  };
}
