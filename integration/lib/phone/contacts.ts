/**
 * RecruitersOS · Phone · Contact recognition
 *
 * Resolve a phone number to the workspace's people: inbound caller ID and
 * outbound dialed numbers are matched against every prospect phone field
 * (primary / mobile / landline) on the last 10 digits, so formatting and
 * +1 prefixes never break a match. Companies resolve through the matched
 * prospect's company name/domain.
 */

import { getCore } from "../core/repository";
import { listCompanies } from "../companies/store";
import type { Prospect } from "../core/types";
import { last10 } from "./store";

export interface ContactMatch {
  prospectId: string;
  name: string;
  title?: string;
  company?: string;
  companyId?: string;
  phoneField: "phone" | "mobilePhone" | "landlinePhone";
}

/** All prospects whose any-phone matches the number (may be several). */
export async function matchByPhone(
  workspaceId: string, number: string,
): Promise<ContactMatch[]> {
  const key = last10(number);
  if (key.length < 7) return [];
  const prospects = await getCore().listProspects(workspaceId);
  const out: ContactMatch[] = [];
  for (const p of prospects) {
    const field = matchField(p, key);
    if (!field) continue;
    out.push({
      prospectId: p.id,
      name: p.fullName || p.firstName || "Unknown",
      title: p.title,
      company: p.company,
      phoneField: field,
    });
    if (out.length >= 8) break;
  }
  // Resolve company ids for the matches that have a company name.
  await attachCompanyIds(workspaceId, out);
  return out;
}

function matchField(p: Prospect, key: string): ContactMatch["phoneField"] | null {
  if (p.phone && last10(p.phone) === key) return "phone";
  if (p.mobilePhone && last10(p.mobilePhone) === key) return "mobilePhone";
  if (p.landlinePhone && last10(p.landlinePhone) === key) return "landlinePhone";
  return null;
}

async function attachCompanyIds(workspaceId: string, matches: ContactMatch[]): Promise<void> {
  const names = [...new Set(matches.map((m) => m.company).filter(Boolean))] as string[];
  if (!names.length) return;
  try {
    const { companies } = await listCompanies(workspaceId, { limit: 2000 });
    const byName = new Map(companies.map((c) => [c.name.trim().toLowerCase(), c.id]));
    for (const m of matches) {
      if (m.company) m.companyId = byName.get(m.company.trim().toLowerCase());
    }
  } catch {
    // Company resolution is best-effort; the call still records the name.
  }
}

/** Typeahead over prospects for "associate call with an existing contact". */
export async function searchContacts(
  workspaceId: string, q: string, limit = 12,
): Promise<Array<{ prospectId: string; name: string; title?: string; company?: string; phone?: string }>> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const prospects = await getCore().listProspects(workspaceId);
  return prospects
    .filter((p) => {
      const hay = [p.fullName, p.firstName, p.company, p.title, p.email]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(needle);
    })
    .slice(0, limit)
    .map((p) => ({
      prospectId: p.id,
      name: p.fullName || p.firstName || "Unknown",
      title: p.title,
      company: p.company,
      phone: p.phone || p.mobilePhone || p.landlinePhone,
    }));
}
