/**
 * RecruitersOS · Signal Watchlists · discovery source trial
 *
 * Head to head: does the JOB feed (Hire Signals / JSearch) or the NEWS feed produce a
 * better return on outreach? Both arms feed the same belt, the same curation, the same
 * copy engine and the same mailboxes, so the only thing that differs is WHICH front end
 * put the company in the funnel. That is what makes this a readable experiment rather
 * than two dashboards side by side.
 *
 * The funnel, per arm:
 *
 *   discovered -> named -> contactable -> enrolled -> sent -> opened -> replied
 *
 * The headline metric is REPLY RATE ON SENDS. Reply per send is the honest measure of
 * "return on outreach": it is unaffected by one arm simply discovering more companies,
 * which is a volume question, not a quality one. Volume is reported separately, because
 * an arm that finds ten times as many companies at the same reply rate is still worth
 * far more, and the pair of numbers is what actually decides where to spend.
 *
 * WHY THIS MODULE EXISTS RATHER THAN A COUNT IN THE UI: the difference between a 3.5%
 * and a 4.5% reply rate is invisible until you have hundreds of sends per arm, and the
 * temptation on day three is to call it off 40 sends and 2 replies. So every verdict
 * here carries a significance test and, when the answer is "not yet", the actual number
 * of sends still needed. `insufficient_data` is a first-class, expected answer.
 */

import type { CuratedProspect } from "../../inmarket/curation";

export type Arm = "jobs" | "news";
export const ARMS: Arm[] = ["jobs", "news"];

/** Recruiter-facing labels. "Hire Signals" is what the job arm is called in the product. */
export const ARM_LABEL: Record<Arm, string> = {
  jobs: "Hire Signals (job feed)",
  news: "News signals (funding, exec, expansion)",
};

/* ------------------------------------------------------------------ */
/* Funnel                                                              */
/* ------------------------------------------------------------------ */

export interface ArmFunnel {
  arm: Arm;
  label: string;
  /** Companies (distinct) this arm put into the funnel. */
  companies: number;
  /** Curated prospect rows, i.e. decision-makers researched. */
  prospects: number;
  named: number;
  contactable: number;
  enrolled: number;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
  /* ---- the rates that matter ---- */
  /** replied / sent. THE headline metric. */
  replyRatePct: number;
  /** opened / sent. */
  openRatePct: number;
  /** bounced / sent. A high-bounce arm is buying its reply rate with domain damage. */
  bounceRatePct: number;
  /** contactable / prospects. How much of what it finds is even reachable. */
  contactableRatePct: number;
  /** replied / companies. Yield per company discovered, the volume-inclusive view. */
  repliesPerHundredCompanies: number;
}

function pct(n: number, d: number): number {
  return d > 0 ? Number(((n / d) * 100).toFixed(2)) : 0;
}

function emptyFunnel(arm: Arm): ArmFunnel {
  return {
    arm, label: ARM_LABEL[arm],
    companies: 0, prospects: 0, named: 0, contactable: 0,
    enrolled: 0, sent: 0, opened: 0, replied: 0, bounced: 0,
    replyRatePct: 0, openRatePct: 0, bounceRatePct: 0, contactableRatePct: 0,
    repliesPerHundredCompanies: 0,
  };
}

/** Rows in the trial window, per arm. Unattributed rows are excluded by design. */
export function funnelFor(rows: CuratedProspect[], arm: Arm): ArmFunnel {
  const f = emptyFunnel(arm);
  const companies = new Set<string>();
  for (const r of rows) {
    if (r.discoverySource !== arm) continue;
    companies.add(r.company.trim().toLowerCase());
    f.prospects++;
    if (r.managerName) f.named++;
    if (r.status === "contactable" || r.likelyEmail) f.contactable++;
    if (r.enrolledAt) f.enrolled++;
    if (r.sentAt) f.sent++;
    if (r.openedAt) f.opened++;
    if (r.repliedAt) f.replied++;
    if (r.bouncedAt) f.bounced++;
  }
  f.companies = companies.size;
  f.replyRatePct = pct(f.replied, f.sent);
  f.openRatePct = pct(f.opened, f.sent);
  f.bounceRatePct = pct(f.bounced, f.sent);
  f.contactableRatePct = pct(f.contactable, f.prospects);
  f.repliesPerHundredCompanies = f.companies > 0 ? Number(((f.replied / f.companies) * 100).toFixed(2)) : 0;
  return f;
}

