/**
 * RecruitersOS · Sending · media-host alignment
 *
 * Cold email leaves from a fleet of lookalike sending domains, but the video thumbnail and
 * watch link historically pointed at the app origin (recruitersos.co) on every send. Two
 * problems with that: mailbox providers score a From-domain vs link-domain mismatch, and one
 * shared click domain concentrates risk — a single URL blocklisting would flag mail from the
 * ENTIRE fleet at once, and it would be the app's own domain that burns.
 *
 * This rewrites the VIDEO URLS ONLY (watch page, in-market asset streams, short links) in an
 * outgoing email so they ride the SENDING inbox's own domain:
 *
 *   OUTREACH_MEDIA_HOST_PATTERN="vid.{domain}"   -> mail from ryan@talsearches.com links to
 *                                                   https://vid.talsearches.com/watch?...
 *
 * OFF by default (env unset). Turning it on requires infra the app can't create itself:
 *   1. DNS: a CNAME per fleet domain, vid.<domain> -> the app host.
 *   2. Reverse proxy: Caddy must accept those hosts (on_demand_tls) and route them to the app.
 * Until both exist, leave the env unset — a rewrite to a dead host would break every video
 * click. The unsubscribe link and footer are deliberately NOT rewritten: compliance links stay
 * on the canonical app origin, which is exactly the split a legitimate sender shows.
 */

export interface MediaPayload { html: string; text: string; }

const REWRITE_PATHS = ["/watch", "/api/in-market/", "/v/"];

function appOrigins(): string[] {
  const raw = process.env.RECRUITEROS_APP_URL || "https://recruitersos.co";
  try {
    const u = new URL(raw);
    return [`${u.protocol}//${u.host}`];
  } catch {
    return ["https://recruitersos.co"];
  }
}

/** The target media host for a sending address, or null when alignment is off/not applicable. */
export function mediaHostFor(inboxEmail: string): string | null {
  const pattern = (process.env.OUTREACH_MEDIA_HOST_PATTERN || "").trim();
  if (!pattern || !pattern.includes("{domain}")) return null;
  const domain = (inboxEmail.split("@")[1] || "").trim().toLowerCase();
  if (!domain) return null;
  return pattern.replace("{domain}", domain);
}

/**
 * Rewrite app-origin VIDEO links in an email body to the sending domain's media host.
 * Only paths in REWRITE_PATHS move; everything else (unsubscribe, app links) stays put.
 * Pure string transform, safe on both HTML and plain text; a no-op when disabled.
 */
export function alignMediaHost(payload: MediaPayload, inboxEmail: string): MediaPayload {
  const host = mediaHostFor(inboxEmail);
  if (!host) return payload;
  const swap = (s: string): string => {
    let out = s;
    for (const origin of appOrigins()) {
      for (const path of REWRITE_PATHS) {
        out = out.split(`${origin}${path}`).join(`https://${host}${path}`);
      }
    }
    return out;
  };
  return { html: swap(payload.html), text: swap(payload.text) };
}
