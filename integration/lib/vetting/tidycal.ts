/**
 * RecruiterOS · AI Vetting · TidyCal sync
 *
 * Turns TidyCal bookings into pre-researched candidates on the right vetting
 * desk. For each upcoming booking we read:
 *   - the booking type's TITLE  -> which desk (matched to the desk's role title),
 *     which is what tells us the number the inbound call will come to,
 *   - the booker's PHONE        -> the key we match the inbound caller-ID on,
 *   - their LINKEDIN URL        -> pre-enriched now so the agent can speak to
 *     their background the moment they call,
 *   - name + email.
 *
 * Phone is required to connect a booking to its inbound call (caller-ID match),
 * so bookings without one are reported back, not silently dropped. Everything is
 * dry-run safe: with no TIDYCAL_API_TOKEN the pull returns nothing.
 */

import { tidycal } from "../providers";
import { listDesks, upsertCandidate, setCandidateEnrichment } from "./store";
import { enrichCandidate } from "./enrich";
import type { VettingDesk } from "./types";

/** Lowercase, strip punctuation/extra space — for tolerant title matching. */
function norm(s?: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** A LinkedIn profile URL found anywhere in a string (scheme optional). */
function findLinkedIn(s?: string): string | undefined {
  const m = (s || "").match(/(https?:\/\/)?(www\.)?linkedin\.com\/in\/[^\s"']+/i);
  if (!m) return undefined;
  return m[0].startsWith("http") ? m[0] : "https://" + m[0];
}

/** A phone-ish token (>= 10 digits) found in a string. */
function findPhone(s?: string): string | undefined {
  const digits = (s || "").replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 10 ? digits : undefined;
}

export interface BookingMatch {
  bookingId?: string | number;
  name: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  jobTitle: string;
  startsAt?: string;
  deskId?: string;
  deskName?: string;
  status: "ready" | "unmatched" | "no_phone";
}

/** Build a normalized {question label -> answer} map from a booking's questions. */
function answerMap(questions: any[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const q of questions) {
    const label = norm(q?.question ?? q?.title ?? q?.label ?? q?.name);
    const ans = String(q?.answer ?? q?.value ?? q?.response ?? "").trim();
    if (label && ans && !m[label]) m[label] = ans;
  }
  return m;
}

/** First answer whose label contains any of the given terms. */
function byLabel(m: Record<string, string>, terms: string[]): string | undefined {
  for (const key of Object.keys(m)) {
    if (terms.some((t) => key.includes(t))) return m[key];
  }
  return undefined;
}

/** Pull the useful fields out of one TidyCal booking (tolerant of shapes).
 *  Job title + LinkedIn URL + phone are read from the booking's custom QUESTION
 *  answers (by label), falling back to the contact fields and the booking type. */
function extract(booking: any, titleById: Record<string, string>): Omit<BookingMatch, "deskId" | "deskName" | "status"> {
  const contact = booking?.contact ?? {};
  const name = String(contact.name ?? booking?.name ?? "").trim();
  const email = String(contact.email ?? booking?.email ?? "").trim() || undefined;

  const questions: any[] = Array.isArray(booking?.questions)
    ? booking.questions
    : Array.isArray(booking?.booking_questions)
      ? booking.booking_questions
      : [];
  const m = answerMap(questions);
  const answers = Object.values(m).join("  ");

  // LinkedIn: prefer the labelled question, then contact, then any URL in answers.
  const linkedinUrl =
    findLinkedIn(byLabel(m, ["linkedin"])) ??
    findLinkedIn(contact.linkedin) ?? findLinkedIn(booking?.linkedin) ?? findLinkedIn(answers);

  // Phone: labelled question, then contact, then any phone-shaped answer.
  const phone =
    findPhone(byLabel(m, ["phone", "mobile", "cell", "number"])) ||
    (typeof contact.phone === "string" ? findPhone(contact.phone) : undefined) ||
    findPhone(booking?.phone) ||
    findPhone(answers) ||
    undefined;

  // Job title: the "Job title" question wins (most specific), then role/position,
  // then the booking type's title as a fallback.
  const bt = booking?.booking_type ?? {};
  const jobTitle = String(
    byLabel(m, ["job title", "jobtitle"]) ??
    byLabel(m, ["role", "position"]) ??
    byLabel(m, ["title"]) ??
    bt.title ?? booking?.booking_type_title ?? titleById[String(booking?.booking_type_id)] ?? "",
  ).trim();

  return {
    bookingId: booking?.id,
    name,
    email,
    phone,
    linkedinUrl,
    jobTitle,
    startsAt: booking?.starts_at,
  };
}

/** Match a booking's job title to a desk (exact normalized, then contains). */
function matchDesk(desks: VettingDesk[], jobTitle: string): VettingDesk | undefined {
  const t = norm(jobTitle);
  if (!t) return undefined;
  return (
    desks.find((d) => norm(d.roleTitle) === t || norm(d.name) === t) ||
    desks.find((d) => (norm(d.roleTitle) && (t.includes(norm(d.roleTitle)) || norm(d.roleTitle).includes(t))))
  );
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "there", lastName: parts.slice(1).join(" ") || "" };
}

export interface TidyCalSyncResult {
  configured: boolean;
  pulled: number;
  ready: number;
  unmatched: number;
  noPhone: number;
  bookings: BookingMatch[];
  error?: string;
}

/**
 * Pull upcoming bookings and (when write=true) create/update the matching
 * candidate on its desk + pre-enrich LinkedIn. write=false previews the mapping
 * without touching anything. Never throws — surfaces an error string instead.
 */
export async function syncTidyCalBookings(workspaceId: string, write = true): Promise<TidyCalSyncResult> {
  const base: TidyCalSyncResult = { configured: tidycal.configured(), pulled: 0, ready: 0, unmatched: 0, noPhone: 0, bookings: [] };
  if (!tidycal.configured()) return base;

  let raw: any[] = [];
  let types: any[] = [];
  try {
    const now = new Date().toISOString();
    [raw, types] = await Promise.all([
      tidycal.listBookings({ startsAt: now, cancelled: false }),
      tidycal.listBookingTypes(),
    ]);
  } catch (e: any) {
    return { ...base, error: e?.message || "tidycal_error" };
  }

  const titleById: Record<string, string> = {};
  for (const t of types) titleById[String(t?.id)] = String(t?.title ?? "");

  const desks = listDesks(workspaceId, "recruiting");
  const out: BookingMatch[] = [];

  for (const b of raw) {
    const e = extract(b, titleById);
    if (!e.name && !e.email) continue; // junk row
    const desk = matchDesk(desks, e.jobTitle);
    let status: BookingMatch["status"] = "ready";
    if (!desk) status = "unmatched";
    else if (!e.phone) status = "no_phone";

    const row: BookingMatch = { ...e, deskId: desk?.id, deskName: desk?.name, status };
    out.push(row);

    if (write && desk && e.phone) {
      const { firstName, lastName } = splitName(e.name);
      const cand = upsertCandidate(workspaceId, {
        deskId: desk.id, firstName, lastName, phone: e.phone, email: e.email || "", linkedinUrl: e.linkedinUrl,
      });
      // Pre-research now (only if we haven't already, or we just got a URL).
      const needsEnrich = e.linkedinUrl && (!cand.enrichment || cand.enrichment.source === "none");
      if (needsEnrich) {
        const enrichment = await enrichCandidate(e.linkedinUrl);
        setCandidateEnrichment(cand.id, enrichment);
      }
    }
  }

  return {
    configured: true,
    pulled: out.length,
    ready: out.filter((r) => r.status === "ready").length,
    unmatched: out.filter((r) => r.status === "unmatched").length,
    noPhone: out.filter((r) => r.status === "no_phone").length,
    bookings: out.slice(0, 200),
  };
}