/* ------------------------------------------------------------------ */
/* Significance: the part that stops a coin flip becoming a decision   */
/* ------------------------------------------------------------------ */

/** Normal CDF (Abramowitz and Stegun 26.2.17). Enough precision for a p-value. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export interface SignificanceResult {
  /** Two-proportion z statistic on reply rate. */
  z: number;
  /** Two-sided p-value. */
  p: number;
  /** True when p < 0.05 AND both arms cleared the minimum sample. */
  significant: boolean;
  /** Absolute difference in reply rate, percentage points (news minus jobs). */
  liftPp: number;
  /** Relative lift, percent. */
  liftRelPct: number;
}

/**
 * Two-proportion z-test on replies/sends. Not a Bayesian model and not trying to be:
 * the question is binary (is this difference distinguishable from noise?) and this is
 * the standard tool for it.
 */
export function significance(a: ArmFunnel, b: ArmFunnel, minSends = 0): SignificanceResult {
  const n1 = a.sent, n2 = b.sent, x1 = a.replied, x2 = b.replied;
  const none: SignificanceResult = { z: 0, p: 1, significant: false, liftPp: 0, liftRelPct: 0 };
  if (n1 <= 0 || n2 <= 0) return none;

  const p1 = x1 / n1, p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se > 0 ? (p2 - p1) / se : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return {
    z: Number(z.toFixed(3)),
    p: Number(p.toFixed(4)),
    significant: p < 0.05 && n1 >= minSends && n2 >= minSends,
    liftPp: Number(((p2 - p1) * 100).toFixed(2)),
    liftRelPct: p1 > 0 ? Number((((p2 - p1) / p1) * 100).toFixed(1)) : 0,
  };
}

/**
 * Sends per arm needed to detect a given difference at 80% power, alpha 0.05 two-sided.
 * This is the number that keeps the trial honest: at a 3.5% baseline, telling apart a
 * 3.5% and a 5% arm takes roughly 2,800 sends PER ARM. Detecting a doubling takes about
 * 640. Knowing which of those the desk can actually reach decides whether this trial can
 * conclude in a week or a quarter.
 */
export function requiredSendsPerArm(baselineRate: number, targetRate: number): number {
  const p1 = Math.min(Math.max(baselineRate, 1e-6), 0.999);
  const p2 = Math.min(Math.max(targetRate, 1e-6), 0.999);
  const delta = Math.abs(p2 - p1);
  if (delta < 1e-9) return Infinity;
  const zA = 1.959963985, zB = 0.8416212336;   // alpha 0.05 two-sided, power 0.80
  const pBar = (p1 + p2) / 2;
  const term1 = zA * Math.sqrt(2 * pBar * (1 - pBar));
  const term2 = zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil(((term1 + term2) ** 2) / (delta ** 2));
}

/**
 * The smallest reply-rate difference the trial can currently resolve, given the sends
 * each arm actually has. Answers "what would we even be able to see with this data?"
 * Returned in percentage points; Infinity when an arm has no sends yet.
 */
export function detectableLiftPp(a: ArmFunnel, b: ArmFunnel, baselineRate: number): number {
  const n = Math.min(a.sent, b.sent);
  if (n <= 0) return Infinity;
  const p = Math.min(Math.max(baselineRate, 1e-6), 0.999);
  const zA = 1.959963985, zB = 0.8416212336;
  // Solve the sample-size formula for delta, approximating both arms at the baseline.
  const delta = (zA + zB) * Math.sqrt(2 * p * (1 - p) / n);
  return Number((delta * 100).toFixed(2));
}

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

