/**
 * RecruitersOS · Providers · TidyCal (scheduling — bookings feed)
 * Base: https://tidycal.com/api · Auth: Bearer.
 *
 * AI Vetting uses TidyCal as a candidate source: when someone books, the booking
 * carries the role they booked for (the booking type's title -> which vetting
 * desk/number) and, via the booking's custom questions, their LinkedIn URL and
 * phone. We pull upcoming bookings and pre-research each candidate so the agent
 * is ready the moment they call.
 *
 * NOTE: a TidyCal "personal access token" (tidycal.com/integrations/oauth) is the
 * REST credential. An MCP-scoped token may be rejected by these REST endpoints —
 * verify() surfaces that cleanly. Unset = safe dry-run.
 */

import { ProviderClient } from "./http";

export class TidyCalClient extends ProviderClient {
  id = "tidycal";
  label = "TidyCal (scheduling)";
  protected envKeys = ["TIDYCAL_API_TOKEN"];
  protected baseUrl = "https://tidycal.com/api";

  protected authHeaders() {
    return { Authorization: `Bearer ${this.env("TIDYCAL_API_TOKEN")}` };
  }

  async verify() {
    try {
      await this.request({ path: "/booking-types" });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || "tidycal_error" };
    }
  }

  /**
   * List bookings, optionally bounded to a window. TidyCal paginates under
   * `data`; we pull pages until exhausted (capped) so a busy calendar still
   * returns fully. starts_at/ends_at are ISO 8601.
   */
  async listBookings(opts?: { startsAt?: string; endsAt?: string; cancelled?: boolean }): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const res: any = await this.request({
        path: "/bookings",
        query: {
          starts_at: opts?.startsAt,
          ends_at: opts?.endsAt,
          cancelled: opts?.cancelled === undefined ? undefined : String(opts.cancelled),
          page,
        },
      });
      if (res?.dryRun) return [];
      const data: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      out.push(...data);
      // Stop when there's no next page (TidyCal returns links/meta; be tolerant).
      const hasNext = res?.links?.next || (res?.meta && res.meta.current_page < res.meta.last_page);
      if (!hasNext || data.length === 0) break;
    }
    return out;
  }

  /** List the account's booking types (each has an id + title used to route). */
  async listBookingTypes(): Promise<any[]> {
    const res: any = await this.request({ path: "/booking-types" });
    if (res?.dryRun) return [];
    return Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
  }
}
