/**
 * RecruitersOS · Owner · Which line item a receipt belongs to, and which receipts are the
 * same charge filed twice (OWNER ONLY)
 *
 * A vendor is not a line item. RapidAPI bills five separate listings: JSearch, Real-Time
 * Web Search, Realtime LinkedIn Fresh Data, Fresh LinkedIn Scraper and Skip Tracing, each
 * on its own invoice with its own number, its own date and its own price. Filed by vendor
 * alone they collapse into one "RapidAPI" block worth $433.99 that answers no question
 * anybody actually has, while the five register rows underneath it all read "no receipt".
 * The money is proven and the rows still look unpaid.
 *
 * So this module does two jobs, both pure and both testable without a mailbox:
 *
 *   resolveSpendItem   route ONE charge to the ONE register row it paid for, using what the
 *                      vendor called it on the invoice against what we call it on the row
 *                      (and the RapidAPI host, which is the same name in another spelling).
 *
 *   findDuplicates     find the same charge filed twice. Same vendor, same money, same day
 *                      is the signature: a portal pull and an emailed receipt for one
 *                      charge, or a puller re-run that filed a second copy.
 *
 * THE RULE BOTH OBEY: never guess. A charge that does not clearly belong to a row is left
 * unattached and shows up as "not on the register", which is a true statement about the
 * books. Attaching it to the most expensive row because it had to go somewhere is a false
 * one, and a false one that is very hard to notice later.
 */

import type { SpendItem } from "./spendRegister";

/* ============================ names ============================ */

/**
 * Words that appear in a product name without distinguishing one product from another.
 * "API" is in three of the five RapidAPI listings; the registrable suffixes come from the
 * host (`fresh-linkedin-scraper-api.p.rapidapi.com`), which is the same name written for
 * DNS rather than for a human.
 */
const NOISE = new Set([
  "api", "apis", "the", "a", "an", "of", "for", "and", "plan", "subscription", "sub",
  "p", "rapidapi", "com", "net", "io", "www", "inc", "ltd", "llc",
]);

/** Tokens, lowercased, punctuation treated as a separator, noise words dropped. */
export function nameTokens(s: string): string[] {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t && !NOISE.has(t));
}

