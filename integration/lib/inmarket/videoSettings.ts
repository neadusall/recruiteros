/**
 * RecruitersOS · In-Market · Video brand kit + settings (Sendspark-style)
 *
 * Per-workspace settings that turn the prospect-facing watch page into a BRANDED video landing
 * page (Sendspark parity): your logo, accent color, a primary CTA button (book-a-call), an
 * optional inline calendar embed, a reply address, and a "notify me when they watch" toggle.
 *
 * Stored server-side (durable via the Postgres snapshot KV, graceful no-op without DATABASE_URL)
 * so the brand kit is shared across the team and every device — set once, applies to every
 * personalized video. The operator edits it in the PiP Studio "Brand" tab; the studio bakes the
 * public, sanitized fields into the watch links it shares so the recipient page renders branded.
 */

import { loadSnapshot, debouncedSaver } from "../db";

const KEY = "inmarket_video_settings_v1";

export interface VideoSettings {
  /** Brand name shown on the watch page header (defaults to the workspace name). */
  brandName?: string;
  /** HTTPS logo URL shown on the watch page. */
  logoUrl?: string;
  /** Accent color "#rrggbb" for the play button + CTA. */
  accent?: string;
  /** Primary CTA button label, e.g. "Book a call". */
  ctaText?: string;
  /** Primary CTA target URL (booking/calendar/landing). */
  ctaUrl?: string;
  /** Optional inline calendar embed URL (Calendly etc.) shown under the video. */
  calendarUrl?: string;
  /** Reply-to address for the "Reply" action on the watch page. */
  replyEmail?: string;
  /** Email the operator when a prospect plays the video. */
  notifyOnView?: boolean;
  /** Where to send view notifications (defaults to the owner's email). */
  notifyEmail?: string;
}

/** Only these fields are safe to expose on the public watch page. */
export type PublicBrand = Pick<VideoSettings, "brandName" | "logoUrl" | "accent" | "ctaText" | "ctaUrl" | "calendarUrl" | "replyEmail">;

const DEFAULTS: VideoSettings = {
  accent: "#19c37d",
  ctaText: "Book a call",
  notifyOnView: false,
};

let mem: Map<string, VideoSettings> | null = null;
let loading: Promise<void> | null = null;

async function ensure(): Promise<Map<string, VideoSettings>> {
  if (mem) return mem;
  if (!loading) {
    loading = (async () => {
      const raw = (await loadSnapshot<Record<string, VideoSettings>>(KEY).catch(() => null)) || {};
      mem = new Map(Object.entries(raw));
    })().catch(() => { mem = new Map(); });
  }
  await loading;
  return mem ?? (mem = new Map());
}
const scheduleSave = debouncedSaver(KEY, () => (mem ? Object.fromEntries(mem) : {}), 800);

/* ----------------------------- sanitizers ----------------------------- */
const isHttp = (s: unknown) => typeof s === "string" && /^https?:\/\/[^\s]{4,400}$/i.test(s);
const isHex = (s: unknown) => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);
const clean = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : undefined);
const isEmail = (s: unknown) => typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/** Coerce arbitrary input into a safe settings patch (drops anything malformed). */
export function sanitize(input: Partial<VideoSettings> | null | undefined): Partial<VideoSettings> {
  const s = input || {};
  const out: Partial<VideoSettings> = {};
  if (s.brandName !== undefined) out.brandName = clean(s.brandName, 80);
  if (s.logoUrl !== undefined) out.logoUrl = isHttp(s.logoUrl) ? (s.logoUrl as string) : "";
  if (s.accent !== undefined) out.accent = isHex(s.accent) ? (s.accent as string) : DEFAULTS.accent;
  if (s.ctaText !== undefined) out.ctaText = clean(s.ctaText, 40);
  if (s.ctaUrl !== undefined) out.ctaUrl = isHttp(s.ctaUrl) ? (s.ctaUrl as string) : "";
  if (s.calendarUrl !== undefined) out.calendarUrl = isHttp(s.calendarUrl) ? (s.calendarUrl as string) : "";
  if (s.replyEmail !== undefined) out.replyEmail = isEmail(s.replyEmail) ? (s.replyEmail as string) : "";
  if (s.notifyOnView !== undefined) out.notifyOnView = !!s.notifyOnView;
  if (s.notifyEmail !== undefined) out.notifyEmail = isEmail(s.notifyEmail) ? (s.notifyEmail as string) : "";
  return out;
}

/** The workspace's settings, merged over defaults. */
export async function getSettings(workspaceId: string): Promise<VideoSettings> {
  const m = await ensure();
  return { ...DEFAULTS, ...(m.get(workspaceId) || {}) };
}

/** Merge a sanitized patch into the workspace's settings; returns the result. */
export async function saveSettings(workspaceId: string, patch: Partial<VideoSettings>): Promise<VideoSettings> {
  const m = await ensure();
  const next = { ...(m.get(workspaceId) || {}), ...sanitize(patch) };
  m.set(workspaceId, next);
  scheduleSave();
  return { ...DEFAULTS, ...next };
}

/** The public, sanitized subset safe to render on the recipient page. */
export function publicBrand(s: VideoSettings): PublicBrand {
  return {
    brandName: s.brandName, logoUrl: s.logoUrl, accent: s.accent,
    ctaText: s.ctaText, ctaUrl: s.ctaUrl, calendarUrl: s.calendarUrl, replyEmail: s.replyEmail,
  };
}