export type Verdict = Arm | "tie" | "insufficient_data";

export interface TrialReport {
  from?: string;
  to?: string;
  arms: Record<Arm, ArmFunnel>;
  significance: SignificanceResult;
  verdict: Verdict;
  /** Plain-English statement of where the trial stands. Safe to show a recruiter. */
  readout: string;
  /** Sends still needed PER ARM to resolve the difference currently being observed. */
  sendsStillNeededPerArm: number | null;
  /** Smallest difference the current sample could resolve, percentage points. */
  detectableLiftPp: number;
  /** Rows that carry no attribution, so are in neither arm. High = the trial is blind. */
  unattributedProspects: number;
  /** True once both arms have enough sends for the verdict to mean anything. */
  readable: boolean;
  warnings: string[];
}

export interface TrialOptions {
  /** ISO date to start counting from, e.g. the Monday the trial opened. */
  from?: string;
  to?: string;
  /** Minimum sends per arm before any verdict other than insufficient_data. */
  minSendsPerArm?: number;
  /** Expected baseline reply rate (0..1) used for the power maths. 2026 cold-email
   *  average is 3.4 to 3.7 percent, so 3.5 is the honest default. */
  baselineRate?: number;
  /** Warn when one arm has this many times the other's sends. */
  imbalanceFactor?: number;
}

function inWindow(r: CuratedProspect, from?: number, to?: number): boolean {
  if (from === undefined && to === undefined) return true;
  // Window on DISCOVERY, not on send: it is the arm's intake being compared, and a row
  // discovered inside the window but sent after it still belongs to this trial.
  const at = Date.parse(r.discoveredAt || r.curatedAt || "");
  if (!Number.isFinite(at)) return false;
  if (from !== undefined && at < from) return false;
  if (to !== undefined && at > to) return false;
  return true;
}

/**
 * Compare the two discovery arms. Deliberately conservative: it reports
 * `insufficient_data` until both arms clear the sample floor AND the difference clears
 * significance, and it says how far off that is rather than leaving a number to be
 * misread as a result.
 */
