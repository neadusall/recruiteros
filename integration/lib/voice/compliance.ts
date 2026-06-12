/**
 * RecruiterOS · Voice Drops · Time-zone compliance
 *
 * A voicemail drop is only allowed to fire inside the LEAD's own local-time
 * window. We derive the lead's timezone from their location (e.g. a Utah number
 * resolves to Mountain Time / America/Denver) and only dial when it is currently
 * inside the campaign's window there — default 7-9 PM local.
 *
 * Two layers of safety:
 *  1. The campaign window (operator-set, default 19:00-21:00).
 *  2. A HARD envelope (8 AM-9 PM local) that every window is clamped to, so a
 *     misconfigured campaign can never dial at an unlawful hour (TCPA calling
 *     hours are 8 AM-9 PM in the called party's local time).
 *
 * Timezone math uses the platform Intl database (no external dependency). States
 * that straddle zones map to their dominant zone; when a location can't be
 * resolved the lead is treated as NOT in-window (fail-closed), never dialed on a
 * guess.
 */

import type { ComplianceWindow } from "./types";

/** Hard legal envelope every window is clamped into (local hours). */
export const HARD_WINDOW: ComplianceWindow = { startHour: 8, endHour: 21 };

/**
 * US state/territory -> representative IANA timezone. Straddling states map to
 * their dominant zone (good enough for calling-hour compliance; the hard 8-9
 * envelope absorbs the edge). Both USPS abbreviations and full names are keyed.
 */
const STATE_TZ: Record<string, string> = {
  // Eastern
  ct: "America/New_York", de: "America/New_York", fl: "America/New_York",
  ga: "America/New_York", in: "America/New_York", me: "America/New_York",
  md: "America/New_York", ma: "America/New_York", mi: "America/New_York",
  nh: "America/New_York", nj: "America/New_York", ny: "America/New_York",
  nc: "America/New_York", oh: "America/New_York", pa: "America/New_York",
  ri: "America/New_York", sc: "America/New_York", vt: "America/New_York",
  va: "America/New_York", wv: "America/New_York", dc: "America/New_York",
  // Central
  al: "America/Chicago", ar: "America/Chicago", il: "America/Chicago",
  ia: "America/Chicago", ks: "America/Chicago", ky: "America/Chicago",
  la: "America/Chicago", mn: "America/Chicago", ms: "America/Chicago",
  mo: "America/Chicago", ne: "America/Chicago", nd: "America/Chicago",
  ok: "America/Chicago", sd: "America/Chicago", tn: "America/Chicago",
  tx: "America/Chicago", wi: "America/Chicago",
  // Mountain (Arizona has no DST -> Phoenix)
  co: "America/Denver", id: "America/Denver", mt: "America/Denver",
  nm: "America/Denver", ut: "America/Denver", wy: "America/Denver",
  az: "America/Phoenix",
  // Pacific
  ca: "America/Los_Angeles", nv: "America/Los_Angeles",
  or: "America/Los_Angeles", wa: "America/Los_Angeles",
  // Alaska / Hawaii / territories
  ak: "America/Anchorage", hi: "Pacific/Honolulu", pr: "America/Puerto_Rico",
};

const STATE_NAMES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi",
  wyoming: "wy", "district of columbia": "dc", "puerto rico": "pr",
};

/**
 * Resolve a lead's IANA timezone from a free-text location ("Salt Lake City, UT",
 * "Utah", "Austin, Texas"). Returns undefined when no US state can be parsed —
 * callers MUST treat undefined as "do not dial" (fail-closed).
 */
export function resolveTimezone(location?: string): string | undefined {
  const loc = (location || "").trim().toLowerCase();
  if (!loc) return undefined;

  // Full state name anywhere in the string (longest names first to avoid e.g.
  // "virginia" matching inside "west virginia").
  const names = Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (loc.includes(name)) return STATE_TZ[STATE_NAMES[name]];
  }

  // A two-letter state code as its own token ("..., ut" / "ut 84101").
  const tokens = loc.split(/[^a-z]+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.length === 2 && STATE_TZ[tok]) return STATE_TZ[tok];
  }
  return undefined;
}

/** Current local hour (0-23) at an IANA timezone. */
export function localHour(timezone: string, at: Date = new Date()): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "numeric", hour12: false,
    }).format(at);
    return parseInt(s, 10) % 24; // some platforms render midnight as "24"
  } catch {
    return -1; // unknown zone -> never in-window
  }
}

/** Clamp a campaign window into the hard legal envelope (8 AM-9 PM local). */
export function clampWindow(w: ComplianceWindow): ComplianceWindow {
  const start = Math.max(HARD_WINDOW.startHour, Math.min(w.startHour, HARD_WINDOW.endHour - 1));
  const end = Math.min(HARD_WINDOW.endHour, Math.max(w.endHour, start + 1));
  return { startHour: start, endHour: end };
}

export interface WindowCheck {
  /** True only when the lead's local time is inside the (clamped) window now. */
  allowed: boolean;
  /** Resolved timezone, or undefined when the location couldn't be parsed. */
  timezone?: string;
  /** The lead's current local hour (-1 when unknown). */
  localHour: number;
  /** Why a dial was blocked, for the audit log / UI. */
  reason?: "no_timezone" | "outside_window";
}

/**
 * Decide whether a lead may be dialed RIGHT NOW: resolve its timezone, clamp the
 * window to the legal envelope, and check the lead's current local hour against
 * it. Fail-closed: an unresolvable location is never dialed.
 */
export function checkWindow(
  location: string | undefined,
  window: ComplianceWindow,
  at: Date = new Date(),
): WindowCheck {
  const tz = resolveTimezone(location);
  if (!tz) return { allowed: false, localHour: -1, reason: "no_timezone" };

  const w = clampWindow(window);
  const h = localHour(tz, at);
  const allowed = h >= w.startHour && h < w.endHour;
  return {
    allowed,
    timezone: tz,
    localHour: h,
    reason: allowed ? undefined : "outside_window",
  };
}
