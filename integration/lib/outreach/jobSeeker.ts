/**
 * RecruitersOS · Outreach · "is this person looking for work themselves?"
 *
 * WHY THIS EXISTS (2026-08-21). We sent a Finance Director a LinkedIn DM
 * offering him candidates for the FP&A Director opening we assumed his team
 * had. He replied: "I don't know where you are getting your data but I am not
 * hiring but I am looking for work."
 *
 * His profile carried LinkedIn's open-to-work flag, and we had already read it:
 * the same `/users/{id}` call the hunt makes returns `is_open_to_work`, and the
 * extractor simply did not keep the field. So the single most disqualifying fact
 * about a BD target was sitting in a response we had already paid for.
 *
 * This is the check that fact now goes through. It is deliberately its own
 * module, not a private helper in the LinkedIn hunt, because the mistake is not
 * LinkedIn-specific: any lane that pitches candidates to a decision-maker has
 * the same failure mode, and each one should be able to ask the same question.
 *
 * NOTE ON WHAT A HIT MEANS. Someone job-hunting is not a bad contact, they are
 * the wrong SIDE of the desk: they are a candidate, not a client. Callers should
 * treat a hit as "route this person to the candidate motion", not as a blocklist
 * entry, and the exclusion should expire, because people get hired.
 */

/**
 * Phrases that mean the author is looking for work, in the register people
 * actually use on a profile.
 *
 * Kept tight on purpose. The costly error here is the FALSE POSITIVE: a real
 * hiring manager whose headline says "hiring a Controller, open to referrals",
 * or a founder "open to new opportunities to partner", would be thrown away by
 * a loose pattern, and a silently discarded good lead is invisible in a way a
 * bad send is not. So every pattern below has to name the SPEAKER as the one
 * seeking work, and generic words like "seeking", "available" or "opportunity"
 * never match on their own.
 */
const SEEKER_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /#?\bopen\s?to\s?work\b/i, why: "says open to work" },
  // "opportunities" counts only when qualified as new/next. Bare "open to
  // opportunities" is genuinely ambiguous - founders write "open to
  // opportunities to partner" - and the selftest pins that it must not match.
  { re: /\bopen\s+to\s+(?:new\s+|next\s+)?(?:roles?|positions?)\b|\bopen\s+to\s+(?:new|next)\s+opportunit(?:y|ies)\b/i, why: "says open to new roles" },
  { re: /\b(?:seeking|searching\s+for|looking\s+for|exploring)\s+(?:my\s+)?(?:a\s+)?(?:new\s+|next\s+|full[-\s]?time\s+|senior\s+)*(?:role|position|opportunity|opportunities|challenge)\b/i, why: "says looking for a role" },
  { re: /\b(?:actively|currently)\s+(?:seeking|looking|interviewing|job\s+hunting)\b/i, why: "says actively looking" },
  { re: /\bin\s+transition\b/i, why: "says in transition" },
  { re: /\bbetween\s+(?:roles|positions|opportunities)\b/i, why: "says between roles" },
  { re: /\bavailable\s+(?:for\s+(?:hire|work|new\s+opportunities)|immediately\s+for)\b/i, why: "says available for hire" },
  { re: /\b(?:recently|newly)\s+(?:laid\s?off|redundant|impacted\s+by\s+(?:a\s+)?(?:layoff|reduction))\b/i, why: "says recently laid off" },
  { re: /\bjob\s?seeker\b/i, why: "says job seeker" },
  { re: /\bunemployed\b/i, why: "says unemployed" },
];

export interface JobSeekerInput {
  /** LinkedIn's own flag (`is_open_to_work` on the Unipile profile). The most
   *  reliable input by far: the person set it themselves, deliberately. */
  openToWorkFlag?: boolean;
  headline?: string;
  summary?: string;
  /** Anything else self-authored, e.g. the post we matched on. */
  extraText?: string;
}

export interface JobSeekerVerdict {
  /** True when this person should NOT receive a client-side pitch. */
  isSeeker: boolean;
  /** Short, loggable, safe to show an operator, e.g. "open-to-work flag". */
  reason?: string;
  /** Which input decided it, so a false positive is traceable to its pattern. */
  source?: "flag" | "headline" | "summary" | "text";
}

/**
 * Is this person job-hunting?
 *
 * The flag is checked first and is authoritative when true; the text patterns
 * exist for the many people who are looking without switching the badge on.
 * A false flag is NOT treated as proof they are employed, because the default is
 * off and most people never touch it, so text is still checked either way.
 */
export function jobSeekerVerdict(input: JobSeekerInput): JobSeekerVerdict {
  if (input.openToWorkFlag === true) {
    return { isSeeker: true, reason: "open-to-work flag set on their profile", source: "flag" };
  }
  const fields: Array<[JobSeekerVerdict["source"], string | undefined]> = [
    ["headline", input.headline],
    ["summary", input.summary],
    ["text", input.extraText],
  ];
  for (const [source, value] of fields) {
    const text = (value || "").trim();
    if (!text) continue;
    for (const p of SEEKER_PATTERNS) {
      if (p.re.test(text)) return { isSeeker: true, reason: `their ${source} ${p.why}`, source };
    }
  }
  return { isSeeker: false };
}

/** Convenience wrapper for gate sites that only need the reason string. */
export function jobSeekerReason(input: JobSeekerInput): string | null {
  const v = jobSeekerVerdict(input);
  return v.isSeeker ? (v.reason ?? "looking for work") : null;
}
