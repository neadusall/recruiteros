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

/**
 * Resolve an image/logo URL from Loxo's varied shapes. For each base name we try
 * `${base}_url`, the bare `${base}` (string), and `${base}.url` (nested object) —
 * e.g. profile_picture_url, profile_picture, profile_picture.url. Only returns
 * http(s) URLs so a stray non-URL value never renders a broken <img>.
 */
function imageUrl(o: Loxo, bases: string[]): string | undefined {
  for (const base of bases) {
    const candidates = [o[`${base}_url`], o[base], o[base] && o[base].url];
    for (const c of candidates) {
      const s = str(c);
      if (s && /^https?:\/\//i.test(s)) return s;
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
    image: imageUrl(p, ["profile_picture", "avatar", "photo", "picture", "image"]),
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
    image: imageUrl(c, ["logo", "profile_picture", "avatar", "image", "picture"]),
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

/* ============================================================
   Reverse mappers (RecruiterOS -> Loxo), for write-back.
   Kept conservative: we only send fields that map cleanly, so a
   push never blanks or corrupts data the user didn't touch.
   ============================================================ */

type RosPerson = {
  fullName?: string; firstName?: string; lastName?: string; title?: string;
  company?: string; companyDomain?: string; email?: string; email2?: string;
  phone?: string; directPhone?: string; linkedinUrl?: string;
  city?: string; state?: string; country?: string; bio?: string; compensation?: string;
};

/** RecruiterOS warehouse record -> Loxo person body. Only non-empty fields. */
export function dataRecordToLoxoPerson(r: RosPerson): Record<string, any> {
  const body: Record<string, any> = {};
  if (r.fullName) body.name = r.fullName;
  if (r.firstName) body.first_name = r.firstName;
  if (r.lastName) body.last_name = r.lastName;
  if (r.title) body.current_title = r.title;
  if (r.company) body.company_name = r.company;
  if (r.linkedinUrl) body.linkedin_url = r.linkedinUrl;
  if (r.city) body.city = r.city;
  if (r.state) body.state = r.state;
  if (r.country) body.country = r.country;
  if (r.bio) body.description = r.bio;
  if (r.compensation) body.compensation = r.compensation;
  const emails = [r.email, r.email2].filter(Boolean).map((value) => ({ value }));
  if (emails.length) body.emails = emails;
  const phones = [
    r.phone ? { value: r.phone, phone_type: "mobile" } : null,
    r.directPhone ? { value: r.directPhone, phone_type: "work" } : null,
  ].filter(Boolean);
  if (phones.length) body.phones = phones;
  return body;
}

type RosCompany = {
  name?: string; url?: string; location?: string; owner?: string; type?: string;
  raw?: Record<string, string>;
};

/** RecruiterOS company -> Loxo company body. Only non-empty fields. */
export function companyToLoxoCompany(c: RosCompany): Record<string, any> {
  const body: Record<string, any> = {};
  if (c.name) body.name = c.name;
  if (c.url) body.url = c.url;
  if (c.location) {
    // "City, ST" -> city/state best-effort; otherwise send as a single field.
    const parts = c.location.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) { body.city = parts[0]; body.state = parts[1]; }
    else body.city = c.location;
  }
  return body;
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
