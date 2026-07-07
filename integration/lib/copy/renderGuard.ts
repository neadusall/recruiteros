/**
 * RecruitersOS · Render guard — the SEND-TIME content fail-safe
 *
 * The last gate before an autopilot email leaves the building. renderTouch merge-fills the
 * approved template with "graceful fallbacks" so previews never crash — but a graceful fallback
 * SENT to a real prospect is exactly the failure the operator fears: "Hi there, saw your team is
 * hiring" reads like a bot and burns the domain. This module inspects the ACTUAL rendered message
 * (plus the token audit renderTouch returns) and answers one question: is every personalization
 * data point real, and does the copy read intact?
 *
 * A failed check does NOT skip the touch — the caller HOLDS the prospect (nothing sends, nothing
 * advances) and records why, so the Send Queue can surface "held by the copy guard" with the exact
 * missing data points. The prospect re-renders on every tick and releases itself the moment the
 * data is fixed. Deterministic and free (no LLM); the Haiku critic (lib/copy/critic) is the
 * optional second pass, wired by the caller via critiqueRendered() below.
 *
 * Checks:
 *   1. missing_data       — a referenced merge token resolved empty, or to a generic fallback
 *                           ("there", "your team", "the seat", "your recent hiring activity", …)
 *   2. unresolved_token   — literal {{...}} survived into the output
 *   3. spintax_remnant    — a {a|b} group or stray brace survived
 *   4. video_missing      — the 2nd email talks about a video but carries no link
 *   5. bad_link           — a video/watch link is present but not a well-formed https URL
 *   5b. unlinked_image    — an <img> (the video thumbnail) is not wrapped in a clickable link
 *   6. empty_subject      — an email with no subject line
 *   7. body_too_short     — under ~25 chars of real text (a template that collapsed)
 *   8. broken_grammar     — debris a dropped value leaves behind ("Hi ,", " in .", double spaces)
 *   9. guardrail          — the house-voice scanner (hollow openers, fabricated referrals,
 *                           emoji/hashtags/dashes) on the tag-stripped text
 *
 * Tokens that are ALLOWED to be empty: RENDER_GUARD_OPTIONAL_TOKENS (csv, default "videoposter").
 * Fallbacks that are ALLOWED to send: RENDER_GUARD_ALLOW_FALLBACK (csv of token names, default none).
 */

import { scanMessage } from "./guardrail";
import { hasDash } from "../text/dashes";

export interface GuardHold { check: string; detail: string }
export interface GuardVerdict { ok: boolean; holds: GuardHold[] }

export interface GuardInput {
  channel: string;               // "email" | "linkedin" | "voice"
  emailStep?: number;            // 1 = first email, 2 = the video email
  subject?: string;
  body: string;
  /** renderTouch's token audit: referenced token (lowercase) -> resolved value. */
  tokens: Record<string, string>;
  /** A real referral source is attached (lets referral language pass the scanner). */
  hasRealReferralSource?: boolean;
}

/** The generic values renderTouch/buildMpcTokens fall back to when the real data point is absent.
 *  Any of these reaching a rendered message means the personalization data was missing. */
const FALLBACK_VALUES: Record<string, string[]> = {
  firstname: ["there"],
  first_name: ["there"],
  company: ["your team"],
  title: ["your role"],
  role: ["the role you're hiring for", "the seat"],
  signal: ["your recent hiring activity"],
  open_role: ["the seat"],
  a_open_role: ["the seat"],
  job_title: ["the seat"],
  a_job_title: ["the seat"],
};

