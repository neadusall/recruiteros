/**
 * RecruitersOS · Outreach · "do they actually still work there?"
 *
 * WHY THIS EXISTS (owner ask 2026-08-21, after the Friedle reply). We pitched a
 * Finance Director on candidates for his team's opening. He answered: "I am not
 * hiring but I am looking for work."
 *
 * The proposal that produced this module was the right one: carry the source we
 * built the claim from, and check the person's CURRENT EMPLOYMENT against it
 * before saying anything about their team.
 *
 * It turned out to be decisive. His profile's most recent role -- Finance
 * Director at Frisella Nursery -- carried an end date of 1 July 2026, six weeks
 * before we messaged him, and NOT ONE of his eleven roles was open-ended. He was
 * provably employed nowhere. That is a stronger and more general signal than the
 * open-to-work badge in [jobSeeker.ts]: the badge is opt-in and most people never
 * touch it, whereas an employment record with no current entry is unambiguous.
 *
 * A HEADLINE IS NOT EMPLOYMENT. This is the trap the whole module exists for.
 * People keep "Finance Director | FP&A, Budgeting & Forecasting Leader" in their
 * headline for months after the job ends, because a headline is a personal brand,
 * not a status field. Every gate we had read the headline. None read the dates.
 *
 * DELIBERATELY SEPARATE FROM jobSeeker.ts. That module asks "have they SAID they
 * are looking"; this one asks "does the record show them employed". Two
 * independent sources of evidence, either sufficient, each testable on its own.
 */

/** One role off a LinkedIn-style work history. Field names match Unipile's. */
export interface WorkEntry {
  company?: string;
  position?: string;
  /** Free-form, e.g. "1/1/2026", "Jan 2026", "2026-01". */
  start?: string;
  /** Absent or empty means the role is current. */
  end?: string;
  status?: string;
}

export interface EmploymentInput {
  /** Their work history, newest first (the order LinkedIn returns). */
  work?: WorkEntry[];
  /** Company we believe they work for, parsed from the headline or the post. */
  claimedCompany?: string;
  /** Now, injectable so the tests are not time-dependent. */
  now?: Date;
}

export type EmploymentStatus =
  /** At least one open-ended role: they are working somewhere. */
  | "employed"
  /** Every role has an end date: they are between jobs. */
  | "not_employed"
  /** No usable history came back. We know nothing and must not pretend to. */
  | "unknown";

export interface EmploymentVerdict {
  status: EmploymentStatus;
  /** Where they work now, when we can tell. */
  currentCompany?: string;
  currentPosition?: string;
  /** When the most recent role ended (ISO date), for "not_employed". */
  lastRoleEndedAt?: string;
  /**
   * True when `claimedCompany` is named in the history but that role has ENDED.
   * This is the stale-headline case, and it is the one worth showing a human:
   * we are about to write to someone about a company they have left.
   */
  leftClaimedCompany?: boolean;
  /** Plain-language, safe to log or show an operator. */
  reason?: string;
}

/**
 * Parse the loose date strings LinkedIn hands back.
 *
 * Returns null rather than guessing. A misparse here would be worse than no
 * parse: it decides whether we believe somebody has a job.
 */
export function parseWorkDate(raw?: string): Date | null {
  const s = (raw || "").trim();
  if (!s) return null;

  // M/D/YYYY or MM/DD/YYYY (what Unipile returned for this profile).
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (slash) return new Date(Date.UTC(+slash[3], +slash[1] - 1, +slash[2]));

  // YYYY-MM or YYYY-MM-DD.
  const iso = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(s);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, iso[3] ? +iso[3] : 1));

  // "Jan 2026" / "January 2026".
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const named = /^([a-z]{3,9})\.?\s+(\d{4})$/i.exec(s);
  if (named) {
    const i = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    if (i >= 0) return new Date(Date.UTC(+named[2], i, 1));
  }

  // Bare year.
  const year = /^(\d{4})$/.exec(s);
  if (year) return new Date(Date.UTC(+year[1], 0, 1));

  return null;
}

/** Loose company-name match: "Acme, Inc." and "Acme Inc" are the same employer. */
export function sameCompany(a?: string, b?: string): boolean {
  const norm = (v?: string) =>
    (v || "")
      .toLowerCase()
      .replace(/[.,]/g, " ")
      .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|group|holdings|plc|gmbh|ab|sa|nv|pty)\b/g, " ")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Prefix matching is done on WHOLE WORDS, not raw characters. Character
  // prefixes make "Acme" match "Acmetric Health", which would have us believe
  // somebody left a company they never worked for. "Northwind" still matches
  // "Northwind Health", which is the case this is actually for.
  const xs = x.split(" "), ys = y.split(" ");
  const shorter = xs.length <= ys.length ? xs : ys;
  const longer = xs.length <= ys.length ? ys : xs;
  return shorter.every((tok, i) => tok === longer[i]);
}

/**
 * Read the work history and say whether this person currently holds a job.
 *
 * "Current" is defined the way LinkedIn models it: a role with no end date.
 * A role marked as ended TODAY still counts as ended, because that is what the
 * person chose to publish about themselves.
 */
export function employmentVerdict(input: EmploymentInput): EmploymentVerdict {
  const work = (input.work ?? []).filter((e) => e && (e.company || e.position));
  if (!work.length) return { status: "unknown", reason: "no work history on their profile" };

  const current = work.filter((e) => !String(e.end || "").trim());
  if (current.length) {
    // Newest-first is LinkedIn's order; the first open-ended entry is the one
    // they present as their job.
    const top = current[0];
    const verdict: EmploymentVerdict = {
      status: "employed",
      currentCompany: top.company,
      currentPosition: top.position,
    };
    if (input.claimedCompany) {
      const matchesNow = current.some((e) => sameCompany(e.company, input.claimedCompany));
      if (!matchesNow) {
        const past = work.find((e) => sameCompany(e.company, input.claimedCompany) && String(e.end || "").trim());
        if (past) {
          verdict.leftClaimedCompany = true;
          verdict.reason = `they left ${past.company} and now work at ${top.company ?? "another company"}`;
        }
      }
    }
    return verdict;
  }

  // Every role has an end date.
  let latest: Date | null = null;
  for (const e of work) {
    const d = parseWorkDate(e.end);
    if (d && (!latest || d > latest)) latest = d;
  }
  const when = latest ? latest.toISOString().slice(0, 10) : undefined;
  return {
    status: "not_employed",
    lastRoleEndedAt: when,
    reason: when
      ? `no current employer on their profile, their last role ended ${when}`
      : "no current employer on their profile",
  };
}

/**
 * Should this person receive a pitch that assumes they have a team to hire for?
 *
 * "unknown" is allowed through ON PURPOSE. Work history is often absent from a
 * profile read, and blocking everyone we cannot verify would quietly delete most
 * of the lane -- a silent collapse in volume is a worse failure than the one
 * being prevented, because nobody notices it. Only a POSITIVE finding blocks.
 */
export function notABuyerReason(v: EmploymentVerdict): string | null {
  if (v.status === "not_employed") return v.reason ?? "no current employer on their profile";
  if (v.leftClaimedCompany) return v.reason ?? "they have left the company we were writing about";
  return null;
}
