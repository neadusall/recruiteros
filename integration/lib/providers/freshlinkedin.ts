/**
 * RecruitersOS · Providers · Fresh LinkedIn Profile Data (enrichment)
 * Base: https://fresh-linkedin-profile-data.p.rapidapi.com · Auth: X-RapidAPI-Key.
 * First rung of the enrichment waterfall: title, company, seniority, recent moves.
 */

import { ProviderClient } from "./http";

export class FreshLinkedInClient extends ProviderClient {
  id = "fresh_linkedin";
  label = "Fresh LinkedIn (enrich)";
  protected envKeys = ["FRESH_LINKEDIN_API_KEY"];
  protected baseUrl = "https://fresh-linkedin-profile-data.p.rapidapi.com";

  protected authHeaders() {
    return {
      "X-RapidAPI-Key": this.env("FRESH_LINKEDIN_API_KEY"),
      "X-RapidAPI-Host": "fresh-linkedin-profile-data.p.rapidapi.com",
    };
  }

  async verify() {
    return { ok: this.configured(), error: this.configured() ? undefined : "not_configured" };
  }

  /** Resolve a profile by its public LinkedIn URL. */
  getProfile(linkedinUrl: string) {
    return this.request({ path: "/get-linkedin-profile", query: { linkedin_url: linkedinUrl, include_skills: false } });
  }
}
