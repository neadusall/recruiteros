/**
 * RecruitersOS · AI Vetting · Self-scheduling (the availability loop)
 *
 * The native replacement for third-party booking pages. The moment a candidate's
 * resume is filed from the inbox, we text (or email) them ONE question: "what
 * day and time works for a quick call?" They answer in their own words, exactly
 * how people actually text: "today at 4pm EST", "tomorrow morning", "Friday
 * after 3". We parse it, resolve their timezone (stated wins, else inferred
 * from their phone number's area code, else Eastern), and hand the exact moment
 * to the voice engine as a scheduled event, so the AI calls THEM at the time
 * they asked for. Confirmations, clarifying follow-ups, one polite reminder,
 * and reschedules ("can we do 6 instead?") all ride the same loop.
 *
 * Parsing is LLM-first (same Anthropic + strict-JSON + temperature:0 convention
 * as scoring.ts) with a deterministic regex fallback so the loop still works
 * without a model key. Every send and reply is recorded as a ScheduleStep so
 * the recruiter can read the whole exchange on the Scheduled Calls tab.
 */

import Anthropic from "@anthropic-ai/sdk";
import { telnyx } from "../providers";
import { withWorkspaceCreds } from "../connected";
import { sendWorkspaceEmail } from "../auth";
import type { VettingDesk, CandidateProfile, ScreenSchedule, ScheduleStep, ScheduleStepKind } from "./types";
import {
  getDeskById, getCandidateById, setCandidateScreen, addScreenStep,
  listActiveScheduleCandidates, markScreenInviteSent, latestResumeReview,
  ensureVettingReady, phoneDigits,
} from "./store";
import { buildCallContext } from "./prompt";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_VETTING_MODEL ?? process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/* ================================================================
   Timezone from the phone number (NANP area code -> IANA zone)
   ================================================================ */

/** IANA zone per area-code group. Split-zone codes use their population center. */
const TZ_AREAS: Record<string, string> = {};
function reg(tz: string, codes: string) {
  for (const c of codes.split(/[,\s]+/).filter(Boolean)) TZ_AREAS[c] = tz;
}
reg("America/New_York",
  // CT / DC / DE / ME / MD / MA / NH / NJ / NY / PA / RI / VT / VA / WV
  "203 475 860 959 202 771 302 207 240 301 410 443 667 339 351 413 508 617 774 781 857 978 603 " +
  "201 551 609 640 732 848 856 862 908 973 212 315 332 347 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934 " +
  "215 223 267 272 412 445 484 570 582 610 717 724 814 878 401 802 276 434 540 571 703 757 804 826 948 304 681 " +
  // FL (Eastern) / GA / NC / SC / OH / MI / IN (Eastern) / KY (Eastern) / TN (Eastern)
  "305 321 352 386 407 561 689 727 754 772 786 813 863 904 941 954 229 404 470 478 678 706 762 770 912 943 " +
  "252 336 704 743 828 910 919 980 984 803 839 843 854 864 216 220 234 283 330 380 419 440 513 567 614 740 937 " +
  "231 248 269 313 517 586 616 679 734 810 906 947 989 260 317 463 574 765 812 930 502 606 859 423 865 " +
  // Ontario + Quebec + eastern Canada
  "226 249 289 343 365 416 437 519 548 613 647 705 807 905 418 438 450 514 579 581 819 873");
reg("America/Chicago",
  // AL / AR / IL / IA / KS / LA / MN / MS / MO / NE / ND / OK / SD / WI
  "205 251 256 334 659 938 479 501 870 217 224 309 312 331 447 618 630 708 773 779 815 847 872 " +
  "319 515 563 641 712 316 620 785 913 225 318 337 504 985 218 320 507 612 651 763 952 " +
  "228 601 662 769 314 417 573 636 660 816 402 531 701 405 539 580 918 605 262 274 414 534 608 715 920 " +
  // TX (Central) / TN (Central) / KY (Western) / IN (NW) / FL panhandle
  "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979 " +
  "615 629 731 901 931 270 364 219 850 204 431 306 639");
