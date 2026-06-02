/**
 * RecruiterOS · LinkedIn Engine
 * Provider abstraction + Unipile implementation.
 *
 * The rest of the engine talks to `LinkedInProvider`, never to a vendor SDK
 * directly. Swap Unipile for HeyReach / SalesRobot / a custom gateway by
 * implementing this interface and changing one line in `getProvider()`.
 *
 * Unipile is used here because it exposes a unified, account-safe LinkedIn API
 * (messaging, invitations, InMail, profile views) over a single hosted DSN.
 */

import type {
  LinkedInAccount,
  Prospect,
  ActionResult,
} from "./types";
import { backendBridgeProvider } from "./inbridge";

export interface SendConnectionOpts {
  account: LinkedInAccount;
  prospect: Prospect;
  /** Personalized invite note (<= 300 chars). Empty = note-less invite. */
  note?: string;
}

export interface SendMessageOpts {
  account: LinkedInAccount;
  prospect: Prospect;
  text: string;
}

export interface SendInMailOpts extends SendMessageOpts {
  subject: string;
}

export interface SendVoiceNoteOpts {
  account: LinkedInAccount;
  prospect: Prospect;
  /** URL or base64 of an audio clip generated upstream. */
  audio: string;
}

export interface ProviderProfile {
  providerProfileId: string;
  publicProfileUrl?: string;
  headline?: string;
  connectionDegree?: 1 | 2 | 3;
  /** True if the member is an open profile (free InMail). */
  openProfile?: boolean;
}

export interface SearchProfilesOpts {
  account: LinkedInAccount;
  /**
   * A LinkedIn / Sales Navigator / Recruiter search URL the recruiter pasted, or
   * the search parameters the provider should run. The Unipile adapter accepts the
   * raw URL straight from the address bar.
   */
  url: string;
  /** Hard cap on profiles to pull (the adapter paginates up to this). */
  limit?: number;
}

/** One person surfaced by a saved/Sales-Navigator search, before contact enrichment. */
export interface SearchProfile {
  providerProfileId: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  title?: string;
  company?: string;
  location?: string;
  publicProfileUrl?: string;
  /** Profile photo URL (from the search card), when the provider exposes it. */
  imageUrl?: string;
  connectionDegree?: 1 | 2 | 3;
}

export interface ProviderChatMessage {
  providerMessageId: string;
  fromSelf: boolean;
  text: string;
  at: string;
}

/** The contract every LinkedIn backend must satisfy. */
export interface LinkedInProvider {
  resolveProfile(account: LinkedInAccount, identifier: string): Promise<ProviderProfile>;
  /** Run a saved / Sales Navigator search URL and return the matching members. */
  searchProfiles(opts: SearchProfilesOpts): Promise<SearchProfile[]>;
  sendConnection(opts: SendConnectionOpts): Promise<ActionResult>;
  withdrawInvite(account: LinkedInAccount, providerProfileId: string): Promise<ActionResult>;
  sendMessage(opts: SendMessageOpts): Promise<ActionResult>;
  sendInMail(opts: SendInMailOpts): Promise<ActionResult>;
  sendVoiceNote(opts: SendVoiceNoteOpts): Promise<ActionResult>;
  viewProfile(account: LinkedInAccount, providerProfileId: string): Promise<ActionResult>;
  endorseTopSkills(account: LinkedInAccount, providerProfileId: string, count?: number): Promise<ActionResult>;
  listMessages(account: LinkedInAccount, providerProfileId: string): Promise<ProviderChatMessage[]>;
  getAccountStatus(account: LinkedInAccount): Promise<LinkedInAccount["status"]>;
}

/* ------------------------------------------------------------------ */
/* Unipile implementation                                              */
/* ------------------------------------------------------------------ */

const DSN = process.env.UNIPILE_DSN ?? "";          // e.g. "api8.unipile.com:13456"
const API_KEY = process.env.UNIPILE_API_KEY ?? "";

class UnipileError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "UnipileError";
  }
}

