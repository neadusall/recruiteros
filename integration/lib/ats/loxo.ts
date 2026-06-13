/**
 * RecruitersOS · ATS
 * Loxo adapter (the verified, primary integration).
 *
 * Object mapping (RecruitersOS -> Loxo), straight from the reference ATS tab:
 *   BD prospect        -> Person + list "BD Prospects"   POST /people/update_by_email
 *   Target company     -> Company (dynamic: icp_match, active_signals, signal_score)
 *   BD opportunity     -> Deal (one per pitch; -> Job when signed)
 *   Candidate          -> Person + list "Candidates" (tag source=outbound)
 *   Candidate->mandate -> POST /jobs/{id}/apply
 *   Any touch          -> person_event   POST /people/{id}/person_events
 *   Mandate            -> Job   Placement -> Placement (triggers billing)
 *
 * Base: api.loxo.co  ·  Auth: Bearer + agency slug.
 * The reference build logs calls; flip `LOXO_API_KEY` on to go live.
 */

import type { AtsAdapter, AtsPersonEvent } from "./types";

const BASE = "https://api.loxo.co/api";

export class LoxoAdapter implements AtsAdapter {
  vendor = "loxo" as const;
  private slug: string;
  private key?: string;
  private live: boolean;

  constructor(opts?: { slug?: string; apiKey?: string }) {
    this.slug = opts?.slug ?? process.env.LOXO_AGENCY_SLUG ?? "demo-agency";
    this.key = opts?.apiKey ?? process.env.LOXO_API_KEY;
    this.live = Boolean(this.key);
  }

  async upsertPersonByEmail(email: string, fields: Record<string, unknown>): Promise<string> {
    const body = { email, ...fields };
    const res = await this.call("POST", `/${this.slug}/people/update_by_email`, body);
    return String(res?.id ?? `loxo_person_${hash(email)}`);
  }

  async pushPersonEvent(ev: AtsPersonEvent): Promise<string> {
    const res = await this.call("POST", `/${this.slug}/people/${ev.personRef}/person_events`, {
      activity_type: ev.activityType,
      notes: `[${ev.channel}] ${ev.note}`,
      created_at: ev.at,
    });
    return String(res?.id ?? `loxo_event_${hash(ev.personRef + ev.at)}`);
  }

  async tagPerson(personRef: string, tag: string): Promise<void> {
    await this.call("POST", `/${this.slug}/people/${personRef}/tags`, { tag });
  }

  async advanceDeal(personRef: string, stage: string): Promise<void> {
    await this.call("PATCH", `/${this.slug}/deals/by_person/${personRef}`, { stage });
  }

  async addDoNotContact(personRef: string): Promise<void> {
    await this.call("POST", `/${this.slug}/people/${personRef}/tags`, { tag: "do-not-contact" });
  }

  private async call(method: string, path: string, body: unknown): Promise<any> {
    if (!this.live) {
      console.info(`[loxo:dry] ${method} ${path}`, body);
      return {};
    }
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`loxo_${res.status}`);
    return res.json().catch(() => ({}));
  }
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