reg("America/Denver", "303 719 720 970 983 208 986 406 505 575 385 435 801 307 915 403 587 780 825");
reg("America/Phoenix", "480 520 602 623 928");
reg("America/Los_Angeles",
  "209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951 " +
  "702 725 775 458 503 541 971 206 253 360 425 509 564 236 250 604 778");
reg("America/Anchorage", "907");
reg("Pacific/Honolulu", "808");
reg("America/Halifax", "506 902 782");
reg("America/St_Johns", "709");

const DEFAULT_TZ = "America/New_York";

/** Infer the candidate's timezone from their phone number's area code. */
export function tzFromPhone(phone?: string): { tz: string; source: "area_code" | "default" } {
  const d = phoneDigits(phone).slice(-10);
  const area = d.slice(0, 3);
  const tz = TZ_AREAS[area];
  return tz ? { tz, source: "area_code" } : { tz: DEFAULT_TZ, source: "default" };
}

/** A timezone the candidate SAID ("EST", "central", "PT") -> IANA zone. */
function statedTz(text: string): string | undefined {
  const t = ` ${text.toLowerCase()} `;
  const has = (...tokens: string[]) => tokens.some((x) => new RegExp(`[^a-z]${x}[^a-z]`).test(t));
  if (has("est", "edt", "et", "eastern")) return "America/New_York";
  if (has("cst", "cdt", "ct", "central")) return "America/Chicago";
  if (has("mst", "mdt", "mt", "mountain")) return "America/Denver";
  if (has("pst", "pdt", "pt", "pacific")) return "America/Los_Angeles";
  if (has("akst", "akdt", "alaska")) return "America/Anchorage";
  if (has("hst", "hawaii")) return "Pacific/Honolulu";
  if (has("arizona")) return "America/Phoenix";
  return undefined;
}

/* ================================================================
   Wall-clock time in a zone <-> UTC instant (no date library needed)
   ================================================================ */

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

/** "4:00pm on July 22nd, wall-clock, in tz" -> the UTC instant. DST-safe. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const better = new Date(guess.getTime() - tzOffsetMs(tz, guess));
  return new Date(guess.getTime() - tzOffsetMs(tz, better));
}

/** The candidate-facing zone label for confirmations ("Eastern", "Pacific"). */
function tzLabel(tz: string): string {
  const names: Record<string, string> = {
    "America/New_York": "Eastern", "America/Chicago": "Central", "America/Denver": "Mountain",
    "America/Phoenix": "Arizona", "America/Los_Angeles": "Pacific", "America/Anchorage": "Alaska",
    "Pacific/Honolulu": "Hawaii", "America/Halifax": "Atlantic", "America/St_Johns": "Newfoundland",
    "America/Toronto": "Eastern", "America/Edmonton": "Mountain", "America/Vancouver": "Pacific",
    "America/Regina": "Central",
  };
  return names[tz] || "";
}

/** "Tue, Jul 22 at 4:00 PM Eastern" in the candidate's zone. */
export function speakWhen(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  const label = tzLabel(tz);
  return `${day} at ${time}${label ? ` ${label}` : ""}`;
}

/* ================================================================
   Parsing "today at 4pm EST" into an exact instant
   ================================================================ */

export interface ParsedAvailability {
  kind: "time" | "anytime" | "unclear" | "decline";
  /** UTC instant, set when kind === "time". */
  whenUtc?: string;
  /** The zone the time was interpreted in. */
  tz: string;
  tzSource: "stated" | "area_code" | "default";
  note?: string;
}

/** Current wall-clock context for the model, in the candidate's zone. */
function nowContext(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(now);
}

