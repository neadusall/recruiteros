/**
 * RecruiterOS · Providers · RapidAPI JSearch (job scraper)
 * Base: https://jsearch.p.rapidapi.com · Auth: X-RapidAPI-Key + Host.
 * Used for: the daily signal pull / "role they're hiring for" enrichment.
 */

import { ProviderClient } from "./http";

export class RapidApiClient extends ProviderClient {
  id = "rapidapi";
  label = "RapidAPI (job scraper)";
  protected envKeys = ["RAPIDAPI_KEY"];
  protected baseUrl = "https://jsearch.p.rapidapi.com";

  protected authHeaders() {
    return {
      "X-RapidAPI-Key": this.env("RAPIDAPI_KEY"),
      "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
    };
  }

  async verify() {
    try {
      await this.request({ path: "/search", query: { query: "engineer", page: 1, num_pages: 1 } });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  /** Search job postings (company, role, posting date, JD text). */
  searchJobs(query: string, page = 1) {
    return this.request({ path: "/search", query: { query, page, num_pages: 1, date_posted: "week" } });
  }
}
