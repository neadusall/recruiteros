/**
 * RecruitersOS · ZoomInfo provider (official API adapter)
 *
 * This is the DROP-IN for when the official ZoomInfo Enterprise API key arrives.
 * It is dormant until both env vars are set:
 *   ZOOMINFO_API_KEY   — the licensed API key
 *   ZOOMINFO_API_BASE  — base URL (defaults to the documented Enterprise host)
 *
 * Until then `configured()` returns false and the Data tab steers the user to
 * CSV import (the licensed portal export). When the key lands, fill in the two
 * marked sections with the real request/response mapping from ZoomInfo's API
 * docs — no other file needs to change; the warehouse, UI, and enrichment all
 * consume the normalized DataRecordInput this returns.
 *
 * IMPORTANT: this adapter only ever talks to the OFFICIAL, contracted API. It
 * does not and must not drive the portal's internal/private endpoints.
 */

import type { DataProvider, ProviderSearchQuery } from "./types";
import { ProviderNotConfigured } from "./types";
import type { DataRecordInput } from "../types";

const DEFAULT_BASE = "https://api.zoominfo.com";

function apiKey(): string | null {
  return process.env.ZOOMINFO_API_KEY || null;
}
function apiBase(): string {
  return process.env.ZOOMINFO_API_BASE || DEFAULT_BASE;
}

/**
 * Map one provider record to our normalized shape. Kept separate so it's the
 * single place to adjust when the real field names are confirmed from the docs.
 */
function normalize(row: Record<string, unknown>): DataRecordInput {
  const s = (k: string): string | undefined => {
    const v = row[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const first = s("firstName");
  const last = s("lastName");
  return {
    fullName: s("fullName") || [first, last].filter(Boolean).join(" ") || "(unknown)",
    firstName: first,
    lastName: last,
    title: s("jobTitle") || s("title"),
    company: s("companyName") || s("company"),
    companyDomain: s("companyDomain") || s("website"),
    companyId: s("companyId"),
    email: s("email"),
    phone: s("mobilePhone") || s("phone"),
    directPhone: s("directPhone"),
    companyPhone: s("companyPhone"),
    linkedinUrl: s("linkedInUrl") || s("linkedinUrl"),
    city: s("city"),
    state: s("state"),
    country: s("country"),
    industry: s("industry"),
    source: "zoominfo-api",
    providerId: s("id") || s("personId"),
    raw: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v ?? "")])),
  };
}

export const zoomInfoProvider: DataProvider = {
  id: "zoominfo",
  label: "ZoomInfo (official API)",

  configured(): boolean {
    return !!apiKey();
  },

  async search(query: ProviderSearchQuery): Promise<DataRecordInput[]> {
    const key = apiKey();
    if (!key) {
      throw new ProviderNotConfigured(
        "zoominfo",
        "ZoomInfo API key not set. Use CSV import from the portal export until the official key is configured (ZOOMINFO_API_KEY).",
      );
    }

    // ── REAL CALL (fill in from the official API docs when the key lands) ──────
    // The official Enterprise API authenticates and exposes a person search
    // endpoint. Shape the request from `query`, POST it, and read the result
    // rows. Left as a guarded call so the seam is obvious and typed.
    const res = await fetch(apiBase() + "/search/person", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // map our generic query → provider params here
        query: query.q,
        jobTitle: query.title,
        companyName: query.company,
        companyDomain: query.companyDomain,
        location: query.location,
        rpp: Math.min(query.limit ?? 50, 100),
      }),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`zoominfo_api_error_${res.status}`), { status: res.status });
    }
    const json = (await res.json()) as { data?: Record<string, unknown>[]; result?: Record<string, unknown>[] };
    const rows = json.data || json.result || [];
    // ──────────────────────────────────────────────────────────────────────────

    return rows.map(normalize);
  },
};
