/**
 * RecruitersOS · In-Market · Built-in booking calendar
 *
 * The native replacement for the third-party booking embed (Calendly / TidyCal)
 * on the video watch page. When a workspace turns it on in the PiP Studio Brand
 * tab, the watch page's calendar column becomes OUR /book page: the prospect
 * picks an open slot inside the workspace's business hours (default 9am-5pm
 * Mountain, Monday to Friday), and both sides get a real calendar invite by
 * email (ICS METHOD:REQUEST) sent from the workspace's own brand mailbox, so
 * the meeting lands straight on the operator's calendar. No external booking
 * vendor, no extra account.
 *
 * Bookings persist in the Postgres snapshot KV (same convention as
 * videoSettings) and double-booking is prevented by re-validating the slot
 * inside a per-workspace serialized section before it is stored.
 *
 * The public /book link is capability-style: /book?w=<workspaceId>&sig=<hmac>.
 * The sig is an HMAC of the workspace id under the server secret (same secret
 * convention as lib/inmarket/shareSign), so the booking API can trust the link
 * without a session while a guessed workspace id stays useless.
 */

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { loadSnapshot, debouncedSaver } from "../db";
import type { VideoSettings } from "./videoSettings";

/* ----------------------------- storage ----------------------------- */

const KEY = "inmarket_bookings_v1";

export interface BookingReminder {
  kind: "confirm" | "day" | "hour";
  /** When to send (ISO). */
  at: string;
  sentAt?: string;
  error?: string;
}

export interface Booking {
  id: string;
  /** UTC instants (ISO). */
  start: string;
  end: string;
  name: string;
  email: string;
  note?: string;
  /** E.164 cell, present only when the guest asked for text reminders. */
  phone?: string;
  /** Planned reminder texts; the minute tick stamps sentAt / error. */
  reminders?: BookingReminder[];
  /** Video-call join link carried in the invite and both confirmation emails. */
  meetingUrl?: string;
  createdAt: string;
  organizerEmailed: boolean;
  guestEmailed: boolean;
}

