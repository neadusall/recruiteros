/**
 * RecruiterOS · Providers · Tomba (email lookup)
 * Base: https://api.tomba.io/v1 · Auth: X-Tomba-Key + X-Tomba-Secret.
 * Second rung of the enrichment waterfall: corporate email from name + domain.
 */

import { ProviderClient } from "./http";

export class TombaClient extends ProviderClient {
  id = "tomba";
  label = "Tomba (email lookup)";
  protected envKeys = ["TOMBA_API_KEY", "TOMBA_SECRET"];
  protected baseUrl = "https://api.tomba.io/v1";

  protected authHeaders() {
    return { "X-Tomba-Key": this.env("TOMBA_API_KEY"), "X-Tomba-Secret": this.env("TOMBA_SECRET") };
  }

  async verify() {
    try {
      await this.request({ path: "/me" });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  /** Find an email from full name + company domain. */
  emailFinder(domain: string, firstName: string, lastName: string) {
    return this.request({ path: "/email-finder", query: { domain, first_name: firstName, last_name: lastName } });
  }

  /** Company email pattern + known addresses for a domain. */
  domainSearch(domain: string) {
    return this.request({ path: `/domain-search`, query: { domain } });
  }
}
