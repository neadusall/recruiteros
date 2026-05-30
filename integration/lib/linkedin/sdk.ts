/**
 * RecruiterOS · LinkedIn Engine
 * Client SDK.
 *
 * Import this in the RecruiterOS backend to drive LinkedIn outreach without
 * hand-rolling fetch calls. It targets the REST routes in app/api/linkedin/*.
 *
 *   const li = new LinkedInClient({ baseUrl, token });
 *   await li.enroll({ prospect, sequenceId, accountId });
 *   await li.send({ accountId, prospect, action: "message", text });
 */

import type {
  ActionResult,
  Enrollment,
  LinkedInActionType,
  Prospect,
} from "./types";

export interface LinkedInClientOptions {
  baseUrl: string;            // e.g. https://app.recruiteros.co
  token: string;              // RECRUITEROS_API_TOKEN
  fetchImpl?: typeof fetch;   // inject for tests / non-browser runtimes
}

export interface EnrollInput {
  prospect: Prospect;
  sequenceId: string;
  accountId: string;
}

export interface SendInput {
  accountId: string;
  prospect: Prospect;
  action: LinkedInActionType;
  text?: string;
  subject?: string;
  audio?: string;
}

export class LinkedInClient {
  private base: string;
  private token: string;
  private f: typeof fetch;

  constructor(opts: LinkedInClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.f = opts.fetchImpl ?? fetch;
  }

  /** Start a sequence for a prospect. */
  async enroll(input: EnrollInput): Promise<{ enrollment: Enrollment }> {
    return this.post("/api/linkedin/enroll", input);
  }

  /** Fire a single action immediately (one-off or manual). */
  async send(input: SendInput): Promise<{ result: ActionResult }> {
    return this.post("/api/linkedin/actions", input);
  }

  /** Manually advance the cadence (normally a scheduler hits the cron route). */
  async tick(batch = 50, cronSecret?: string): Promise<{ processed: number }> {
    const res = await this.f(`${this.base}/api/linkedin/cron?batch=${batch}`, {
      method: "POST",
      headers: cronSecret ? { "x-cron-secret": cronSecret } : {},
    });
    return this.unwrap(res);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    return this.unwrap(res);
  }

  private async unwrap<T>(res: Response): Promise<T> {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data as any).error ?? `request_failed_${res.status}`);
      (err as any).status = res.status;
      (err as any).body = data;
      throw err;
    }
    return data as T;
  }
}
