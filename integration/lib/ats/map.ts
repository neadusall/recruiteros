/**
 * RecruiterOS · ATS mappers (Loxo → RecruiterOS)
 *
 * The single place that translates Loxo's person/company payloads into the
 * normalized shapes the rest of the app already understands:
 *   Loxo Person  → DataRecordInput  (lands in the Data warehouse as a Candidate)
 *   Loxo Company → CompanyInput     (lands in the BD company book)
 *
 * Loxo's fields vary by account and endpoint, so every read is defensive: we
 * try the common keys and fall back gracefully. Adjust the picks here if your
 * agency's payloads name things differently — nothing else needs to change.
 *
 * NOTE: Loxo flags that profiles sourced from "Loxo Source" are proprietary and
 * return only name/id/custom fields. Those still map cleanly (contact fields are
 * simply absent); data you brought into your own database comes back in full.
 */

import type { DataRecordInput } from "../data/types";
import type { CompanyInput, CompanyStatus } from "../companies/types";

type Loxo = Record<string, any>;

const str = (v: any): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
};

/** First value from a Loxo list-of-objects like emails:[{value}] or [{email}]. */
function firstVal(list: any, keys: string[]): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (typeof item === "string") {
      const s = str(item);
      if (s) return s;
      continue;
    }
    if (item && typeof item === "object") {
      for (const k of keys) {
        const s = str(item[k]);
        if (s) return s;
      }
    }
  }
  return undefined;
}

/** Find a phone of a given type (mobile/work) from Loxo's phones array. */
function phoneOfType(list: any, type: string): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (item && typeof item === "object") {
      const t = String(item.phone_type ?? item.type ?? "").toLowerCase();
      if (t.includes(type)) {
        const s = str(item.value ?? item.phone ?? item.number);
        if (s) return s;
      }
    }
  }
  return undefined;
}

function joinLocation(p: Loxo): string | undefined {
  const direct = str(p.location) || str(p.address);
  if (direct) return direct;
  const parts = [str(p.city), str(p.state) || str(p.region), str(p.country)].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** Loxo Person → warehouse record, tagged as a Candidate from Loxo. */
export function loxoPersonToDataRecord(p: Loxo): DataRecordInput {
  const first = str(p.first_name);
  const last = str(p.last_name);
  const fullName = str(p.name) || [first, last].filter(Boolean).join(" ") || "(unknown)";

  const company =
    str(p.company) ||
    str(p.current_company) ||
    str(p.company_name) ||
    (p.current_company && str(p.current_company.name)) ||
    undefined;

  const title = str(p.current_title) || str(p.title) || str(p.job_title);

  const email = str(p.email) || firstVal(p.emails, ["value", "email"]);
  const mobile = phoneOfType(p.phones, "mobile") || phoneOfType(p.phones, "cell");
  const work = phoneOfType(p.phones, "work") || phoneOfType(p.phones, "office");
  const anyPhone = str(p.phone) || firstVal(p.phones, ["value", "phone", "number"]);

  const tags = Array.isArray(p.job_categories)
    ? p.job_categories.map((c: any) => str(typeof c === "string" ? c : c?.name)).filter(Boolean) as string[]
    : Array.isArray(p.tags)
      ? p.tags.map((t: any) => str(typeof t === "string" ? t : t?.name)).filter(Boolean) as string[]
      : undefined;

  // Loxo "person_global_status" / latest workflow stage → our `stage`.
  const stage =
    str(p.person_global_status && (p.person_global_status.name || p.person_global_status)) ||
    str(p.workflow_stage_name) ||
    str(p.stage);

  return {
    fullName,
    firstName: first,
    lastName: last,
    title,
    company,
    companyDomain: str(p.company_domain) || str(p.company_url),
    companyId: str(p.company_id),
    email,
    email2: firstVal(Array.isArray(p.emails) ? p.emails.slice(1) : [], ["value", "email"]),
    phone: mobile || anyPhone,
    directPhone: work,
    linkedinUrl: str(p.linkedin_url) || str(p.linkedin) || firstVal(p.social_profiles, ["url"]),
    city: str(p.city),
    state: str(p.state) || str(p.region),
    country: str(p.country),
    bio: str(p.description) || str(p.summary),
    compensation: str(p.compensation) || str(p.salary),
    owner: str(p.owner && (p.owner.name || p.owner)) || str(p.owned_by),
    stage,
    tags,
    recordType: "Candidate",
    origin: "Loxo",
    lastActivityAt: str(p.updated_at) || str(p.last_activity_at),
    source: "loxo",
    providerId: str(p.id),
    raw: flatten(p),
  } as DataRecordInput;
}

/** Loxo Company → BD company record. */
export function loxoCompanyToRecord(c: Loxo): CompanyInput {
  const url = str(c.url) || str(c.website) || str(c.domain);
  return {
    name: str(c.name) || "(unknown)",
    url,
    location: joinLocation(c),
    owner: str(c.owner && (c.owner.name || c.owner)) || str(c.owned_by),
    type: str(c.company_type && (c.company_type.name || c.company_type)) || str(c.type) || "Company",
    status: mapCompanyStatus(c),
    jobs: typeof c.job_count === "number" ? c.job_count : typeof c.jobs_count === "number" ? c.jobs_count : 0,
    tags: Array.isArray(c.tags)
      ? (c.tags.map((t: any) => str(typeof t === "string" ? t : t?.name)).filter(Boolean) as string[])
      : [],
    source: "loxo",
    providerId: str(c.id),
    created: str(c.created_at),
    raw: flatten(c),
  };
}

function mapCompanyStatus(c: Loxo): CompanyStatus {
  const s = String(c.status?.name ?? c.status ?? c.company_status ?? "").toLowerCase();
  if (s.includes("client") || s.includes("won")) return "current_client";
  if (s.includes("active") || s.includes("opportunity")) return "active_opportunity";
  if (s.includes("dead") || s.includes("lost")) return "dead_opportunity";
  if (s.includes("progress") || s.includes("engaged")) return "in_progress";
  if (s.includes("do not") || s.includes("dnc")) return "do_not_prospect";
  return "uncontacted";
}

/** Reduce a nested Loxo object to a flat string map for the `raw` audit field. */
function flatten(obj: Loxo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") {
      try {
        out[k] = JSON.stringify(v).slice(0, 500);
      } catch {
        /* skip */
      }
    } else {
      out[k] = String(v);
    }
  }
  return out;
}