async function parseWithLlm(text: string, tz: string, now: Date): Promise<{ kind: ParsedAvailability["kind"]; local?: string; statedTz?: string } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      temperature: 0,
      system:
        "You convert a job candidate's texted availability for a phone call into an exact local date and time. " +
        "Reply with STRICT JSON only, no prose: " +
        '{"kind":"time"|"anytime"|"unclear"|"decline","local":"YYYY-MM-DDTHH:MM"|null,"timezone":"IANA zone or null"}. ' +
        'Rules: "kind":"time" needs a concrete day AND time; vague day-parts map to morning=10:00, midday=12:00, afternoon=14:00, evening=18:00. ' +
        '"now", "asap", "anytime", "whenever" mean kind":"anytime". A clear no ("not interested", "stop", "found a job") is "decline". ' +
        'Set "timezone" ONLY if the candidate explicitly names one (EST, central, PT); map it to an IANA zone. ' +
        "Never return a moment in the past: a bare time earlier today means the NEXT occurrence of that time. " +
        "Anything you cannot pin to a day and time is \"unclear\".",
      messages: [{
        role: "user",
        content:
          `Right now for this candidate it is: ${nowContext(tz, now)} (zone ${tz}).\n` +
          `Their reply about when to call:\n"${text.slice(0, 400)}"`,
      }],
    });
    const raw = response.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (!o || typeof o.kind !== "string") return null;
    return { kind: o.kind, local: typeof o.local === "string" ? o.local : undefined, statedTz: typeof o.timezone === "string" ? o.timezone : undefined };
  } catch {
    return null;
  }
}

/** Regex fallback: the common shapes people actually text. */
function parseDeterministic(text: string, tz: string, now: Date): { kind: ParsedAvailability["kind"]; local?: string } {
  const t = text.toLowerCase().trim();
  if (/\b(not interested|no thanks|no thank|stop|unsubscribe|found (a|another) (job|role)|pass on)\b/.test(t)) return { kind: "decline" };
  if (/\b(now|asap|as soon as|any ?time|whenever)\b/.test(t)) return { kind: "anytime" };

  // Day: today / tonight / tomorrow / weekday name.
  const localNow = new Date(now.getTime() + tzOffsetMs(tz, now));
  let dayOffset: number | null = null;
  if (/\btoday\b/.test(t)) dayOffset = 0;
  else if (/\btonight\b/.test(t)) dayOffset = 0;
  else if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(t)) dayOffset = 1;
  else {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    for (let i = 0; i < 7; i++) {
      const short = days[i].slice(0, 3);
      if (new RegExp(`\\b(${days[i]}|${short})\\b`).test(t)) {
        const diff = (i - localNow.getUTCDay() + 7) % 7;
        dayOffset = diff === 0 ? 7 : diff;
        break;
      }
    }
  }

  // Time: 4pm / 4:30 pm / 16:00 / noon / day-part words.
  let hh: number | null = null, mm = 0;
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/);
  if (/\bnoon\b/.test(t)) hh = 12;
  else if (/\bmorning\b/.test(t)) hh = 10;
  else if (/\bafternoon\b/.test(t)) hh = 14;
  else if (/\b(evening|tonight)\b/.test(t)) hh = 18;
  else if (m) {
    let h = parseInt(m[1], 10);
    mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = (m[3] || "").replace(/\./g, "");
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    // A bare small number with no am/pm during a call-time conversation almost
    // always means the afternoon slot ("call me at 4").
    if (!ap && h >= 1 && h <= 7) h += 12;
    if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) hh = h;
  }

  if (hh === null && dayOffset === null) return { kind: "unclear" };
  if (hh === null) hh = 10; // a day with no time: mid-morning
  if (dayOffset === null) dayOffset = 0; // a time with no day: today (rolled below if past)

  const y = localNow.getUTCFullYear(), mo = localNow.getUTCMonth(), da = localNow.getUTCDate();
  let when = zonedToUtc(y, mo + 1, da + dayOffset, hh, mm, tz);
  if (dayOffset === 0 && when.getTime() <= now.getTime()) {
    when = zonedToUtc(y, mo + 1, da + 1, hh, mm, tz); // "at 4" said at 5pm -> tomorrow 4
  }
  return { kind: "time", local: when.toISOString() };
}

