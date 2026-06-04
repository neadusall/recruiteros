/**
 * RecruiterOS · Data import
 * Normalize CSV/portal-export rows into DataRecordInput.
 *
 * Rows arrive keyed by their ORIGINAL column header (exactly as exported). We map
 * each header to a canonical field — using an explicit user mapping when provided,
 * otherwise a best-effort guess from common ZoomInfo/portal column names — and keep
 * the full original row in `raw` so nothing is lost. The de-dupe + upsert happens
 * downstream in the store.
 */

import type { DataRecordInput, DataSource } from "./types";

/** Canonical fields the UI can map a column to (key, label). */
export const FIELD_KEYS: Array<[keyof DataRecordInput | "firstName" | "lastName" | "ignore", string]> = [
  ["ignore", "— ignore —"],
  ["fullName", "Full name"],
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["title", "Job title"],
  ["company", "Company"],
  ["companyDomain", "Company domain / website"],
  ["industry", "Industry"],
  ["email", "Email"],
  ["email2", "Email (secondary)"],
  ["phone", "Phone / mobile"],
  ["directPhone", "Direct phone"],
  ["companyPhone", "Company phone"],
  ["linkedinUrl", "LinkedIn URL"],
  ["city", "City"],
  ["state", "State"],
  ["country", "Country"],
  ["seniority", "Seniority"],
  ["providerId", "Provider record id"],
];

/** Guess the canonical field for an exported column header. */
export function guessField(header: string): string {
  const h = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  const has = (...subs: string[]) => subs.some((s) => h.includes(s));

  if (has("linkedin")) return "linkedinUrl";
  if (has("fullname") || h === "name" || h === "contactname") return "fullName";
  if (has("firstname") || h === "first") return "firstName";
  if (has("lastname") || h === "last" || h === "surname") return "lastName";
  if (has("jobtitle", "title", "position")) return "title";
  if (has("companydomain", "website", "companyurl", "domain")) return "companyDomain";
  if (has("companyname") || h === "company" || h === "employer" || h === "account") return "company";
  if (has("industry", "sector")) return "industry";
  if (has("emailaddress") || h === "email" || has("workemail", "businessemail")) return "email";
  if (has("personalemail", "secondaryemail", "email2", "otheremail")) return "email2";
  if (has("mobile", "cell")) return "phone";
  if (has("directphone", "directdial", "directnumber")) return "directPhone";
  if (has("companyphone", "hqphone", "mainphone", "officephone")) return "companyPhone";
  if (h === "phone" || has("phonenumber", "phone1")) return "phone";
  if (h === "city") return "city";
  if (h === "state" || has("region", "province")) return "state";
  if (h === "country") return "country";
  if (has("seniority", "managementlevel", "joblevel")) return "seniority";
  if (has("zoominfoid", "contactid", "personid", "recordid")) return "providerId";
  return "ignore";
}

const clean = (v: unknown): string | undefined => {
  const s = v == null ? "" : String(v).trim();
  return s ? s : undefined;
};

export interface ImportOptions {
  /** header → canonical field. Omitted headers are guessed. */
  mapping?: Record<string, string>;
  source?: DataSource;
}

/**
 * Turn raw exported rows (keyed by original header) into normalized inputs.
 * Drops rows with no resolvable name. Keeps the full original row in `raw`.
 */
export function rowsToInputs(rows: Array<Record<string, unknown>>, opts: ImportOptions = {}): DataRecordInput[] {
  const source: DataSource = opts.source || "csv";
  const out: DataRecordInput[] = [];

  for (const row of rows) {
    const rec: Record<string, string | undefined> = {};
    const raw: Record<string, string> = {};
    let firstName: string | undefined;
    let lastName: string | undefined;

    for (const [header, value] of Object.entries(row)) {
      const v = clean(value);
      if (v !== undefined) raw[header] = v;
      const field = opts.mapping?.[header] || guessField(header);
      if (!field || field === "ignore" || v === undefined) continue;
      if (field === "firstName") firstName = v;
      else if (field === "lastName") lastName = v;
      else rec[field] = v;
    }

    const fullName = rec.fullName || [firstName, lastName].filter(Boolean).join(" ");
    if (!fullName) continue;

    out.push({
      fullName,
      firstName: firstName || fullName.trim().split(/\s+/)[0],
      lastName: lastName || (rec.fullName ? rec.fullName.trim().split(/\s+/).slice(1).join(" ") || undefined : undefined),
      title: rec.title,
      seniority: rec.seniority,
      company: rec.company,
      companyDomain: rec.companyDomain,
      industry: rec.industry,
      email: rec.email,
      email2: rec.email2,
      phone: rec.phone,
      directPhone: rec.directPhone,
      companyPhone: rec.companyPhone,
      linkedinUrl: rec.linkedinUrl,
      city: rec.city,
      state: rec.state,
      country: rec.country,
      source,
      providerId: rec.providerId,
      raw,
    });
  }
  return out;
}