/** Loose-input phone -> E.164 (US default for bare 10-digit numbers). */
export function normalizePhone(raw: string): string | null {
  const t = String(raw || "").trim();
  if (!t) return null;
  if (t.startsWith("+")) {
    const p = "+" + t.slice(1).replace(/\D/g, "");
    return /^\+\d{8,15}$/.test(p) ? p : null;
  }
  const digits = t.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

/**
 * A unique, no-account video room for one booking. Rooms exist the moment
 * someone opens the link (both sides just click to join in the browser), so
 * there is nothing to provision and no vendor account to hold. A workspace
 * that prefers its own room (Teams/Zoom/Meet) sets bookingMeetingUrl instead.
 */
export function meetRoomName(brandName: string, bookingId: string): string {
  const slug = (brandName || "").replace(/[^a-zA-Z0-9]+/g, "").slice(0, 24) || "RecruitersOS";
  return `${slug}Call-${bookingId.slice(0, 8)}`;
}

/* ------------------- branded meet server (self-hosted Jitsi) ------------------- */
/* When RECRUITEROS_MEET_BASE + RECRUITEROS_MEET_JWT_SECRET are set AND the
   workspace's own portal shares the meet server's root domain, rooms are minted
   on OUR server with a signed join token (the server rejects tokenless
   visitors, so the public hostname can't be used to host free calls). The
   instance carries ONE brand's look, so workspaces on another brand's portal
   keep the neutral meet.jit.si default. */

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Compact HS256 JWT in the shape Jitsi's token auth expects. */
function meetJwt(room: string, appId: string, secret: string, expSec: number): string {
  const enc = (o: object) => b64url(Buffer.from(JSON.stringify(o)));
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ aud: "jitsi", iss: appId, sub: "*", room, nbf: Math.floor(Date.now() / 1000) - 300, exp: expSec });
  const sig = b64url(createHmac("sha256", secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

const rootDomain = (host: string) => host.split(".").slice(-2).join(".");

async function brandedMeetingUrl(workspaceId: string, room: string, startIso: string): Promise<string | null> {
  const base = (process.env.RECRUITEROS_MEET_BASE || "").trim().replace(/\/+$/, "");
  const secret = (process.env.RECRUITEROS_MEET_JWT_SECRET || "").trim();
  if (!base || !secret) return null;
  try {
    const { notifyBrand } = await import("../outbound/brand");
    const appHost = new URL((await notifyBrand(workspaceId)).appUrl).hostname;
    if (rootDomain(new URL(base).hostname) !== rootDomain(appHost)) return null;
    // Valid from now (links are emailed at booking time) until 24h past the call start.
    const exp = Math.floor(Date.parse(startIso) / 1000) + 24 * 3600;
    const appId = (process.env.RECRUITEROS_MEET_JWT_APP_ID || "recruiteros").trim();
    return `${base}/${room}?jwt=${meetJwt(room, appId, secret, exp)}`;
  } catch {
    return null;
  }
}

async function workspaceAppUrl(workspaceId: string): Promise<string | null> {
  try {
    const { notifyBrand } = await import("../outbound/brand");
    return (await notifyBrand(workspaceId)).appUrl.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Like brandedMeetingUrl, but returns the parts so the /meet wrapper page can
 *  carry the token in its own query string. */
async function bookedMeetJoin(workspaceId: string, room: string, startIso: string): Promise<{ base: string; jwt: string } | null> {
  const base = (process.env.RECRUITEROS_MEET_BASE || "").trim().replace(/\/+$/, "");
  const secret = (process.env.RECRUITEROS_MEET_JWT_SECRET || "").trim();
  if (!base || !secret) return null;
  try {
    const appUrl = await workspaceAppUrl(workspaceId);
    if (!appUrl) return null;
    if (rootDomain(new URL(base).hostname) !== rootDomain(new URL(appUrl).hostname)) return null;
    const exp = Math.floor(Date.parse(startIso) / 1000) + 24 * 3600;
    const appId = (process.env.RECRUITEROS_MEET_JWT_APP_ID || "recruiteros").trim();
    return { base, jwt: meetJwt(room, appId, secret, exp) };
  } catch {
    return null;
  }
}

/** The guest-facing join link: our own /meet wrapper (brand, one-tap join,
 *  name prefilled, auto-recording) carrying the signed room token when the
 *  self-hosted meet server applies. */
async function wrappedMeetUrl(workspaceId: string, room: string, startIso: string, guestName: string): Promise<string | null> {
  const appUrl = await workspaceAppUrl(workspaceId);
  if (!appUrl) return null;
  const join = await bookedMeetJoin(workspaceId, room, startIso);
  return `${appUrl}/meet?room=${encodeURIComponent(room)}` +
    (join ? `&j=${join.jwt}&b=${encodeURIComponent(new URL(join.base).hostname)}` : "") +
    (guestName ? `&name=${encodeURIComponent(guestName.slice(0, 60))}` : "");
}

/**
 * Ad-hoc branded meeting (the /meet page): same base + same-root-domain rule
 * as booked calls, but TTL-anchored instead of booking-anchored. Null means
 * the caller should fall back to the neutral public bridge.
 */
export async function adhocMeetJoin(workspaceId: string, room: string, ttlHours = 12): Promise<{ base: string; jwt: string } | null> {
  const base = (process.env.RECRUITEROS_MEET_BASE || "").trim().replace(/\/+$/, "");
  const secret = (process.env.RECRUITEROS_MEET_JWT_SECRET || "").trim();
  if (!base || !secret) return null;
  try {
    const { notifyBrand } = await import("../outbound/brand");
    const appHost = new URL((await notifyBrand(workspaceId)).appUrl).hostname;
    if (rootDomain(new URL(base).hostname) !== rootDomain(appHost)) return null;
    const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
    const appId = (process.env.RECRUITEROS_MEET_JWT_APP_ID || "recruiteros").trim();
    return { base, jwt: meetJwt(room, appId, secret, exp) };
  } catch {
    return null;
  }
}

/* ---------------------- text reminders (show-rate lift) ---------------------- */
/* Best-practice cadence: instant confirmation, T-24h, T-1h, each carrying a
   short one-tap join link. Sent from the workspace's own Telnyx number
   (RECRUITEROS_BOOKING_SMS_FROM, else its first vetting-desk line). A send
   failure is recorded on the reminder and never breaks a booking. */

async function bookingSmsFrom(workspaceId: string): Promise<string | null> {
  const env = (process.env.RECRUITEROS_BOOKING_SMS_FROM || "").trim();
  if (env) return env;
  try {
    const { listDesks } = await import("../vetting/store");
    const d = listDesks(workspaceId).find((x: { phoneNumber?: string }) => !!x.phoneNumber);
    return d?.phoneNumber || null;
  } catch {
    return null;
  }
}

async function sendBookingSms(workspaceId: string, to: string, text: string): Promise<void> {
  const from = await bookingSmsFrom(workspaceId);
  if (!from) throw new Error("no_sms_number");
  const { withWorkspaceCreds } = await import("../connected");
  const { telnyx } = await import("../providers");
  await withWorkspaceCreds(workspaceId, () => telnyx.sendSms(to, text, from));
}

function planReminders(startIso: string): BookingReminder[] {
  const start = Date.parse(startIso);
  const now = Date.now();
  const out: BookingReminder[] = [{ kind: "confirm", at: new Date(now).toISOString() }];
  const day = start - 24 * 3600 * 1000;
  if (day > now + 5 * 60 * 1000) out.push({ kind: "day", at: new Date(day).toISOString() });
  const hour = start - 3600 * 1000;
  if (hour > now + 5 * 60 * 1000) out.push({ kind: "hour", at: new Date(hour).toISOString() });
  return out;
}

function reminderText(kind: BookingReminder["kind"], brandName: string, when: string, link: string): string {
  if (kind === "confirm") {
    return `${brandName}: you're booked for ${when}. Join from any phone or computer: ${link} We'll text you before it starts. Reply STOP to opt out.`;
  }
  if (kind === "day") return `${brandName}: reminder, your call is ${when}. One tap to join: ${link}`;
  return `${brandName}: your call starts soon, ${when}. Join: ${link}`;
}

/** Resolve a short /j/<code> click to a fresh join link (fresh token, name
 *  prefilled). Null once the meeting is a day past or the code is unknown. */
export async function joinUrlForBooking(code: string): Promise<string | null> {
  const c = String(code || "").trim();
  if (!/^[0-9a-f][0-9a-f-]{7,35}$/i.test(c)) return null;
  const m = await ensure();
  for (const [ws, list] of m.entries()) {
    const b = list.find((x) => x.id.startsWith(c));
    if (!b) continue;
    if (Date.now() > Date.parse(b.end) + 24 * 3600 * 1000) return null;
    const { getSettings } = await import("./videoSettings");
    const s = await getSettings(ws);
    if ((s.bookingMeetingUrl || "").trim()) return (s.bookingMeetingUrl as string).trim();
    const room = meetRoomName(s.brandName || "", b.id);
    return (await wrappedMeetUrl(ws, room, b.start, b.name)) || b.meetingUrl || null;
  }
  return null;
}

/** Meeting rooms embed the first 8 chars of the booking id (meetRoomName);
 *  the recording pipeline uses that to route a finished call back to its
 *  booking and workspace. */
export async function findBookingByRoomCode(code8: string): Promise<{ workspaceId: string; booking: Booking } | null> {
  const c = String(code8 || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(c)) return null;
  const m = await ensure();
  for (const [ws, list] of m.entries()) {
    const b = list.find((x) => x.id.toLowerCase().startsWith(c));
    if (b) return { workspaceId: ws, booking: b };
  }
  return null;
}

/** Minute tick: send every due, unsent reminder. One bad number never stops
 *  the sweep; a failure is stamped on the reminder and not retried. */
export async function tickBookingReminders(now: Date = new Date()): Promise<number> {
  const m = await ensure();
  let sent = 0;
  for (const [ws, list] of m.entries()) {
    let ctx: { brandName: string; cfg: ReturnType<typeof bookingConfig>; appUrl: string | null } | null = null;
    for (const b of list) {
      if (!b.phone || !b.reminders) continue;
      for (const r of b.reminders) {
        if (r.kind === "confirm" || r.sentAt || r.error) continue;
        if (Date.parse(r.at) > now.getTime()) continue;
        if (now.getTime() > Date.parse(b.start) + 15 * 60 * 1000) { r.error = "window_passed"; continue; }
        try {
          if (!ctx) {
            const { getSettings } = await import("./videoSettings");
            const s = await getSettings(ws);
            ctx = { brandName: (s.brandName || "").trim() || "our team", cfg: bookingConfig(s), appUrl: await workspaceAppUrl(ws) };
          }
          const link = ctx.appUrl ? `${ctx.appUrl}/j/${b.id.slice(0, 12)}` : (b.meetingUrl || "");
          await sendBookingSms(ws, b.phone, reminderText(r.kind, ctx.brandName, speakSlot(b.start, ctx.cfg), link));
          r.sentAt = new Date().toISOString();
          sent += 1;
        } catch (e) {
          r.error = String((e as Error)?.message || e).slice(0, 200);
        }
      }
    }
  }
  scheduleSave();
  return sent;
}

let mem: Map<string, Booking[]> | null = null;
let loading: Promise<void> | null = null;

async function ensure(): Promise<Map<string, Booking[]>> {
  if (mem) return mem;
  if (!loading) {
    loading = (async () => {
      const raw = (await loadSnapshot<Record<string, Booking[]>>(KEY).catch(() => null)) || {};
      mem = new Map(Object.entries(raw));
    })().catch(() => { mem = new Map(); });
  }
  await loading;
  return mem ?? (mem = new Map());
}
const scheduleSave = debouncedSaver(KEY, () => (mem ? Object.fromEntries(mem) : {}), 800);

/** This workspace's bookings (operator surfaces may want the list later). */
export async function listBookings(workspaceId: string): Promise<Booking[]> {
  const m = await ensure();
  return [...(m.get(workspaceId) || [])];
}

/* ----------------------------- link signing ----------------------------- */

function secret(): string {
  return process.env.RECRUITEROS_SESSION_SECRET || process.env.RECRUITEROS_API_TOKEN || "ros-share-dev-secret";
}

export function signBookingLink(workspaceId: string): string {
  return createHmac("sha256", secret()).update(`book:${workspaceId}`).digest("base64url").slice(0, 24);
}

export function verifyBookingLink(workspaceId: string, sig: string | null | undefined): boolean {
  if (!workspaceId || !sig) return false;
  const expect = signBookingLink(workspaceId);
  try {
    const a = Buffer.from(sig), b = Buffer.from(expect);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* ----------------------------- config ----------------------------- */

/** The zones the Brand tab offers; anything else falls back to Mountain. */
const BOOKING_TZS = new Set([
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
]);
const TZ_LABELS: Record<string, string> = {
  "America/New_York": "Eastern", "America/Chicago": "Central", "America/Denver": "Mountain",
  "America/Phoenix": "Arizona", "America/Los_Angeles": "Pacific",
};

export interface BookingConfig { tz: string; tzLabel: string; startHour: number; endHour: number; slotMin: number }

/** True when this workspace's built-in booking page is live. */
export function bookingActive(s: VideoSettings): boolean {
  return Boolean(s.bookingEnabled && s.bookingEmail);
}

/** The workspace's booking window, clamped to sane values. */
export function bookingConfig(s: VideoSettings): BookingConfig {
  const tz = s.bookingTz && BOOKING_TZS.has(s.bookingTz) ? s.bookingTz : "America/Denver";
  let startHour = Number.isInteger(s.bookingStartHour) ? (s.bookingStartHour as number) : 9;
  let endHour = Number.isInteger(s.bookingEndHour) ? (s.bookingEndHour as number) : 17;
  if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || endHour <= startHour) { startHour = 9; endHour = 17; }
  const slotMin = [15, 20, 30, 45, 60].includes(s.bookingSlotMin as number) ? (s.bookingSlotMin as number) : 30;
  return { tz, tzLabel: TZ_LABELS[tz] || "Mountain", startHour, endHour, slotMin };
}

/** Absolute /book URL for this workspace, on ITS OWN domain (white-label safe). */
export async function bookingUrlFor(workspaceId: string): Promise<string> {
  const { notifyBrand } = await import("../outbound/brand");
  const base = (await notifyBrand(workspaceId)).appUrl.replace(/\/+$/, "");
  return `${base}/book?w=${encodeURIComponent(workspaceId)}&sig=${encodeURIComponent(signBookingLink(workspaceId))}`;
}

/**
 * The settings object every brand consumer should see: when the built-in
 * calendar is on, calendarUrl points at OUR /book page (overriding any
 * third-party URL), so the watch page and baked share links pick it up with
 * zero changes on their side.
 */
export async function withBookingCalendar(workspaceId: string, s: VideoSettings): Promise<VideoSettings> {
  if (!bookingActive(s)) return s;
  try {
    return { ...s, calendarUrl: await bookingUrlFor(workspaceId) };
  } catch {
    return s;
  }
}

/* ----------------------------- time math ----------------------------- */
/* Mirrors lib/vetting/scheduling.ts (kept local: that module drags the whole
   vetting stack + Anthropic SDK into the import graph of a public route). */

function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - at.getTime();
}

/** Wall-clock y/m/d hh:mm in tz -> the UTC instant. DST-safe. */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const better = new Date(guess.getTime() - tzOffsetMs(tz, guess));
  return new Date(guess.getTime() - tzOffsetMs(tz, better));
}

function localParts(tz: string, at: Date): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day };
}

function fmt(tz: string, at: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(at);
}

/** "Tue, Aug 5 at 9:00 AM Mountain" for confirmations and invite copy. */
export function speakSlot(iso: string, cfg: BookingConfig): string {
  const at = new Date(iso);
  return `${fmt(cfg.tz, at, { weekday: "short", month: "short", day: "numeric" })} at ` +
    `${fmt(cfg.tz, at, { hour: "numeric", minute: "2-digit" })} ${cfg.tzLabel}`;
}

/* ----------------------------- open slots ----------------------------- */

const LEAD_MS = 90 * 60 * 1000;        // never offer a slot less than 90 minutes out
const HORIZON_DAYS = 14;               // two weeks of runway
const MAX_DAYS_SHOWN = 10;             // keep the picker digestible

export interface SlotDay { date: string; label: string; slots: { iso: string; label: string }[] }
export interface OpenSlots { tz: string; tzLabel: string; slotMin: number; days: SlotDay[] }

export async function listOpenSlots(workspaceId: string, s: VideoSettings, now = new Date()): Promise<OpenSlots> {
  const cfg = bookingConfig(s);
  const taken = (await listBookings(workspaceId)).map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) }));
  const slotMs = cfg.slotMin * 60 * 1000;
  const today = localParts(cfg.tz, now);
  const days: SlotDay[] = [];

  for (let off = 0; off < HORIZON_DAYS && days.length < MAX_DAYS_SHOWN; off++) {
    // Date.UTC normalizes day overflow, so today.d + off is always a real date.
    const anchor = zonedToUtc(today.y, today.m, today.d + off, 12, 0, cfg.tz);
    const wd = fmt(cfg.tz, anchor, { weekday: "short" });
    if (wd === "Sat" || wd === "Sun") continue;

    const slots: SlotDay["slots"] = [];
    for (let min = cfg.startHour * 60; min + cfg.slotMin <= cfg.endHour * 60; min += cfg.slotMin) {
      const start = zonedToUtc(today.y, today.m, today.d + off, Math.floor(min / 60), min % 60, cfg.tz);
      const st = start.getTime(), en = st + slotMs;
      if (st < now.getTime() + LEAD_MS) continue;
      if (taken.some((t) => st < t.e && en > t.s)) continue;
      slots.push({ iso: start.toISOString(), label: fmt(cfg.tz, start, { hour: "numeric", minute: "2-digit" }) });
    }
    if (slots.length) {
      days.push({
        date: fmt(cfg.tz, anchor, { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2"),
        label: fmt(cfg.tz, anchor, { weekday: "short", month: "short", day: "numeric" }),
        slots,
      });
    }
  }
  return { tz: cfg.tz, tzLabel: cfg.tzLabel, slotMin: cfg.slotMin, days };
}

/* ----------------------------- ICS invite ----------------------------- */

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
/** RFC 5545 line folding: content lines over 75 octets continue on the next line after one space. */
function icsFold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = " " + rest.slice(74); }
  out.push(rest);
  return out.join("\r\n");
}
function icsStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function buildInviteIcs(b: Booking, organizerEmail: string, organizerName: string, summary: string, description: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RecruitersOS//Booking//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${b.id}@ros-booking`,
    `DTSTAMP:${icsStamp(b.createdAt)}`,
    `DTSTART:${icsStamp(b.start)}`,
    `DTEND:${icsStamp(b.end)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    ...(b.meetingUrl ? [`LOCATION:${icsEscape(b.meetingUrl)}`, `URL:${icsEscape(b.meetingUrl)}`] : []),
    `ORGANIZER;CN=${icsEscape(organizerName)}:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${icsEscape(b.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${b.email}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].map(icsFold).join("\r\n");
}

/* ----------------------------- booking ----------------------------- */

export interface BookResult { ok: boolean; error?: string; when?: string; booking?: Booking }

/** Per-workspace serialization so two prospects can never take the same slot. */
const bookChain = new Map<string, Promise<void>>();

export function book(
  workspaceId: string, s: VideoSettings,
  startIso: string, guest: { name: string; email: string; note?: string; phone?: string },
): Promise<BookResult> {
  const prev = bookChain.get(workspaceId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => bookOne(workspaceId, s, startIso, guest));
  bookChain.set(workspaceId, run.then(() => {}, () => {}));
  return run;
}

async function bookOne(
  workspaceId: string, s: VideoSettings,
  startIso: string, guest: { name: string; email: string; note?: string; phone?: string },
): Promise<BookResult> {
  if (!bookingActive(s)) return { ok: false, error: "booking_unavailable" };
  const cfg = bookingConfig(s);

  // The offered-slot list IS the validator: legal grid position, inside hours,
  // weekday, lead time, and not overlapping an existing booking.
  const open = await listOpenSlots(workspaceId, s);
  if (!open.days.some((d) => d.slots.some((x) => x.iso === startIso))) {
    return { ok: false, error: "slot_taken" };
  }

  const brandName = (s.brandName || "").trim() || "our team";
  const id = randomUUID();
  const room = meetRoomName(s.brandName || "", id);
  // Join through OUR /meet wrapper: brand on the page, name prefilled,
  // recording auto-starts. Legacy fallbacks keep old configs working.
  const meetingUrl =
    (s.bookingMeetingUrl || "").trim() ||
    (await wrappedMeetUrl(workspaceId, room, startIso, guest.name)) ||
    (await brandedMeetingUrl(workspaceId, room, startIso)) ||
    `https://meet.jit.si/${room}`;
  const phone = guest.phone ? normalizePhone(guest.phone) : null;
  const booking: Booking = {
    id,
    start: startIso,
    end: new Date(Date.parse(startIso) + cfg.slotMin * 60 * 1000).toISOString(),
    name: guest.name, email: guest.email,
    note: guest.note || undefined,
    phone: phone || undefined,
    reminders: phone ? planReminders(startIso) : undefined,
    meetingUrl,
    createdAt: new Date().toISOString(),
    organizerEmailed: false, guestEmailed: false,
  };
  const m = await ensure();
  m.set(workspaceId, [...(m.get(workspaceId) || []), booking]);
  scheduleSave();

  const when = speakSlot(startIso, cfg);
  // Everyone gets the short link: clean in the email, one tap on a phone, and
  // it re-mints a fresh token at click time so it never arrives stale.
  const appUrl = await workspaceAppUrl(workspaceId);
  const joinLink = appUrl ? `${appUrl}/j/${id.slice(0, 12)}` : (booking.meetingUrl as string);
  const summary = `${guest.name} + ${brandName} (${cfg.slotMin} min call)`;
  const description =
    `Join the call: ${joinLink}\n` +
    `Guest: ${guest.name} (${guest.email})` +
    (guest.note ? `\nNote: ${guest.note}` : "");
  const ics = buildInviteIcs({ ...booking, meetingUrl: joinLink }, s.bookingEmail as string, brandName, summary, description);

  // Both sends ride the workspace's white-label mailbox; a mail failure never
  // loses the booking (it is already stored) and is visible in the response.
  const { sendWorkspaceEmail } = await import("../auth");
  try {
    await sendWorkspaceEmail(
      s.bookingEmail as string,
      `New call booked: ${guest.name}, ${when}`,
      `${guest.name} booked ${when} (${cfg.slotMin} min).\n\n` +
      `${guest.email}` +
      (booking.phone ? `\n${booking.phone} (text reminders on)` : "") +
      (guest.note ? `\nNote: ${guest.note}` : "") +
      `\n\nJoin: ${joinLink}\n`,
      workspaceId, { ics: { method: "REQUEST", content: ics } },
    );
    booking.organizerEmailed = true;
  } catch (e: any) {
    console.error("[booking] organizer invite failed:", e?.message || e);
  }
  try {
    await sendWorkspaceEmail(
      guest.email,
      `You're booked: ${when}`,
      `Hi ${guest.name},\n\n` +
      `You're confirmed: ${cfg.slotMin} minutes with ${brandName}, ${when}.\n\n` +
      `Join: ${joinLink}\n\n` +
      `One tap from any phone or computer, nothing to install. The attached invite puts it on your calendar.` +
      (booking.phone ? ` We'll text you a reminder before the call.` : "") +
      ` Need a different time? Just reply.\n\n${brandName}`,
      workspaceId, { ics: { method: "REQUEST", content: ics } },
    );
    booking.guestEmailed = true;
  } catch (e: any) {
    console.error("[booking] guest confirmation failed:", e?.message || e);
  }
  scheduleSave();

  // Instant confirmation text (the 24h and 1h reminders ride the minute tick).
  if (booking.phone && booking.reminders) {
    const confirm = booking.reminders.find((r) => r.kind === "confirm");
    if (confirm) {
      try {
        await sendBookingSms(workspaceId, booking.phone, reminderText("confirm", brandName, when, joinLink));
        confirm.sentAt = new Date().toISOString();
      } catch (e: any) {
        confirm.error = String(e?.message || e).slice(0, 200);
        console.error("[booking] confirmation text failed:", confirm.error);
      }
      scheduleSave();
    }
  }

  return { ok: true, when, booking };
}