/**
 * Turn the candidate's words into an exact UTC instant (or a clear signal that
 * we need to ask again). Stated timezone > area-code inference > Eastern.
 */
export async function parseAvailability(text: string, phone: string | undefined, now = new Date()): Promise<ParsedAvailability> {
  const said = statedTz(text);
  const inferred = tzFromPhone(phone);
  const tz = said || inferred.tz;
  const tzSource: ParsedAvailability["tzSource"] = said ? "stated" : inferred.source;

  const llm = await parseWithLlm(text, tz, now);
  if (llm) {
    const useTz = llm.statedTz && tzLabel(llm.statedTz) ? llm.statedTz : tz;
    if (llm.kind === "time" && llm.local) {
      const m = llm.local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (m) {
        const when = zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], useTz);
        return { kind: "time", whenUtc: when.toISOString(), tz: useTz, tzSource: llm.statedTz ? "stated" : tzSource };
      }
    }
    if (llm.kind === "anytime" || llm.kind === "decline" || llm.kind === "unclear") {
      return { kind: llm.kind, tz: useTz, tzSource };
    }
  }

  const det = parseDeterministic(text, tz, now);
  if (det.kind === "time" && det.local) return { kind: "time", whenUtc: det.local, tz, tzSource };
  return { kind: det.kind, tz, tzSource };
}

/* ================================================================
   Sends (best-effort, always recorded)
   ================================================================ */

async function sendSms(desk: VettingDesk, cand: CandidateProfile, kind: ScheduleStepKind, text: string): Promise<boolean> {
  const step: ScheduleStep = { at: new Date().toISOString(), kind, ok: false };
  if (!cand.phone) step.note = "no phone on file";
  else if (!desk.phoneNumber) step.note = "desk has no number";
  else {
    try {
      const res: any = await withWorkspaceCreds(desk.workspaceId, () => telnyx.sendSms(cand.phone, text, desk.phoneNumber));
      if (res?.error) throw new Error(String(res.error));
      step.ok = true;
    } catch (e: any) {
      step.note = String(e?.message || "sms failed").slice(0, 160);
    }
  }
  addScreenStep(cand.id, step);
  return Boolean(step.ok);
}

async function sendEmail(desk: VettingDesk, cand: CandidateProfile, kind: ScheduleStepKind, subject: string, body: string): Promise<boolean> {
  const step: ScheduleStep = { at: new Date().toISOString(), kind, ok: false };
  if (!cand.email) step.note = "no email on file";
  else {
    try {
      await sendWorkspaceEmail(cand.email, subject, body, desk.workspaceId);
      step.ok = true;
    } catch (e: any) {
      step.note = String(e?.message || "email failed").slice(0, 160);
    }
  }
  addScreenStep(cand.id, step);
  return Boolean(step.ok);
}

/* ---------------- copy (warm, short, no em-dashes) ---------------- */

function askText(desk: VettingDesk, cand: CandidateProfile): string {
  const first = cand.firstName ? `Hi ${cand.firstName}, ` : "Hi, ";
  return `${first}it's ${desk.persona.agentName} with ${desk.persona.agentCompany}. Your resume for the ${desk.roleTitle || "role"} just landed, thank you. ` +
    `Next step is a quick call with me, about ten minutes. What day and time works for you? ` +
    `Reply right here with something like "today at 4pm" or "tomorrow morning" and I'll call you then.`;
}

function askEmailBody(desk: VettingDesk, cand: CandidateProfile): string {
  return `Hi ${cand.firstName || "there"},\n\n` +
    `Thanks for sending your resume for the ${desk.roleTitle || "role"}. The next step is a quick ten minute phone call with me.\n\n` +
    `Just reply to this email with a day and time that works, something like "today at 4pm" or "Thursday morning", and I'll call you then. ` +
    `If you are not on Eastern time, mention your timezone and I'll match it.\n\n` +
    `Talk soon,\n${desk.persona.agentName}\n${desk.persona.agentCompany}`;
}

