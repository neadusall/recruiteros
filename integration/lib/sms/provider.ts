/**
 * RecruiterOS · Texting Platform (the Money Maker)
 * SMS provider abstraction + Telnyx implementation.
 *
 * Texting is the channel candidates actually answer, so it is a first-class
 * part of the system, not a bolt-on. The engine talks to `SmsProvider`; swap
 * Telnyx for your own gateway by implementing this interface.
 *
 * Reuses the already-built Telnyx telephony setup (see the RecruiterOS phone
 * project): same account, same numbers, same messaging profile.
 */

export interface SmsSendOpts {
  from: string;          // E.164 sender number on your messaging profile
  to: string;            // E.164 recipient
  text: string;
  /** Correlate the message back to a campaign/prospect/thread. */
  ref?: { campaignId?: string; prospectId?: string; threadId?: string };
}

export interface SmsResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** Set when the rate limiter / quiet-hours gate deferred the send. */
  deferredUntil?: string;
}

export interface SmsProvider {
  send(opts: SmsSendOpts): Promise<SmsResult>;
}

/* ------------------------------------------------------------------ */
/* Telnyx implementation                                               */
/* ------------------------------------------------------------------ */

const TELNYX_API_KEY = process.env.TELNYX_API_KEY ?? "";
const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID ?? "";

export const telnyxSms: SmsProvider = {
  async send({ from, to, text }) {
    if (!TELNYX_API_KEY) return { ok: false, error: "TELNYX_API_KEY not configured" };
    try {
      const res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to,
          text,
          messaging_profile_id: MESSAGING_PROFILE_ID || undefined,
        }),
      });
      const data = await res.json().catch(() => undefined);
      if (!res.ok) {
        return { ok: false, error: `Telnyx ${res.status}: ${JSON.stringify(data?.errors ?? data)}` };
      }
      return { ok: true, providerMessageId: data?.data?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/* Internal gateway: route texting through your own built SMS tool instead. */
const INTERNAL_URL = process.env.RECRUITEROS_SMS_URL ?? "";
const INTERNAL_TOKEN = process.env.RECRUITEROS_SMS_TOKEN ?? "";

export const internalSms: SmsProvider = {
  async send(opts) {
    try {
      const res = await fetch(`${INTERNAL_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify(opts),
      });
      const data = await res.json().catch(() => undefined);
      if (!res.ok) return { ok: false, error: `internal sms ${res.status}` };
      return { ok: true, providerMessageId: data?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * RECRUITEROS_SMS_PROVIDER=internal -> your own built texting tool
 * RECRUITEROS_SMS_PROVIDER=telnyx   -> Telnyx Messaging API (default)
 */
export function getSmsProvider(): SmsProvider {
  return (process.env.RECRUITEROS_SMS_PROVIDER ?? "telnyx").toLowerCase() === "internal"
    ? internalSms
    : telnyxSms;
}
