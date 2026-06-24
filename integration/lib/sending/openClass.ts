/**
 * RecruitersOS · Open classification (right-tracking)
 *
 * Email open "events" lie unless you filter them. A pixel load can come from a
 * human reading the mail, OR from a machine that never had eyes on it:
 *   - Apple Mail Privacy Protection (MPP) pre-fetches every image from Apple's
 *     relay (IP block 17.0.0.0/8) the moment mail arrives — inflating opens.
 *   - Gmail / Yahoo image proxies fetch+cache images server-side.
 *   - Link scanners (Proofpoint, Mimecast, Barracuda…) and bots pre-open.
 *
 * We treat those as MACHINE opens and keep them out of the human open count, so
 * the engagement signal reflects real readers. A LINK CLICK
 * (MessageLinkClicked) is always counted as human — MPP/proxies don't click.
 */

const MACHINE_UA =
  /GoogleImageProxy|YahooMailProxy|Mail\.ru|\bbot\b|spider|crawler|preview|Slackbot|facebookexternalhit|curl|wget|python-requests|HeadlessChrome|monitoring|Barracuda|Proofpoint|Mimecast|SkypeUriPreview|Microsoft Office/i;

/** Apple Mail Privacy Protection relay lives in Apple's 17.0.0.0/8 block. */
function isAppleMppIp(ip?: string): boolean {
  if (!ip) return false;
  const v4 = ip.trim().replace(/^::ffff:/i, "");
  return /^17\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export interface OpenSignal {
  /** Raw Postal event name, e.g. "MessageLoaded" | "MessageLinkClicked". */
  eventName?: string;
  userAgent?: string;
  ip?: string;
}

/** True if this open should be treated as a machine/proxy open (not a human). */
export function isMachineOpen(sig: OpenSignal): boolean {
  // A click is a deliberate human action; never machine.
  if (sig.eventName === "MessageLinkClicked") return false;
  if (sig.userAgent && MACHINE_UA.test(sig.userAgent)) return true;
  if (isAppleMppIp(sig.ip)) return true;
  return false;
}
