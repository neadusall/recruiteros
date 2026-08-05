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
 *   OUTREACH_HOLIDAYS            extra "YYYY-MM-DD,YYYY-MM-DD" dates to hold on
 *
 * Major US holidays are held by default (cold email on Christmas morning reads
 * exactly how it sounds; the Anevo study paused Dec 24-25 + Dec 31-Jan 2).
 */

export interface SendWindow {
  open: boolean;
  reason?: string;
}

function intOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? Math.floor(n) : fallback;
}

/** Fixed-date US holidays (MM-DD) held every year. */
const FIXED_HOLIDAYS = new Set(["01-01", "07-04", "11-11", "12-24", "12-25", "12-31"]);

/** Floating US holidays for a given local date: Memorial Day (last Mon of May),
 *  Labor Day (1st Mon of Sep), Thanksgiving (4th Thu of Nov) + the Friday after. */
function isFloatingHoliday(y: number, m: number, d: number): boolean {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (m === 5 && dow === 1 && d >= 25) return true;                 // Memorial Day
  if (m === 9 && dow === 1 && d <= 7) return true;                  // Labor Day
  if (m === 11 && dow === 4 && d >= 22 && d <= 28) return true;     // Thanksgiving
  if (m === 11 && dow === 5 && d >= 23 && d <= 29) return true;     // day after
  return false;
}

function isHoliday(localDate: string): boolean {
  const [y, m, d] = localDate.split("-").map(Number);
  if (!y || !m || !d) return false;
  if (FIXED_HOLIDAYS.has(localDate.slice(5))) return true;
  if (isFloatingHoliday(y, m, d)) return true;
  const extra = (process.env.OUTREACH_HOLIDAYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(localDate);
}

export function emailSendWindow(now: Date = new Date()): SendWindow {
  if ((process.env.OUTREACH_SEND_WINDOW_ENFORCE || "1") === "0") return { open: true };
  const tz = process.env.OUTREACH_TIMEZONE || process.env.APP_TIMEZONE || "America/New_York";
  let hour = now.getUTCHours();
  let dow = now.getUTCDay();
  let localDate = now.toISOString().slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    if (Number.isFinite(h)) hour = h;
    const wd = parts.find((p) => p.type === "weekday")?.value || "";
    const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
    if (idx >= 0) dow = idx;
    const y = parts.find((p) => p.type === "year")?.value;
    const mo = parts.find((p) => p.type === "month")?.value;
    const da = parts.find((p) => p.type === "day")?.value;
    if (y && mo && da) localDate = `${y}-${mo}-${da}`;
  } catch { /* bad zone name: UTC values stand */ }
  const [rawStart, rawEnd] = (process.env.OUTREACH_SEND_WINDOW || "8-17").split("-");
  const start = intOr(rawStart, 8);
  const end = intOr(rawEnd, 17);
  if (dow === 0 || dow === 6) return { open: false, reason: "weekend" };
  if (isHoliday(localDate)) return { open: false, reason: `holiday ${localDate}` };
  if (hour < start || hour >= end) {
    return { open: false, reason: `outside ${start}:00 to ${end}:00 ${tz}` };
  }
  return { open: true };
}
