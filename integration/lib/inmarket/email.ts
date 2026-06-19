/**
 * RecruitersOS · In-Market · Free email-pattern model
 *
 * Given a person's first name, last name, and the company's domain (or website URL), build
 * the most-likely work email — plus a ranked set of alternates — using the standard corporate
 * email-format conventions. FREE + deterministic: no network, no key, runs on every lead so a
 * recruiter sees a probable address before spending anything.
 *
 * IMPORTANT: this is a SYNTAX guess, never a verified address. The confidence is low by design
 * and the value is always flagged unverified — every email is sent for validation before any
 * outreach (the cheap-first waterfall's verifier supersedes this guess on promote). The goal is
 * a tight, well-formed best-guess that the verifier confirms or corrects, not a deliverability
 * claim.
 *
 * Best-practice syntax handled:
 *   - Unicode-fold accents (José → jose), strip apostrophes/periods (O'Brien → obrien),
 *     collapse hyphens (María-José → mariajose), drop everything but [a-z0-9].
 *   - Multi-word surnames keep the LAST token ("van der Berg" → "berg") for the dotted forms
 *     and the full join for the concatenated forms — both are emitted as alternates.
 *   - Patterns are ordered by real-world prevalence so `email` is the single best guess and
 *     `alternates` are the fallbacks a verifier should try next.
 */

import { domainRoot } from "../signals/hiring/normalize";

/* ------------------------------------------------------------------ */
/* Name + domain normalization                                         */
/* ------------------------------------------------------------------ */

