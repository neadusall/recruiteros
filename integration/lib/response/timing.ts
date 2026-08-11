/**
 * RecruitersOS · Response · timing-objection parsing
 *
 * "Not now, try me in Q4" is a future YES, not a no. The classifier captures the
 * timing phrase; this turns it into a concrete date so one click schedules the
 * comeback (a snooze that resurfaces the thread on top when the window opens).
 * Heuristics only, deliberately conservative: unknown phrasing returns null and
 * the recruiter picks a snooze by hand.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Parse a captured timing phrase to a resurface date, or null when unclear. */
export function timingToDate(timing: string | undefined | null, from: Date = new Date()): Date | null {
  if (!timing) return null;
  const t = timing.toLowerCase();
  const day = 24 * 3600_000;

  // "in 3 weeks", "in 2 months", "in 30 days"
  const rel = t.match(/in\s+(\d{1,2})\s*(day|week|month)/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2] === "day" ? 1 : rel[2] === "week" ? 7 : 30;
    return new Date(from.getTime() + n * unit * day);
  }
  if (/next week/.test(t)) return new Date(from.getTime() + 7 * day);
  if (/next month/.test(t)) return new Date(from.getFullYear(), from.getMonth() + 1, 3);
  if (/next quarter/.test(t)) {
    const q = Math.floor(from.getMonth() / 3) + 1;
    return new Date(from.getFullYear() + (q > 3 ? 1 : 0), (q % 4) * 3, 3);
  }
  if (/next year/.test(t)) return new Date(from.getFullYear() + 1, 0, 6);
  // "Q1".."Q4": the next time that quarter starts.
  const q = t.match(/\bq([1-4])\b/);
  if (q) {
    const month = (parseInt(q[1], 10) - 1) * 3;
    const cand = new Date(from.getFullYear(), month, 3);
    return cand > from ? cand : new Date(from.getFullYear() + 1, month, 3);
  }
  // A month by name: the next 1st-ish of that month.
  for (let i = 0; i < MONTHS.length; i++) {
    if (t.includes(MONTHS[i]) || t.includes(MONTHS[i].slice(0, 3) + " ")) {
      const cand = new Date(from.getFullYear(), i, 3);
      return cand > from ? cand : new Date(from.getFullYear() + 1, i, 3);
    }
  }
  if (/after (the )?summer|end of summer|fall|autumn/.test(t)) {
    const cand = new Date(from.getFullYear(), 8, 3); // early September
    return cand > from ? cand : new Date(from.getFullYear() + 1, 8, 3);
  }
  if (/end of (the )?year|after the holidays|new year/.test(t)) {
    const cand = new Date(from.getFullYear() + (from.getMonth() >= 11 ? 1 : 0), from.getMonth() >= 11 ? 0 : 11, 3);
    return cand;
  }
  if (/few weeks|couple (of )?weeks/.test(t)) return new Date(from.getTime() + 14 * day);
  if (/few months|couple (of )?months/.test(t)) return new Date(from.getTime() + 60 * day);
  return null;
}