export function compareArms(all: CuratedProspect[], opts: TrialOptions = {}): TrialReport {
  const minSends = Math.max(0, Math.round(opts.minSendsPerArm ?? 200));
  const baseline = opts.baselineRate ?? 0.035;
  const imbalanceFactor = opts.imbalanceFactor ?? 3;

  const from = opts.from ? Date.parse(opts.from) : undefined;
  const to = opts.to ? Date.parse(opts.to) : undefined;
  const rows = all.filter((r) => inWindow(r, from, to));

  const arms: Record<Arm, ArmFunnel> = {
    jobs: funnelFor(rows, "jobs"),
    news: funnelFor(rows, "news"),
  };
  const sig = significance(arms.jobs, arms.news, minSends);
  const unattributed = rows.filter((r) => !r.discoverySource).length;

  const warnings: string[] = [];
  if (unattributed > 0) {
    warnings.push(
      `${unattributed} prospect rows carry no discovery attribution and are in neither arm. ` +
      `Rows created before the trial shipped will never be attributed; only rows curated from a watchlist after that count.`,
    );
  }
  const lo = Math.min(arms.jobs.sent, arms.news.sent);
  const hi = Math.max(arms.jobs.sent, arms.news.sent);
  if (lo > 0 && hi >= lo * imbalanceFactor) {
    const heavier = arms.jobs.sent > arms.news.sent ? "jobs" : "news";
    warnings.push(
      `Volume is lopsided: ${ARM_LABEL[heavier as Arm]} has ${hi} sends against ${lo}. ` +
      `The reply-rate comparison still holds, but the smaller arm decides how soon this can conclude.`,
    );
  }
  for (const arm of ARMS) {
    if (arms[arm].sent > 0 && arms[arm].bounceRatePct > 2) {
      warnings.push(`${ARM_LABEL[arm]} is bouncing at ${arms[arm].bounceRatePct}%, above the 2% ceiling. Treat its reply rate as bought with domain risk.`);
    }
  }

  const readable = arms.jobs.sent >= minSends && arms.news.sent >= minSends;
  let verdict: Verdict = "insufficient_data";
  if (readable && sig.significant) verdict = sig.liftPp > 0 ? "news" : "jobs";
  else if (readable && !sig.significant) verdict = "tie";

  // How many more sends per arm would it take to resolve the difference we are actually
  // seeing? If the observed rates are identical there is nothing to resolve.
  let stillNeeded: number | null = null;
  if (verdict !== "news" && verdict !== "jobs") {
    const p1 = arms.jobs.sent ? arms.jobs.replied / arms.jobs.sent : baseline;
    const p2 = arms.news.sent ? arms.news.replied / arms.news.sent : baseline;
    if (Math.abs(p2 - p1) > 1e-9) {
      const need = requiredSendsPerArm(p1, p2);
      stillNeeded = Number.isFinite(need) ? Math.max(0, need - Math.min(arms.jobs.sent, arms.news.sent)) : null;
    }
  }

  const mdl = detectableLiftPp(arms.jobs, arms.news, baseline);
  const readout = buildReadout({ arms, sig, verdict, readable, minSends, stillNeeded, mdl });

  return {
    from: opts.from, to: opts.to,
    arms, significance: sig, verdict, readout,
    sendsStillNeededPerArm: stillNeeded,
    detectableLiftPp: mdl,
    unattributedProspects: unattributed,
    readable,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Per-list: which INDUSTRY is working, not just which arm              */
/* ------------------------------------------------------------------ */
/*
 * compareArms answers "jobs or news". It cannot answer "which vertical", and that is the
 * question a desk actually acts on: turning off a segment that does not produce is a
 * weekly decision, choosing an arm is a one-time one.
 *
 * The trap this is shaped to avoid: reply rate is the WRONG first screen for a vertical.
 * Six segments across two arms is twelve cells, and at a ~3.5% baseline each needs
 * hundreds of sends before it can be told from noise — a quarter of waiting to learn
 * something the upstream funnel reveals in a week. Supply, name rate, contactable rate
 * and bounce rate all converge in days and will kill the weak segments on their own.
 *
 * So every row carries both, and `screenable` marks the ones whose UPSTREAM numbers are
 * already trustworthy while `replyReadable` stays false. Screen on the funnel first;
 * compare reply rate only between the two or three that survive.
 */

export interface ListFunnel extends Omit<ArmFunnel, "arm" | "label"> {
  listId: string;
  /** The arm this list belongs to, so a reader never compares a news list's volume
   *  against a job list's without knowing why they differ by an order of magnitude. */
  arm?: Arm;
  /** True once the row has enough CURATED prospects for its upstream rates (name rate,
   *  contactable rate) to mean something. Reached in days, not months. */
  screenable: boolean;
  /** True once the row has enough SENDS for its reply rate to be worth reading. Most
   *  rows will sit at false for a long time, and that is the honest answer. */
  replyReadable: boolean;
  /** Plain-English verdict safe to show a recruiter. */
  readout: string;
}

export interface ListTrialOptions extends TrialOptions {
  /** Curated prospects needed before the upstream rates are reported as screenable. */
  minProspects?: number;
  /** Sends needed before this row's reply rate is reported as readable. */
  minSends?: number;
  /** listId -> human name, so the report reads as verticals rather than ids. */
  names?: Record<string, string>;
}

/**
 * Funnel per discovery list. Rows with no `discoveryListId` are skipped: they cannot be
 * attributed to a vertical, and inventing a bucket for them would make the weakest
 * segment look like the largest.
 */
export function compareLists(all: CuratedProspect[], opts: ListTrialOptions = {}): ListFunnel[] {
  const minProspects = Math.max(1, Math.round(opts.minProspects ?? 30));
  const minSends = Math.max(1, Math.round(opts.minSends ?? 200));
  const from = opts.from ? Date.parse(opts.from) : undefined;
  const to = opts.to ? Date.parse(opts.to) : undefined;
  const rows = all.filter((r) => inWindow(r, from, to) && r.discoveryListId);

  const byList = new Map<string, CuratedProspect[]>();
  for (const r of rows) {
    const key = r.discoveryListId as string;
    const list = byList.get(key);
    if (list) list.push(r); else byList.set(key, [r]);
  }

  const out: ListFunnel[] = [];
  for (const [listId, listRows] of byList) {
    // A list belongs to exactly one arm, so funnelFor against that arm counts all of it.
    const arm = listRows.find((r) => r.discoverySource)?.discoverySource;
    const f = arm ? funnelFor(listRows, arm) : undefined;
    const base = f ?? emptyFunnel("jobs");
    const { arm: _a, label: _l, ...rest } = base;
    const screenable = rest.prospects >= minProspects;
    const replyReadable = rest.sent >= minSends;
    out.push({
      ...rest,
      listId,
      arm,
      screenable,
      replyReadable,
      readout: listReadout(opts.names?.[listId] || listId, rest, screenable, replyReadable, minProspects, minSends),
    });
  }
  // Most-researched first: the rows with the most evidence behind them lead.
  out.sort((a, b) => b.prospects - a.prospects || b.companies - a.companies);
  return out;
}

function listReadout(
  name: string,
  f: Omit<ArmFunnel, "arm" | "label">,
  screenable: boolean,
  replyReadable: boolean,
  minProspects: number,
  minSends: number,
): string {
  if (!screenable) {
    return `${name}: too early even to screen. ${f.companies} companies, ${f.prospects} researched ` +
      `(need ${minProspects}). Nothing here is a verdict yet.`;
  }
  const upstream =
    `${name}: ${f.companies} companies, ${f.prospects} researched, ` +
    `${f.contactableRatePct}% reachable, ${f.sent} sent`;
  if (!replyReadable) {
    return `${upstream}. Upstream numbers are readable; reply rate is NOT ` +
      `(${f.sent}/${minSends} sends). Screen this vertical on supply and reachability for now.`;
  }
  const bounce = f.bounceRatePct > 2 ? ` Bounce is ${f.bounceRatePct}%, above the 2% ceiling.` : "";
  return `${upstream}, ${f.replyRatePct}% reply (${f.replied}/${f.sent}).${bounce}`;
}

function buildReadout(x: {
  arms: Record<Arm, ArmFunnel>;
  sig: SignificanceResult;
  verdict: Verdict;
  readable: boolean;
  minSends: number;
  stillNeeded: number | null;
  mdl: number;
}): string {
  const j = x.arms.jobs, n = x.arms.news;
  const rates = `Hire Signals ${j.replyRatePct}% (${j.replied}/${j.sent}), news ${n.replyRatePct}% (${n.replied}/${n.sent})`;

  if (!x.readable) {
    const shortfall = ARMS
      .filter((a) => x.arms[a].sent < x.minSends)
      .map((a) => `${ARM_LABEL[a]} needs ${x.minSends - x.arms[a].sent} more`)
      .join("; ");
    return `Too early to call. ${rates}. Floor is ${x.minSends} sends per arm: ${shortfall}. ` +
      `At this sample the smallest difference that could be told from noise is about ${Number.isFinite(x.mdl) ? `${x.mdl} points` : "unmeasurable"}.`;
  }
  if (x.verdict === "news" || x.verdict === "jobs") {
    const w = ARM_LABEL[x.verdict];
    return `${w} is ahead. ${rates}. Difference ${Math.abs(x.sig.liftPp)} points (${Math.abs(x.sig.liftRelPct)}% relative), p=${x.sig.p}, which clears the 0.05 bar.`;
  }
  const more = x.stillNeeded && x.stillNeeded > 0
    ? ` To resolve the gap being observed you would need roughly ${x.stillNeeded} more sends per arm.`
    : "";
  return `No separation yet. ${rates}, p=${x.sig.p}. On this data the two approaches are indistinguishable.${more}`;
}