/** Fold accents, lowercase, strip everything but a-z0-9. "José-Pérez" → "joseperez". */
export function normalizeNamePart(s: string | undefined | null): string {
  if (!s) return "";
  return String(s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/['’`.]/g, "")        // O'Brien → obrien, J.R. → jr
    .replace(/[^a-z0-9]+/g, "")    // collapse spaces, hyphens, punctuation
    .trim();
}

/** The dotted-form surname token: last whitespace/hyphen-separated piece of a compound name.
 *  "van der Berg" → "berg"; "Smith-Jones" → "jones". Falls back to the whole normalized name. */
function lastToken(last: string | undefined | null): string {
  if (!last) return "";
  const parts = String(last).trim().split(/[\s-]+/).filter(Boolean);
  return normalizeNamePart(parts[parts.length - 1] ?? last);
}

/**
 * Resolve a clean email domain from a company website URL or a bare domain. Reuses the engine's
 * registrable-root logic, then re-attaches the public suffix. "https://careers.acme.co/jobs" →
 * "acme.co"; "Acme, Inc." with no URL → "" (caller decides whether to guess a .com).
 */
export function emailDomainFrom(urlOrDomain: string | undefined | null): string {
  if (!urlOrDomain) return "";
  let host = String(urlOrDomain).trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
  // A real host has a dot; if there's none we were handed a company NAME, not a domain.
  if (!host.includes(".")) return "";
  const root = domainRoot(host);
  if (!root) return "";
  // Re-attach the public suffix (everything after the registrable label in the original host).
  const idx = host.indexOf(root + ".");
  if (idx >= 0) return host.slice(idx);
  // Root was the leading label (e.g. "acme.com" → root "acme") → return host as-is.
  return host;
}

/* ------------------------------------------------------------------ */
/* Pattern catalog (ordered by real-world prevalence)                  */
/* ------------------------------------------------------------------ */

/** A corporate email LOCAL-PART format. `{f}`/`{l}` = first/last initial, `{first}`/`{last}` =
 *  normalized parts ({last} = dotted-form surname token), `{lastFull}` = full multi-word surname
 *  joined. Ordered by real-world prevalence so `email` is the best single guess and `alternates`
 *  are the exact fallback set a verifier should walk, highest-probability first. */
export interface EmailPattern { id: string; label: string; build: (p: Parts) => string }
interface Parts { first: string; last: string; lastFull: string; f: string; l: string }

export const EMAIL_PATTERNS: EmailPattern[] = [
  // ── Full first + full last (the dominant corporate family) ──
  { id: "first.last",  label: "first.last",  build: (p) => p.first && p.last ? `${p.first}.${p.last}` : "" },          // john.smith
  { id: "firstlast",   label: "firstlast",   build: (p) => p.first && p.lastFull ? `${p.first}${p.lastFull}` : "" },   // johnsmith
  { id: "first_last",  label: "first_last",  build: (p) => p.first && p.last ? `${p.first}_${p.last}` : "" },          // john_smith
  { id: "first-last",  label: "first-last",  build: (p) => p.first && p.last ? `${p.first}-${p.last}` : "" },          // john-smith
  // ── First-initial + last (the second-biggest family) ──
  { id: "flast",       label: "flast",       build: (p) => p.f && p.last ? `${p.f}${p.last}` : "" },                   // jsmith
  { id: "f.last",      label: "f.last",      build: (p) => p.f && p.last ? `${p.f}.${p.last}` : "" },                  // j.smith
  { id: "f_last",      label: "f_last",      build: (p) => p.f && p.last ? `${p.f}_${p.last}` : "" },                  // j_smith
  { id: "f-last",      label: "f-last",      build: (p) => p.f && p.last ? `${p.f}-${p.last}` : "" },                  // j-smith
  // ── First + last-initial ──
  { id: "firstl",      label: "firstl",      build: (p) => p.first && p.l ? `${p.first}${p.l}` : "" },                 // johns
  { id: "first.l",     label: "first.l",     build: (p) => p.first && p.l ? `${p.first}.${p.l}` : "" },               // john.s
  { id: "first_l",     label: "first_l",     build: (p) => p.first && p.l ? `${p.first}_${p.l}` : "" },               // john_s
  // ── First name only (common at startups / small domains) ──
  { id: "first",       label: "first",       build: (p) => p.first },                                                 // john
  // ── Last-first family ──
  { id: "last.first",  label: "last.first",  build: (p) => p.last && p.first ? `${p.last}.${p.first}` : "" },         // smith.john
  { id: "lastfirst",   label: "lastfirst",   build: (p) => p.lastFull && p.first ? `${p.lastFull}${p.first}` : "" },  // smithjohn
  { id: "last_first",  label: "last_first",  build: (p) => p.last && p.first ? `${p.last}_${p.first}` : "" },         // smith_john
  { id: "lastf",       label: "lastf",       build: (p) => p.last && p.f ? `${p.last}${p.f}` : "" },                  // smithj
  { id: "last.f",      label: "last.f",      build: (p) => p.last && p.f ? `${p.last}.${p.f}` : "" },                 // smith.j
  // ── Last name only ──
  { id: "last",        label: "last",        build: (p) => p.lastFull },                                              // smith
  // ── Both initials (rare, tiny domains) ──
  { id: "fl",          label: "fl",          build: (p) => p.f && p.l ? `${p.f}${p.l}` : "" },                        // js
  { id: "f.l",         label: "f.l",         build: (p) => p.f && p.l ? `${p.f}.${p.l}` : "" },                       // j.s
];

/**
 * Rough prevalence weights for the LEADING guess's confidence (US/EU corporate domains, from
 * published email-format distributions). Only the head of the distribution carries meaningful
 * weight; everything else falls through to a low floor. Deliberately conservative — this is a
 * syntax guess the verifier confirms, never a deliverability claim.
 */
const PATTERN_CONFIDENCE: Record<string, number> = {
  "first.last": 0.43, "flast": 0.21, "firstlast": 0.11, "first": 0.07,
  "first_last": 0.05, "f.last": 0.04, "firstl": 0.03, "first.l": 0.03,
  "last.first": 0.02, "lastfirst": 0.02,
};

/* ------------------------------------------------------------------ */
/* The guesser                                                         */
/* ------------------------------------------------------------------ */

export interface EmailGuess {
  /** The single most-likely address, e.g. "jane.smith@acme.com". Empty when unguessable. */
  email: string;
  /** The pattern id used for `email` (e.g. "first.last"). */
  pattern: string;
  /** Ranked fallback addresses a verifier should try next (excludes `email`). */
  alternates: string[];
  /** 0..1 — deliberately modest; this is a syntax guess, not a verified address. */
  confidence: number;
  /** Always false here — set true only once a verifier confirms it. */
  verified: false;
  /** The domain used. */
  domain: string;
}

/**
 * Build the best-guess work email + ranked alternates. Requires a first name and a real domain;
 * returns an empty guess (email: "") when either is missing — we never fabricate a domain from a
 * company name here, because a wrong domain produces a confidently-wrong address (the caller can
 * opt to pass a resolved domain from the contact waterfall instead).
 */
export function guessEmail(
  firstName: string | undefined | null,
  lastName: string | undefined | null,
  urlOrDomain: string | undefined | null,
): EmailGuess {
  const domain = emailDomainFrom(urlOrDomain);
  const first = normalizeNamePart(firstName);
  const last = lastToken(lastName);
  const lastFull = normalizeNamePart(lastName);
  const empty: EmailGuess = { email: "", pattern: "", alternates: [], confidence: 0, verified: false, domain };
  if (!domain || !first) return empty;

  const parts: Parts = { first, last, lastFull, f: first[0] ?? "", l: last[0] ?? "" };
  const seen = new Set<string>();
  const addrs: Array<{ id: string; email: string }> = [];
  for (const p of EMAIL_PATTERNS) {
    const local = p.build(parts);
    if (!local) continue;
    const email = `${local}@${domain}`;
    if (seen.has(email)) continue;
    seen.add(email);
    addrs.push({ id: p.id, email });
  }
  if (!addrs.length) return empty;

  // With no surname, "first@" is the only sensible guess; otherwise lead with first.last.
  const top = addrs[0];
  const confidence = last
    ? (PATTERN_CONFIDENCE[top.id] ?? 0.15)
    : 0.1; // first-name-only is a weak guess
  return {
    email: top.email,
    pattern: top.id,
    alternates: addrs.slice(1).map((a) => a.email),
    confidence,
    verified: false,
    domain,
  };
}

/**
 * The FULL ordered list of candidate addresses for a name + domain, highest-probability first
 * and de-duplicated — exactly what an email verifier should walk top-to-bottom, stopping at the
 * first that validates. Returns [] when first name or domain is missing. This is the money-saver:
 * a well-ordered permutation set means the verifier confirms on an early try instead of brute-
 * forcing, and we never pay to verify a malformed address.
 */
export function emailPermutations(
  firstName: string | undefined | null,
  lastName: string | undefined | null,
  urlOrDomain: string | undefined | null,
): Array<{ email: string; pattern: string }> {
  const g = guessEmail(firstName, lastName, urlOrDomain);
  if (!g.email) return [];
  return [{ email: g.email, pattern: g.pattern }, ...g.alternates.map((email) => ({ email, pattern: "" }))];
}

/** Split a "First Last" full name into parts (mirrors splitName but local to avoid the import
 *  cycle through the hiring submodule). Multi-word: first token + remainder as the surname. */
export function splitFullName(full: string | undefined | null): { firstName?: string; lastName?: string } {
  if (!full) return {};
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Convenience: guess from a full name + domain in one call. */
export function guessEmailFromFullName(
  fullName: string | undefined | null,
  urlOrDomain: string | undefined | null,
): EmailGuess {
  const { firstName, lastName } = splitFullName(fullName);
  return guessEmail(firstName, lastName, urlOrDomain);
}
