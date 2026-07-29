/**
 * RecruitersOS · Sending · business-hours send window
 *
 * Cold email that lands at 3am, or on a Saturday, is a classic filter signal and
 * reads like a machine to the recipient. The Autopilot loop holds email touches
 * outside the window; held prospects simply wait for a later tick, nothing is
 * dropped or advanced.
 *
 * Prospect-level timezones are rarely known, so the window runs on one operating
 * timezone for the workspace's audience:
 *
 *   OUTREACH_TIMEZONE            IANA zone (default APP_TIMEZONE, else America/New_York)
 *   OUTREACH_SEND_WINDOW         "8-17" (local send hours, [start, end) )
 *   OUTREACH_SEND_WINDOW_ENFORCE "0" disables the gate entirely
 */

export interface SendWindow {
  open: boolean;
  reason?: string;
}

function intOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? Math.floor(n) : fallback;
}

export function emailSendWindow(now: Date = new Date()): SendWindow {
  if ((process.env.OUTREACH_SEND_WINDOW_ENFORCE || "1") === "0") return { open: true };
  const tz = process.env.OUTREACH_TIMEZONE || process.env.APP_TIMEZONE || "America/New_York";
  let hour = now.getUTCHours();
  let dow = now.getUTCDay();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    if (Number.isFinite(h)) hour = h;
    const wd = parts.find((p) => p.type === "weekday")?.value || "";
    const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
    if (idx >= 0) dow = idx;
  } catch { /* bad zone name: UTC values stand */ }
  const [rawStart, rawEnd] = (process.env.OUTREACH_SEND_WINDOW || "8-17").split("-");
  const start = intOr(rawStart, 8);
  const end = intOr(rawEnd, 17);
  if (dow === 0 || dow === 6) return { open: false, reason: "weekend" };
  if (hour < start || hour >= end) {
    return { open: false, reason: `outside ${start}:00 to ${end}:00 ${tz}` };
  }
  return { open: true };
}