function clarifyText(desk: VettingDesk): string {
  return `Want to make sure I call at the right moment. What day and time works best? ` +
    `Something like "tomorrow at 2pm" is perfect, and if you're not on ${tzLabel(DEFAULT_TZ)} time just add your timezone.`;
}

function confirmText(desk: VettingDesk, cand: CandidateProfile, whenUtc: string, tz: string, rebooked: boolean): string {
  const when = speakWhen(whenUtc, tz);
  const opener = rebooked ? "Done, moved it." : "Perfect, you're on my calendar.";
  return `${opener} I'll call you at this number ${when}. ` +
    `If anything changes just text me a new time here. Talk then, ${cand.firstName || "thanks"}!`;
}

/* ================================================================
   The loop: ask -> reply -> book -> (reschedule) -> call
   ================================================================ */

/**
 * The availability ask, fired when the resume is filed (replaces the old
 * "call me whenever" invite). SMS from the desk's own number when we have
 * their cell, email otherwise. Once per candidate; a resume UPDATE never
 * re-asks. Never throws.
 */
export async function sendAvailabilityAsk(desk: VettingDesk, cand: CandidateProfile, opts?: { force?: boolean }): Promise<boolean> {
  try {
    if (!opts?.force && (cand.screenInviteSentAt || cand.screen)) return false;
    if (desk.status !== "live") return false;
    const channel: "sms" | "email" = cand.phone && desk.phoneNumber ? "sms" : "email";
    const screen: ScreenSchedule = {
      status: "awaiting_reply", askedAt: new Date().toISOString(), askChannel: channel,
      clarifyCount: 0, steps: [],
    };
    setCandidateScreen(cand.id, screen);
    const ok = channel === "sms"
      ? await sendSms(desk, cand, "ask_sms", askText(desk, cand))
      : await sendEmail(desk, cand, "ask_email", `Quick call about the ${desk.roleTitle || "role"}?`, askEmailBody(desk, cand));
    if (ok) markScreenInviteSent(cand.id);
    return ok;
  } catch (e: any) {
    console.error("[vetting] availability ask failed:", e?.message || e);
    return false;
  }
}

/** The full dynamic-variable set the scheduled call carries (mirrors /api/vetting/context). */
function scheduledCallVars(desk: VettingDesk, cand: CandidateProfile): Record<string, string> {
  const review = latestResumeReview(cand.id);
  const gaps = review
    ? review.coverage.filter((c) => c.status !== "shown").slice(0, 6)
        .map((c) => `- ${c.requirement}${c.mustHave ? " (must-have)" : ""}: ${c.status === "partial" ? "hinted at on the resume but easy to miss" : "not shown on the resume"}.`)
        .join("\n")
    : "";
  const vars = buildCallContext(desk, cand, { resumeGaps: gaps });
  vars.call_opening = "Thanks for making time, calling like we set up.";
  return vars;
}

/**
 * Put the call on the books: the voice engine dials the candidate at the exact
 * moment (Telnyx scheduled event; our clock only does reminders). Reschedules
 * cancel the previous event first. Returns false when the desk has no live
 * assistant to fire from.
 */