async function unipile<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!DSN || !API_KEY) {
    throw new UnipileError("UNIPILE_DSN / UNIPILE_API_KEY are not configured", 500);
  }
  const res = await fetch(`https://${DSN}/api/v1${path}`, {
    ...init,
    headers: {
      "X-API-KEY": API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new UnipileError(
      `Unipile ${init.method ?? "GET"} ${path} failed: ${res.status}`,
      res.status,
      body,
    );
  }
  return body as T;
}

/** Wrap a provider call so transport errors become a clean ActionResult. */
async function attempt(
  action: ActionResult["action"],
  fn: () => Promise<{ providerMessageId?: string }>,
): Promise<ActionResult> {
  try {
    const out = await fn();
    return { ok: true, action, providerMessageId: out.providerMessageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, action, error: message };
  }
}

export const unipileProvider: LinkedInProvider = {
  async resolveProfile(account, identifier) {
    const data = await unipile<{
      provider_id: string;
      public_identifier?: string;
      headline?: string;
      network_distance?: string;
      is_open_profile?: boolean;
    }>(`/users/${encodeURIComponent(identifier)}?account_id=${account.providerAccountId}`);
    const degreeMap: Record<string, 1 | 2 | 3> = { DISTANCE_1: 1, DISTANCE_2: 2, DISTANCE_3: 3 };
    return {
      providerProfileId: data.provider_id,
      publicProfileUrl: data.public_identifier
        ? `https://www.linkedin.com/in/${data.public_identifier}`
        : undefined,
      headline: data.headline,
      connectionDegree: data.network_distance ? degreeMap[data.network_distance] : undefined,
      openProfile: data.is_open_profile,
    };
  },

  async searchProfiles({ account, url, limit = 100 }) {
    const cap = Math.min(Math.max(limit, 1), 500);
    const degreeMap: Record<string, 1 | 2 | 3> = { DISTANCE_1: 1, DISTANCE_2: 2, DISTANCE_3: 3 };
    const out: SearchProfile[] = [];
    let cursor: string | undefined;

    // Unipile resolves a pasted classic / Sales Navigator / Recruiter search URL and
    // pages through the results. We pull until we hit the cap or run out of pages.
    do {
      const qs = new URLSearchParams({ account_id: account.providerAccountId });
      if (cursor) qs.set("cursor", cursor);
      const data = await unipile<{
        items?: Array<Record<string, any>>;
        cursor?: string | null;
      }>(`/linkedin/search?${qs.toString()}`, {
        method: "POST",
        body: JSON.stringify({ url, limit: Math.min(cap - out.length, 100) }),
      });

      for (const it of data.items ?? []) {
        const first = it.first_name ?? it.firstName;
        const last = it.last_name ?? it.lastName;
        const fullName =
          it.name ?? it.full_name ?? [first, last].filter(Boolean).join(" ").trim();
        if (!fullName) continue;
        const publicId = it.public_identifier ?? it.public_id;
        const company =
          it.current_company ?? it.company ?? it.company_name ?? it.organization;
        out.push({
          providerProfileId: it.provider_id ?? it.id ?? it.member_id ?? publicId,
          fullName,
          firstName: first,
          lastName: last,
          headline: it.headline,
          title: it.title ?? it.current_position ?? it.position,
          company: typeof company === "string" ? company : company?.name,
          location: typeof it.location === "string" ? it.location : it.location?.name,
          publicProfileUrl:
            it.profile_url ??
            (publicId ? `https://www.linkedin.com/in/${publicId}` : undefined),
          imageUrl: it.profile_picture_url ?? it.profile_picture ?? it.picture_url ?? it.image_url,
          connectionDegree: it.network_distance ? degreeMap[it.network_distance] : undefined,
        });
        if (out.length >= cap) break;
      }

      cursor = data.cursor ?? undefined;
    } while (cursor && out.length < cap);

    return out;
  },

  sendConnection({ account, prospect, note }) {
    return attempt("connect", async () => {
      const out = await unipile<{ invitation_id?: string }>("/users/invite", {
        method: "POST",
        body: JSON.stringify({
          account_id: account.providerAccountId,
          provider_id: prospect.providerProfileId,
          message: note?.slice(0, 300) || undefined,
        }),
      });
      return { providerMessageId: out.invitation_id };
    });
  },

  withdrawInvite(account, providerProfileId) {
    return attempt("withdraw_invite", async () => {
      await unipile("/users/invite/cancel", {
        method: "POST",
        body: JSON.stringify({
          account_id: account.providerAccountId,
          provider_id: providerProfileId,
        }),
      });
      return {};
    });
  },

  sendMessage({ account, prospect, text }) {
    return attempt("message", async () => {
      const out = await unipile<{ message_id?: string }>("/chats", {
        method: "POST",
        body: JSON.stringify({
          account_id: account.providerAccountId,
          attendees_ids: [prospect.providerProfileId],
          text,
        }),
      });
      return { providerMessageId: out.message_id };
    });
  },

  sendInMail({ account, prospect, text, subject }) {
    return attempt("inmail", async () => {
      const out = await unipile<{ message_id?: string }>("/chats", {
        method: "POST",
        body: JSON.stringify({
          account_id: account.providerAccountId,
          attendees_ids: [prospect.providerProfileId],
          inmail: true,
          subject,
          text,
        }),
      });
      return { providerMessageId: out.message_id };
    });
  },

  sendVoiceNote({ account, prospect, audio }) {
    return attempt("voice_note", async () => {
      const out = await unipile<{ message_id?: string }>("/chats", {
        method: "POST",
        body: JSON.stringify({
          account_id: account.providerAccountId,
          attendees_ids: [prospect.providerProfileId],
          voice_message: audio,
        }),
      });
      return { providerMessageId: out.message_id };
    });
  },

  viewProfile(account, providerProfileId) {
    return attempt("profile_view", async () => {
      await unipile(`/users/${providerProfileId}/view`, {
        method: "POST",
        body: JSON.stringify({ account_id: account.providerAccountId }),
      });
      return {};
    });
  },

  endorseTopSkills(account, providerProfileId, count = 3) {
    return attempt("endorse", async () => {
      await unipile(`/users/${providerProfileId}/endorse`, {
        method: "POST",
        body: JSON.stringify({ account_id: account.providerAccountId, count }),
      });
      return {};
    });
  },

  async listMessages(account, providerProfileId) {
    const data = await unipile<{ items: Array<{ id: string; is_sender: boolean; text: string; timestamp: string }> }>(
      `/chats/messages?account_id=${account.providerAccountId}&attendee_id=${providerProfileId}`,
    );
    return (data.items ?? []).map((m) => ({
      providerMessageId: m.id,
      fromSelf: m.is_sender,
      text: m.text,
      at: m.timestamp,
    }));
  },

  async getAccountStatus(account) {
    const data = await unipile<{ status?: string }>(`/accounts/${account.providerAccountId}`);
    const map: Record<string, LinkedInAccount["status"]> = {
      OK: "ok",
      CONNECTING: "warming",
      CREDENTIALS: "disconnected",
      ERROR: "restricted",
    };
    return map[data.status ?? "OK"] ?? "ok";
  },
};

/* ------------------------------------------------------------------ */
/* Internal RecruiterOS provider                                       */
/*                                                                     */
/* Use this when outreach runs through your OWN internal LinkedIn tools */
/* rather than a third party. Point RECRUITEROS_OUTREACH_URL at your    */
/* internal service; this adapter speaks the same interface, so the     */
/* sequence engine, rate limiter, and AI layer all work unchanged.      */
/* ------------------------------------------------------------------ */

const INTERNAL_URL = process.env.RECRUITEROS_OUTREACH_URL ?? "";
const INTERNAL_TOKEN = process.env.RECRUITEROS_OUTREACH_TOKEN ?? "";

async function internal<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${INTERNAL_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INTERNAL_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`internal outreach ${path} failed: ${res.status}`);
  return data as T;
}