/** The same name with every separator removed, for the containment test. */
function squash(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Overlap of two name token sets, 0-1. */
function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter += 1; });
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * How well one charge's own description matches one register row, 0-1.
 *
 * Scored against every name we hold for the row, best wins: our label ("Realtime LinkedIn
 * Fresh Data"), the vendor's own product name when we recorded it, and the RapidAPI host
 * slug, which is the listing name in DNS spelling and often the closest thing we have to
 * what the invoice actually says.
 */
export function nameScore(hint: string, item: SpendItem): number {
  const h = nameTokens(hint);
  if (!h.length) return 0;
  const hSquashed = squash(hint);

  const candidates = [
    item.label,
    item.vendorLabel || "",
    hostSlug(item.link?.rapidHost || ""),
  ].filter(Boolean);

  let best = 0;
  for (const cand of candidates) {
    best = Math.max(best, jaccard(h, nameTokens(cand)));
    /* One name written inside the other ("JSearch" against "JSearch (Ultra)") is a
       stronger signal than token overlap can express, but only when the shorter name is
       long enough that the containment means something. */
    const c = squash(cand);
    if (hSquashed.length >= 4 && c.length >= 4 && (c.includes(hSquashed) || hSquashed.includes(c))) {
      best = Math.max(best, 0.9);
    }
  }
  return best;
}

/** `fresh-linkedin-scraper-api.p.rapidapi.com` -> `fresh linkedin scraper api`. */
function hostSlug(host: string): string {
  return String(host || "").split(".")[0] || "";
}

/* ============================ routing one charge ============================ */

export interface ItemMatch {
  item: SpendItem;
  score: number;
  /** In one line, why this row and not another. Written onto the receipt. */
  matchedBy: string;
}

export interface MatchInput {
  vendor: string;
  /** What the vendor called it: the receipt's description, subject, or line-item label. */
  description?: string;
  /** Any further text the name might be hiding in (email body, invoice excerpt). */
  hay?: string;
  amountUsd?: number;
  /** Billing month, so a row that had not started yet is not offered the charge. */
  period?: string;
}

/** A name has to score at least this well before it is allowed to claim a charge. */
const MIN_SCORE = 0.34;
/** ...and beat the next best by this much, or the two names are too alike to choose. */
const MIN_MARGIN = 0.12;
/** Below MIN_SCORE but still the only thing resembling a match: last resort, and only
 *  when nothing else is close. */
const WEAK_SCORE = 0.25;

/**
 * Route ONE charge to the ONE register row that paid for it.
 *
 * The ladder, strongest signal first:
 *   1. the vendor has a single row (nothing to choose between)
 *   2. the name on the invoice matches one row clearly and the others not
 *   3. the money matches exactly one row's price, and no other row's
 *   4. a weak name match with nothing else near it
 * and otherwise nothing, deliberately: an unattached charge is reported as unregistered
 * spend, which is true, rather than added to whichever row would notice it least.
 */
export function resolveSpendItem(input: MatchInput, items: SpendItem[]): ItemMatch | null {
  const vendor = String(input.vendor || "").toLowerCase();
  if (!vendor) return null;

  let own = items.filter((i) => i.vendor.toLowerCase() === vendor);
  if (!own.length) return null;

  /* A row cannot have been charged before it existed. Applied only when it still leaves
     something to choose from, so a wrong start date narrows the field rather than
     emptying it. */
  if (input.period) {
    const started = own.filter((i) => !i.at || i.at.slice(0, 7) <= input.period!);
    if (started.length) own = started;
  }

  if (own.length === 1) {
    return { item: own[0], score: 1, matchedBy: `${own[0].vendor} has one line on the register` };
  }

  const amount = input.amountUsd != null ? Math.abs(round2(input.amountUsd)) : null;

  /* The line-item label the vendor printed is read ON ITS OWN before anything wider.
     Widening dilutes it: a portal puller writes "downloaded from the vendor portal by
     spend-ledger" into the notes, which is nine words of boilerplate against four words of
     product name, and overlap scoring counts them all. Score the name first, and only fall
     back to the surrounding text when the name alone says nothing. */
  const hints = [input.description, [input.description, input.hay].filter(Boolean).join(" \n ")]
    .map((h) => String(h || "").trim())
    .filter((h, i, a) => h && a.indexOf(h) === i);

  const passes = hints.map((hint) => {
    const scored = own
      .map((item) => ({ item, score: nameScore(hint, item) }))
      .sort((a, b) => b.score - a.score || monthly(b.item) - monthly(a.item));
    return { hint, top: scored[0], next: scored[1] };
  });

  const clear = (p: typeof passes[number], floor: number): boolean =>
    Boolean(p.top && p.top.score >= floor && (!p.next || p.top.score - p.next.score >= MIN_MARGIN));

  for (const p of passes) {
    if (!clear(p, MIN_SCORE)) continue;
    return {
      item: p.top.item,
      score: p.top.score,
      matchedBy: `the invoice names "${short(p.hint)}", which is ${p.top.item.label}`,
    };
  }

  /* The name was ambiguous. Money is the other identifier a charge carries, and it is
     decisive whenever exactly one row is priced at it. */
  if (amount != null && amount > 0) {
    const byAmount = own.filter((i) => i.status === "active" && round2(i.amountUsd) === amount);
    if (byAmount.length === 1) {
      return {
        item: byAmount[0],
        score: Math.max(passes[0]?.top?.score || 0, 0.5),
        matchedBy: `$${amount.toFixed(2)} is the price of ${byAmount[0].label}`,
      };
    }
  }

  for (const p of passes) {
    if (!clear(p, WEAK_SCORE)) continue;
    return {
      item: p.top.item,
      score: p.top.score,
      matchedBy: `"${short(p.hint)}" is closest to ${p.top.item.label}`,
    };
  }

  return null;
}

function monthly(i: SpendItem): number {
  return i.billing === "annual" ? i.amountUsd / 12 : i.billing === "monthly" ? i.amountUsd : 0;
}
function short(s: string): string {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 60);
}
function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }

/* ============================ the same charge, filed twice ============================ */

/** Everything the duplicate test needs, so this stays testable without the vault. */
export interface DupeCandidate {
  id: string;
  vendor: string;
  amountUsd: number;
  chargedAt: string;
  period?: string;
  invoiceNumber?: string;
  itemId?: string;
  description?: string;
  source?: string;
  hasShot?: boolean;
  fileMime?: string;
  reviewed?: boolean;
  createdAt?: string;
}