async function bookScreenCall(desk: VettingDesk, cand: CandidateProfile, whenUtc: string, tz: string, tzSource: ScreenSchedule["tzSource"]): Promise<boolean> {
  if (!desk.assistantId || !desk.phoneNumber || !cand.phone) return false;
  const prior = cand.screen;
  const rebooked = Boolean(prior?.eventId && prior.status === "booked");
  try {
    return await withWorkspaceCreds(desk.workspaceId, async () => {
      if (rebooked && prior?.eventId && !prior.eventId.startsWith("dry_")) {
        try { await telnyx.deleteAssistantScheduledEvent(desk.assistantId!, prior.eventId); } catch { /* stale event */ }
      }
      const res: any = await telnyx.createAssistantScheduledEvent(desk.assistantId!, {
        agentNumber: desk.phoneNumber!,
        endUserNumber: cand.phone,
        scheduledAt: whenUtc,
        channel: "phone_call",
        dynamicVariables: scheduledCallVars(desk, cand),
      });
      if (res?.error) throw new Error(String(res.error));
      const eventId = res?.data?.scheduled_event_id ?? res?.scheduled_event_id ?? (res?.dryRun ? `dry_${cand.id}` : undefined);
      const screen: ScreenSchedule = {
        ...(cand.screen ?? { askedAt: new Date().toISOString(), askChannel: "sms", clarifyCount: 0, steps: [] }),
        status: "booked", scheduledFor: whenUtc, timezone: tz, tzSource,
        eventId, bookedAt: new Date().toISOString(), note: undefined,
      };
      setCandidateScreen(cand.id, screen);
      addScreenStep(cand.id, { at: new Date().toISOString(), kind: rebooked ? "rebooked" : "booked", ok: true, note: speakWhen(whenUtc, tz) });
      return true;
    });
  } catch (e: any) {
    addScreenStep(cand.id, { at: new Date().toISOString(), kind: "error", ok: false, note: String(e?.message || "booking failed").slice(0, 160) });
    return false;
  }
}

/**
 * A candidate replied (SMS to the desk's number, or an email to the resume
 * inbox with no attachment). Parse it, then book / clarify / close out.
 * Never throws; every branch answers the candidate so nobody texts into a void.
 */
export async function handleScheduleReply(candidateId: string, text: string, channel: "sms" | "email"): Promise<{ handled: boolean; outcome: string }> {
  await ensureVettingReady();
  const cand = getCandidateById(candidateId);
  const desk = cand ? getDeskById(cand.deskId) : undefined;
  if (!cand || !desk) return { handled: false, outcome: "no_candidate" };

  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return { handled: false, outcome: "empty" };

  // Open a loop on the fly for a candidate who texts availability before (or
  // without) the ask, as long as they're a known, opted-in candidate.
  if (!cand.screen) {
    setCandidateScreen(cand.id, {
      status: "awaiting_reply", askedAt: new Date().toISOString(),
      askChannel: channel, clarifyCount: 0, steps: [],
    });
  }
  const screen = getCandidateById(cand.id)!.screen!;
  screen.lastReplyAt = new Date().toISOString();
  screen.lastReply = trimmed.slice(0, 300);
  setCandidateScreen(cand.id, screen);
  addScreenStep(cand.id, { at: new Date().toISOString(), kind: "reply", note: trimmed.slice(0, 300) });

  const parsed = await parseAvailability(trimmed, cand.phone);

  if (parsed.kind === "decline") {
    screen.status = "declined";
    screen.note = "candidate passed";
    setCandidateScreen(cand.id, screen);
    await sendSms(desk, cand, "confirm_sms",
      `No problem at all, ${cand.firstName || "thanks for letting me know"}. If timing changes down the road, text me here any time.`);
    return { handled: true, outcome: "declined" };
  }

  const now = Date.now();
  let whenUtc = parsed.kind === "anytime" ? new Date(now + 3 * 60_000).toISOString() : parsed.whenUtc;

  // Sanity rails: never book the past, never book absurdly far out.
  if (whenUtc) {
    const t = Date.parse(whenUtc);
    if (t < now + 90_000) whenUtc = new Date(now + 3 * 60_000).toISOString();
    else if (t > now + 45 * 24 * 60 * 60 * 1000) whenUtc = undefined;
  }

  if (!whenUtc) {
    screen.clarifyCount = (screen.clarifyCount ?? 0) + 1;
    screen.status = "clarify";
    if (screen.clarifyCount > 2) {
      screen.note = "couldn't pin a time after two tries; needs a human";
      setCandidateScreen(cand.id, screen);
      return { handled: true, outcome: "needs_human" };
    }
    setCandidateScreen(cand.id, screen);
    const sent = channel === "sms" || cand.phone
      ? await sendSms(desk, cand, "clarify_sms", clarifyText(desk))
      : await sendEmail(desk, cand, "clarify_email", `When works for our call?`, `${clarifyText(desk)}\n\n${desk.persona.agentName}`);
    return { handled: sent, outcome: "clarify" };
  }

  const rebooked = screen.status === "booked";
  const booked = await bookScreenCall(desk, cand, whenUtc, parsed.tz, parsed.tzSource);
  if (!booked) {
    // No live assistant to fire from: keep the human in the loop instead of
    // promising a call we can't place.
    screen.status = "clarify";
    screen.note = "time parsed but the desk isn't live; book by hand";
    screen.scheduledFor = whenUtc;
    screen.timezone = parsed.tz;
    setCandidateScreen(cand.id, screen);
    return { handled: true, outcome: "desk_not_live" };
  }

  const confirmed = cand.phone
    ? await sendSms(desk, cand, "confirm_sms", confirmText(desk, cand, whenUtc, parsed.tz, rebooked))
    : await sendEmail(desk, cand, "confirm_email", `Locked in: our call ${speakWhen(whenUtc, parsed.tz)}`,
        `Hi ${cand.firstName || "there"},\n\n${confirmText(desk, cand, whenUtc, parsed.tz, rebooked)}\n\n${desk.persona.agentName}`);
  void confirmed;
  return { handled: true, outcome: rebooked ? "rebooked" : "booked" };
}