export const internalProvider: LinkedInProvider = {
  async resolveProfile(account, identifier) {
    return internal("/resolve", { account: account.providerAccountId, identifier });
  },
  async searchProfiles({ account, url, limit = 100 }) {
    const data = await internal<{ items?: SearchProfile[] }>("/search", {
      account: account.providerAccountId,
      url,
      limit,
    });
    return (data.items ?? []).slice(0, limit);
  },
  sendConnection({ account, prospect, note }) {
    return attempt("connect", () => internal("/connect", { account: account.providerAccountId, prospect, note }));
  },
  withdrawInvite(account, providerProfileId) {
    return attempt("withdraw_invite", () => internal("/withdraw", { account: account.providerAccountId, providerProfileId }));
  },
  sendMessage({ account, prospect, text }) {
    return attempt("message", () => internal("/message", { account: account.providerAccountId, prospect, text }));
  },
  sendInMail({ account, prospect, text, subject }) {
    return attempt("inmail", () => internal("/inmail", { account: account.providerAccountId, prospect, text, subject }));
  },
  sendVoiceNote({ account, prospect, audio }) {
    return attempt("voice_note", () => internal("/voice", { account: account.providerAccountId, prospect, audio }));
  },
  viewProfile(account, providerProfileId) {
    return attempt("profile_view", () => internal("/view", { account: account.providerAccountId, providerProfileId }));
  },
  endorseTopSkills(account, providerProfileId, count = 3) {
    return attempt("endorse", () => internal("/endorse", { account: account.providerAccountId, providerProfileId, count }));
  },
  async listMessages(account, providerProfileId) {
    return internal("/messages", { account: account.providerAccountId, providerProfileId });
  },
  async getAccountStatus() {
    return "ok";
  },
};

/**
 * Single place to choose the backend.
 *
 * RECRUITEROS_OUTREACH_PROVIDER=self      -> our own in-backend bridge: the work
 *                                            runs in the user's browser via the
 *                                            Chrome extension, coordinated here
 *                                            and persisted in the DB. No external
 *                                            API, no separate process. (DEFAULT)
 * RECRUITEROS_OUTREACH_PROVIDER=internal  -> a separate self-hosted bridge service
 * RECRUITEROS_OUTREACH_PROVIDER=unipile   -> the Unipile API (third party)
 *
 * The whole engine is provider-agnostic, so swapping backends touches nothing else.
 */
export function getProvider(): LinkedInProvider {
  switch ((process.env.RECRUITEROS_OUTREACH_PROVIDER ?? "self").toLowerCase()) {
    case "unipile":
      return unipileProvider;
    case "internal":
      return internalProvider;
    case "self":
    default:
      return backendBridgeProvider;
  }
}
