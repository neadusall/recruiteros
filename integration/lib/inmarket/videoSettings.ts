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
  /**
   * MPC campaign context: the recruiter's identity + the candidate they're currently marketing.
   * Company / open role / industry / location come PER-LEAD from the hiring signal; this is the half
   * that's constant across the batch and can only come from the recruiter — so the auto-enrolled
   * Client-side leads render the real placement, real proof, real sign-off instead of the generic
   * lexicon floor. Set once in the Studio; enrollToBulk stamps it onto every enrolled prospect.
   */
  mpc?: {
    /** The role you recently placed → {{Job_Title}} (e.g. "Senior AE"). */
    placedRole?: string;
    /** Where you placed it → resolved to {{Near_City}} + local vernacular (e.g. "Fort Worth, TX"). */
    placementLocation?: string;
    /** The candidate's two strongest proof clauses → {{MH1}} / {{MH2}} (e.g. "closed six-figure ARR deals"). */
    candidateProof?: string[];
    /** The candidate's quantified win → {{Metric}} (e.g. "142% to quota"). */
    candidateMetric?: string;
    /** The candidate's gender for he/she pronouns → {{P_subj}}/{{P_obj}}/{{P_pos}} (never "they"). */
    candidateGender?: "m" | "f";
    /** Your name for the sign-off → {{Your_Name}}. Without it the openers sign "Best," with no name. */
    yourName?: string;
  };
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
  if (s.mpc !== undefined) out.mpc = sanitizeMpc(s.mpc);
  return out;
}

/** Coerce the MPC context patch: trim strings, cap the proof bank at two clauses, gate gender. Only
 *  keys PRESENT in the patch are emitted, so a partial patch deep-merges without wiping other fields. */
function sanitizeMpc(input: VideoSettings["mpc"] | null | undefined): NonNullable<VideoSettings["mpc"]> {
  const m = input || {};
  const out: NonNullable<VideoSettings["mpc"]> = {};
  if (m.placedRole !== undefined) out.placedRole = clean(m.placedRole, 60);
  if (m.placementLocation !== undefined) out.placementLocation = clean(m.placementLocation, 80);
  if (m.candidateProof !== undefined)
    out.candidateProof = Array.isArray(m.candidateProof)
      ? m.candidateProof.map((c) => clean(c, 60)).filter((c): c is string => !!c).slice(0, 2)
      : [];
  if (m.candidateMetric !== undefined) out.candidateMetric = clean(m.candidateMetric, 60);
  if (m.candidateGender !== undefined) out.candidateGender = m.candidateGender === "f" ? "f" : "m";
  if (m.yourName !== undefined) out.yourName = clean(m.yourName, 60);
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
  const prev = m.get(workspaceId) || {};
  const clean = sanitize(patch);
  const next = { ...prev, ...clean };
  // Deep-merge the mpc block so a partial patch (e.g. just yourName) never wipes the other sub-fields.
  if (clean.mpc) next.mpc = { ...prev.mpc, ...clean.mpc };
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