export interface DuplicateGroup<T extends DupeCandidate = DupeCandidate> {
  /** The copy worth keeping: the one with the vendor's own document behind it. */
  keep: T;
  /** The copies of the same charge that should go. */
  drop: T[];
  reason: string;
}

/**
 * Same vendor, same money, same day. That is one charge, however many rows the vault has
 * for it: the honest failure mode of collecting receipts from three channels at once.
 *
 * Two things stop it eating real spend, and both matter more than catching every duplicate:
 *
 *   different invoice numbers  the vendor issued two documents, so there were two charges.
 *                              A $75 JSearch renewal and a $75 top-up on the same day are
 *                              two charges and the invoice numbers are how you know.
 *   different line items        two listings that happen to cost the same, billed the same
 *                              day, are two charges against two rows.
 *
 * A row that names neither is compatible with anything, which is exactly the case a
 * duplicate is: the second copy of a charge is usually the one with less on it.
 */
export function findDuplicates<T extends DupeCandidate>(receipts: T[]): Array<DuplicateGroup<T>> {
  const buckets = new Map<string, T[]>();
  for (const r of receipts) {
    if (!r || !r.chargedAt) continue;
    const key = [
      String(r.vendor || "").trim().toLowerCase(),
      Math.abs(round2(r.amountUsd)).toFixed(2),
      String(r.chargedAt).slice(0, 10),
    ].join("|");
    buckets.set(key, [...(buckets.get(key) || []), r]);
  }

  const out: Array<DuplicateGroup<T>> = [];
  for (const [, bucket] of buckets) {
    if (bucket.length < 2) continue;

    /* Best copy first, so the keeper of each group is decided before anything is compared
       against it and the outcome does not depend on vault order. */
    const ranked = bucket.slice().sort((a, b) => quality(b) - quality(a) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));

    const groups: Array<{ keep: T; drop: T[] }> = [];
    for (const r of ranked) {
      const g = groups.find((x) => sameCharge(x.keep, r));
      if (g) g.drop.push(r);
      else groups.push({ keep: r, drop: [] });
    }

    for (const g of groups) {
      if (!g.drop.length) continue;
      out.push({
        keep: g.keep,
        drop: g.drop,
        reason: `${g.drop.length + 1} copies of one $${Math.abs(round2(g.keep.amountUsd)).toFixed(2)} charge from ${g.keep.vendor} on ${String(g.keep.chargedAt).slice(0, 10)}`,
      });
    }
  }
  return out.sort((a, b) => String(a.keep.chargedAt).localeCompare(String(b.keep.chargedAt)));
}

/** Two rows in the same vendor/amount/day bucket that are not provably separate charges. */
function sameCharge(a: DupeCandidate, b: DupeCandidate): boolean {
  return compatible(a.invoiceNumber, b.invoiceNumber)
    && compatible(a.itemId, b.itemId)
    && compatible(a.period, b.period);
}

/** Two values agree, or at least one of them says nothing. */
function compatible(a?: string, b?: string): boolean {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  return !x || !y || x === y;
}

/**
 * Which copy of a charge is worth keeping. The vendor's own document outranks everything:
 * it is the thing the whole vault exists to hold, and a figure without one is only a claim
 * about a charge.
 */
function quality(r: DupeCandidate): number {
  let n = 0;
  if (r.fileMime) n += 100;          // the vendor's own file is on disk
  if (r.hasShot) n += 40;            // ...and it rendered
  n += r.source === "portal" ? 20 : r.source === "email" ? 16 : r.source === "manual" ? 12 : 4;
  if (r.invoiceNumber) n += 8;
  if (r.reviewed) n += 4;
  if (r.itemId) n += 2;
  return n;
}

/** Fields worth carrying off a discarded copy before it goes. */
export function mergeFields(keep: DupeCandidate, drop: DupeCandidate[]): Partial<DupeCandidate> {
  const patch: Partial<DupeCandidate> = {};
  for (const d of drop) {
    if (!keep.invoiceNumber && !patch.invoiceNumber && d.invoiceNumber) patch.invoiceNumber = d.invoiceNumber;
    if (!keep.itemId && !patch.itemId && d.itemId) patch.itemId = d.itemId;
    if (!keep.description && !patch.description && d.description) patch.description = d.description;
  }
  return patch;
}