/* ================================================================
   The tick: reminders + settling (rides the resume-inbox cadence)
   ================================================================ */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Same daytime window as the chase ladder: no 3am nudges. */
function inDaytimeWindow(now = new Date()): boolean {
  const h = now.getUTCHours();
  return h >= 13 && h < 24;
}

let tickInFlight: Promise<void> | null = null;
export function runScheduleTick(): Promise<void> {
  if (tickInFlight) return tickInFlight;
  tickInFlight = (async () => {
    await ensureVettingReady();
    const now = Date.now();
    for (const cand of listActiveScheduleCandidates()) {
      try {
        const desk = getDeskById(cand.deskId);
        const screen = cand.screen!;
        if (!desk) continue;

        if (screen.status === "booked") {
          // The engine fired the call at the exact time; once the window has
          // clearly passed, settle the loop (the call record itself lives on
          // the Calls & Scores tab like any other call).
          if (screen.scheduledFor && now - Date.parse(screen.scheduledFor) > 2 * 60 * 60 * 1000) {
            screen.status = "completed";
            setCandidateScreen(cand.id, screen);
          }
          continue;
        }

        // awaiting_reply / clarify: one daytime reminder, then quiet expiry.
        const age = now - Date.parse(screen.askedAt);
        if (age > 6 * DAY_MS) {
          screen.status = "expired";
          screen.note = screen.note || "no reply; gone quiet";
          setCandidateScreen(cand.id, screen);
          continue;
        }
        if (!inDaytimeWindow()) continue;
        if (age > 22 * 60 * 60 * 1000 && !screen.remindedAt) {
          screen.remindedAt = new Date().toISOString();
          setCandidateScreen(cand.id, screen);
          await sendSms(desk, cand, "reminder_sms",
            `Hi ${cand.firstName || "there"}, ${desk.persona.agentName} here. Still holding time for our quick call about the ${desk.roleTitle || "role"}. ` +
            `What day and time works? Reply like "today at 4pm" and I'll call you then.`);
        }
      } catch (e: any) {
        console.error("[vetting] schedule tick failed for candidate", cand.id, e?.message || e);
      }
    }
  })().finally(() => { tickInFlight = null; });
  return tickInFlight;
}