function csvEnv(name: string, dflt: string): Set<string> {
  return new Set(
    String(process.env[name] ?? dflt)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Strip HTML down to the words a human reads (tags/attributes out, ▶ glyph out), so the
 *  house-voice scanner never trips on style attributes or the video embed markup. */
export function visibleText(s: string): string {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/[▶►]/g, " ")
    .replace(/[ \t]{2,}/g, " ");
}

/** Inspect one rendered touch. Pure + deterministic — same input, same verdict. */
export function guardRenderedTouch(input: GuardInput): GuardVerdict {
  const holds: GuardHold[] = [];
  const optional = csvEnv("RENDER_GUARD_OPTIONAL_TOKENS", "videoposter");
  const allowFallback = csvEnv("RENDER_GUARD_ALLOW_FALLBACK", "");
  const body = input.body || "";
  const subject = input.subject || "";
  const whole = subject + "\n" + body;

  // 1. Every referenced data point is real.
  for (const [token, value] of Object.entries(input.tokens || {})) {
    if (optional.has(token)) continue;
    const v = (value || "").trim();
    if (!v) { holds.push({ check: "missing_data", detail: `{{${token}}} is empty` }); continue; }
    if (allowFallback.has(token)) continue;
    const fallbacks = FALLBACK_VALUES[token];
    if (fallbacks && fallbacks.some((f) => v.toLowerCase() === f)) {
      holds.push({ check: "missing_data", detail: `{{${token}}} fell back to the generic "${v}"` });
    }
  }

  // 2–3. Nothing structural survived into the output.
  const unresolved = whole.match(/\{\{[^{}]*\}\}/);
  if (unresolved) holds.push({ check: "unresolved_token", detail: unresolved[0] });
  const spin = whole.match(/\{[^{}]*\|[^{}]*\}/);
  if (spin) holds.push({ check: "spintax_remnant", detail: spin[0].slice(0, 60) });
  else if (/[{}]/.test(visibleText(whole))) holds.push({ check: "spintax_remnant", detail: "stray { or } in copy" });

  // 4–5. The video email really carries its video.
  const text = visibleText(body);
  const links = body.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  if (input.channel === "email" && input.emailStep === 2) {
    if (/\bvideo\b/i.test(text) && links.length === 0) {
      holds.push({ check: "video_missing", detail: "the copy mentions a video but no video link is attached" });
    }
  }
  for (const l of links) {
    if (!/^https:\/\/[^\s]+\.[^\s]+/.test(l)) holds.push({ check: "bad_link", detail: l.slice(0, 80) });
  }
  // 5b. Every image is CLICKABLE — the video thumbnail must never render as a dead picture. An
  //     <img> only passes when it sits inside a still-open <a> (the Loom-style embed wraps the
  //     thumbnail in the watch link).
  for (let at = body.indexOf("<img"); at !== -1; at = body.indexOf("<img", at + 4)) {
    const before = body.slice(0, at);
    if (before.lastIndexOf("<a ") <= before.lastIndexOf("</a>")) {
      holds.push({ check: "unlinked_image", detail: "an image is not wrapped in a clickable link" });
      break;
    }
  }

  // 6–7. It is a sendable email at all.
  if (input.channel === "email" && !subject.trim()) holds.push({ check: "empty_subject", detail: "email has no subject" });
  if (text.replace(/\s+/g, " ").trim().length < 25) holds.push({ check: "body_too_short", detail: "body under 25 characters" });

  // 8. Debris from a value that vanished ("Hi ,", "in .", "()"). Empty-token holes are already
  //    holds via check 1; these catch the same class arriving from any other direction.
  const debris = /\b(?:hi|hey|hello)\s+[,.]/i.test(text)
    ? "greeting with no name"
    : /\s[,.;:](?:\s|$)/.test(text)
      ? "orphaned punctuation"
      : /\(\s*\)/.test(text)
        ? "empty parentheses"
        : "";
  if (debris) holds.push({ check: "broken_grammar", detail: debris });

  // 9. House voice (on what the recipient actually reads, not the markup). The dash rule applies
  //    to the TEMPLATE's own words — a dash arriving inside a merge VALUE is data, not voice
  //    (a company named "Coca-Cola" or a city like "Winston-Salem" must never hold a send), so a
  //    dash violation only stands if dashes remain after masking every token value out of the text.
  const scan = scanMessage(
    { subject: visibleText(subject), body: text },
    { hasRealReferralSource: input.hasRealReferralSource },
  );
  const masked = Object.values(input.tokens || {})
    .filter(Boolean)
    .reduce((t, v) => t.split(v).join(" "), visibleText(subject) + "\n" + text);
  for (const v of scan.violations) {
    if (v.rule === "dash" && !hasDash(masked)) continue;
    holds.push({ check: "guardrail", detail: `${v.why}${v.match && v.match !== "—/–/-" ? ` ("${v.match}")` : ""}` });
  }

  return { ok: holds.length === 0, holds };
}

/** One line per hold, for the prospect's copyHold record + logs. */
export function describeHolds(holds: GuardHold[]): string[] {
  return holds.map((h) => `${h.check}: ${h.detail}`);
}

/* ---------------- optional second pass: the Haiku critic, cached ---------------- */

/** Because autopilot copy is an approved template merge-filled per prospect, near-identical bodies
 *  recur constantly — cache verdicts by content hash so the critic is paid once per surface form,
 *  not once per send. Fail-open by design (see lib/copy/critic). */
const criticCache = new Map<string, { pass: boolean; issues: string[] }>();
const CRITIC_CACHE_MAX = 4000;

function hashOf(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function criticEnabled(): boolean {
  return process.env.AUTOPILOT_CRITIC === "1";
}

/** Judge a rendered email with the Haiku critic (AUTOPILOT_CRITIC=1). Returns null on pass/skip,
 *  or the holds when the critic says the copy reads wrong. */
export async function critiqueRendered(subject: string | undefined, body: string): Promise<GuardHold[] | null> {
  if (!criticEnabled()) return null;
  const textToJudge = [visibleText(subject || ""), visibleText(body)].filter(Boolean).join("\n");
  const key = hashOf(textToJudge);
  const cached = criticCache.get(key);
  if (cached) return cached.pass ? null : cached.issues.map((i) => ({ check: "critic", detail: i }));
  const { critique } = await import("./critic");
  const c = await critique(textToJudge, { channel: "email" });
  if (c.skipped) return null; // fail-open: an infra outage never blocks sends
  if (criticCache.size >= CRITIC_CACHE_MAX) criticCache.clear();
  criticCache.set(key, { pass: c.pass, issues: c.issues });
  return c.pass ? null : c.issues.map((i) => ({ check: "critic", detail: i }));
}
