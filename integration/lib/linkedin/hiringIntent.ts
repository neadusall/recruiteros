/**
 * RecruitersOS · PREDICTIVE HIRING INTENT
 *
 * The hunter's job is not "find people who are hiring". By the time someone posts "we're hiring a
 * VP of Finance", every recruiter on the platform can see it and the search is already contested.
 * The job is to find the ORGANISATIONAL EVENT that creates labour demand, 2 to 12 weeks before the
 * requisition exists.
 *
 * This module turns a public post into a structured read:
 *
 *   post text + author + company  ->  { layer, events, score, impliedRoles, impliedBuyers }
 *
 * and the company ledger beside it accumulates those reads over 90 days, so three separate weak
 * signals from one company outrank one loud signal from a company we will never hear from again.
 *
 * ── THE THREE LAYERS ────────────────────────────────────────────────────────────────────────────
 *
 *   1 EXPLICIT   "we're hiring", "building my team", "adding 50 people". Immediate, and contested:
 *                every competitor sees these too. Still worth acting on, just not a moat.
 *   2 EVENT      funding, PE, acquisition, new market, new facility, major customer, contract win,
 *                executive appointment, ERP programme, international expansion. Nothing about
 *                hiring has been said, but something happened that reliably produces it. This is
 *                the sweet spot: real, specific, and mostly unwatched.
 *   3 INFERRED   "demand has exploded", "can't keep up", "wearing too many hats", "time to
 *                professionalise the org". Hardest to detect and the highest value precisely
 *                because almost nobody is reading for them.
 *
 * ── SCORING ────────────────────────────────────────────────────────────────────────────────────
 *
 *   Hiring Intent Score = Event Strength + Language Strength + Author Authority
 *                       + Company Fit + Role Relevance + Recency          (capped at 100)
 *
 * The weights are the owner's, encoded verbatim so they can be argued with in one place rather
 * than being spread through the hunter as thresholds nobody can find. See SCORE_WEIGHTS.
 *
 * ── WHY A SCORE AND NOT A KEYWORD LIST ─────────────────────────────────────────────────────────
 *
 * "Congratulations to everyone on another strong quarter" contains growth language and no hiring
 * catalyst whatsoever. A keyword hunter comments on it; a scored hunter gives it ~30 and moves on.
 * The score is what lets the desk widen its net without the comment trail turning into noise, and
 * it is the reason this module exists as its own layer rather than as more regexes in the watcher.
 */

/* ── Layers ───────────────────────────────────────────────────────────────────────────────────── */

export type IntentLayer = 1 | 2 | 3;
export const LAYER_NAME: Record<IntentLayer, string> = {
  1: "Explicit hiring",
  2: "Event-based",
  3: "Inferred / scaling pain",
};

/* ── The event catalog ────────────────────────────────────────────────────────────────────────── */

export interface HiringEvent {
  id: string;
  label: string;
  layer: IntentLayer;
  /** Owner's 3-to-5 flame rating, mapped to points by EVENT_STRENGTH. */
  heat: 3 | 4 | 5;
  /** What the post has to say. Deliberately phrase-level, not single words: "raised" alone catches
   *  "raised a great question", and one false trigger costs a public comment. */
  match: RegExp;
  /** The functions this event typically creates demand in, best-first. Drives role prediction and,
   *  through the org chart, which seats to map at that company. */
  functions: string[];
  /** One line the comment brief can lean on: what actually happens next after this event. Written
   *  as knowledge, never as a pitch — it is the difference between "congrats, need help hiring?"
   *  and sounding like someone who has watched this sequence before. */
  whatFollows: string;
}

/** heat -> points, out of the 30 the owner allocated to event strength. */
const EVENT_STRENGTH: Record<3 | 4 | 5, number> = { 5: 30, 4: 24, 3: 18 };

export const HIRING_EVENTS: HiringEvent[] = [
  // ── Layer 1: explicit ────────────────────────────────────────────────────────────────────────
  {
    id: "explicit_hiring", label: "Explicitly hiring", layer: 1, heat: 5,
    match: /\b(we(?:'| a)?re hiring|now hiring|hiring for|open (?:role|position|req)|join our team|looking for (?:a|our next)|add(?:ing)? \d+ (?:people|roles|employees)|send (?:me )?candidates|building (?:out )?my team|growing my team)\b/i,
    functions: ["Finance", "Sales", "Operations", "Engineering"],
    whatFollows: "the search is already public, so speed and candidate quality are the only differentiators left",
  },
  {
    id: "hiring_forecast", label: "Hiring forecast", layer: 1, heat: 5,
    match: /\b(expect to (?:add|hire)|plan to (?:add|hire)|will be adding|hiring \d+|adding \d+ (?:people|roles|employees|headcount))\b/i,
    functions: ["Operations", "People / HR", "Finance"],
    whatFollows: "a headcount number in public usually means the plan is already approved and the first reqs are weeks out",
  },
  {
    id: "struggling_to_fill", label: "Struggling to fill", layer: 1, heat: 4,
    match: /\b(struggling to (?:hire|fill)|hard to fill|can(?:no|')t find|third time posting|still looking for|been open for)\b/i,
    functions: ["Finance", "Operations", "Engineering", "Sales"],
    whatFollows: "a req that has been open this long is usually mis-scoped or mis-priced rather than short of applicants",
  },

  // ── Layer 2: event-based, the sweet spot ─────────────────────────────────────────────────────
  {
    id: "funding", label: "Funding raised", layer: 2, heat: 5,
    match: /\b(series [a-e]\b|seed round|raised \$?\d|\$\d+(?:\.\d+)?\s?(?:m|mm|million|b|billion)\b.*\b(?:round|raise|funding|investment)|closed our (?:round|series)|oversubscribed round|led our round)\b/i,
    functions: ["Finance", "Sales", "Engineering", "Operations"],
    whatFollows: "the board expects a plan against the capital within a quarter, and the first hires are usually the ones that unlock the growth model",
  },
  {
    id: "pe_investment", label: "PE investment", layer: 2, heat: 5,
    match: /\b(partner(?:ing|ed) with [A-Z][\w&. ]{2,30}(?:capital|partners|equity|holdings)|private equity|growth equity|recapitali[sz]ation|majority investment|new chapter with)\b/i,
    functions: ["Finance", "Operations", "Sales", "Engineering"],
    whatFollows: "a sponsor almost always wants reporting rigour early, which is why the finance seat tends to move first",
  },
  {
    id: "acquisition", label: "Acquisition", layer: 2, heat: 4,
    match: /\b(we(?:'ve| have) acquired|acquisition of|joining forces with|has been acquired|completed the acquisition|merged with)\b/i,
    functions: ["Finance", "People / HR", "Operations", "Engineering"],
    whatFollows: "integration work lands on finance, HR and IT long before anyone writes a job description for it",
  },
  {
    id: "new_location", label: "New market or location", layer: 2, heat: 5,
    match: /\b(opening our (?:first|new|second)|new (?:office|clinic|branch|location) in|expanding (?:in)?to [A-Z]|now open in|breaking ground)\b/i,
    functions: ["Operations", "Sales", "People / HR", "Finance"],
    whatFollows: "a new site needs local leadership before it needs staff, and that hire is usually made quietly",
  },
  {
    id: "expansion", label: "Multi-market expansion", layer: 2, heat: 5,
    match: /\b(expanding into (?:\w+ )?(?:new )?(?:states|markets|regions)|entering \d+ new|rolling out across|scaling into)\b/i,
    functions: ["Operations", "Sales", "Finance"],
    whatFollows: "regional leadership and the supporting operations layer are what actually gate this kind of expansion",
  },
  {
    id: "international", label: "International expansion", layer: 2, heat: 4,
    match: /\b(entering the (?:european|emea|apac|uk|canadian|latam)|international expansion|opening in (?:london|dublin|berlin|toronto|singapore|sydney)|our first (?:european|international))\b/i,
    functions: ["Operations", "Finance", "Sales"],
    whatFollows: "country leadership plus a finance and compliance layer is the usual first wave",
  },
  {
    id: "new_facility", label: "New facility", layer: 2, heat: 5,
    match: /\b(new (?:facility|plant|warehouse|distribution cent(?:er|re)|manufacturing)|breaking ground on|square[- ]foot facility|new production line)\b/i,
    functions: ["Operations", "People / HR", "Finance"],
    whatFollows: "plant leadership, HR and finance staff a site months before the line runs",
  },
  {
    id: "capacity", label: "Capacity increase", layer: 2, heat: 4,
    match: /\b(increas(?:ing|ed) (?:production|capacity)|doubling (?:capacity|output|production)|second shift|adding a (?:line|shift))\b/i,
    functions: ["Operations"],
    whatFollows: "a second shift is a hiring plan whether or not it is described as one",
  },
  {
    id: "major_customer", label: "Major customer win", layer: 2, heat: 4,
    match: /\b(welcom(?:e|ing) [A-Z][\w&. ]{2,30} as (?:a|our) (?:new )?(?:customer|client)|signed [A-Z][\w&. ]{2,30} as|newest (?:customer|client)|landed (?:our|a) (?:largest|biggest))\b/i,
    functions: ["Operations", "Customer Success", "Sales"],
    whatFollows: "delivery and customer success feel a logo like this before sales does",
  },
  {
    id: "contract_win", label: "Major contract awarded", layer: 2, heat: 4,
    match: /\b(awarded (?:a|our)|won a (?:\d+[- ]year|multi[- ]year|major) contract|\d+[- ]year contract|contract award|task order)\b/i,
    functions: ["Operations", "Finance", "Engineering"],
    whatFollows: "a multi-year award has staffing commitments baked into the bid, usually on a clock",
  },
  {
    id: "exec_hire", label: "New executive hired", layer: 2, heat: 4,
    match: /\b(welcom(?:e|ing) our new (?:chief|c[efoimrp]o|vp|head of)|joins us as (?:our )?(?:chief|c[efoimrp]o|vp|head of)|new (?:cfo|coo|cto|cro|chro|cmo) (?:has )?join)\b/i,
    functions: ["Finance", "Operations", "Sales", "Engineering"],
    whatFollows: "a new executive builds their own bench, and the first two hires usually happen inside a quarter",
  },
  {
    id: "exec_promotion", label: "Executive promotion", layer: 2, heat: 3,
    match: /\b(promoted to (?:vp|chief|c[efoimrp]o|head of|director)|stepping into the role of|has been promoted to)\b/i,
    functions: ["People / HR", "Finance", "Operations"],
    whatFollows: "a promotion usually leaves the old seat open behind it",
  },
  {
    id: "erp_transformation", label: "ERP or systems transformation", layer: 2, heat: 4,
    match: /\b(netsuite|workday|sap (?:s\/4|implementation)|oracle fusion|erp (?:implementation|migration|transformation)|going live with our new (?:erp|system))\b/i,
    functions: ["Finance", "Engineering"],
    whatFollows: "an implementation of that size needs programme leadership and usually a technical accountant who has done one before",
  },
  {
    id: "product_launch", label: "Product launch", layer: 2, heat: 3,
    match: /\b(launching our (?:new|newest|latest)|just launched|introducing our new (?:platform|product)|general availability|now generally available)\b/i,
    functions: ["Engineering", "Sales", "Marketing", "Product"],
    whatFollows: "a launch pulls demand forward onto the teams that have to support it",
  },
  {
    id: "portfolio_add", label: "Investor portfolio addition", layer: 2, heat: 4,
    match: /\b(welcome [A-Z][\w&. ]{2,30} to (?:our|the) portfolio|newest portfolio (?:company|addition)|our investment in [A-Z])\b/i,
    functions: ["Finance", "Operations"],
    whatFollows: "a company entering a portfolio is usually about to be asked for reporting it cannot yet produce",
  },

  // ── Layer 3: inferred, the quiet ones ────────────────────────────────────────────────────────
  {
    id: "hypergrowth", label: "Rapid growth", layer: 3, heat: 4,
    match: /\b(doubl(?:ed|ing) revenue|tripled|grew \d+%|record (?:quarter|year)|best (?:quarter|year) ever|fastest[- ]growing)\b/i,
    functions: ["Finance", "Operations", "Sales"],
    whatFollows: "growth at that rate breaks the back office before it breaks the front office",
  },
  {
    id: "demand_strain", label: "Demand outpacing capacity", layer: 3, heat: 4,
    match: /\b(demand (?:is )?(?:exceed|outpac|has explod)|can(?:no|')t keep up|more demand than we|backlog (?:is|has) grow|working around the clock|stretched thin)\b/i,
    functions: ["Operations", "Customer Success", "Engineering"],
    whatFollows: "capacity complaints in public are usually a few weeks ahead of a req",
  },
  {
    id: "founder_bottleneck", label: "Founder bottleneck", layer: 3, heat: 4,
    match: /\b(wearing too many hats|still doing (?:the )?(?:books|payroll|invoicing)|i(?:'| a)?m the bottleneck|need to get out of the weeds|can(?:no|')t scale myself)\b/i,
    functions: ["Finance", "Operations", "People / HR"],
    whatFollows: "the first functional leader a founder hires is almost always the one they are personally covering",
  },
  {
    id: "professionalise", label: "Professionalising the org", layer: 3, heat: 4,
    match: /\b(professionali[sz](?:e|ing) the|building the (?:infrastructure|foundation)|next (?:stage|phase|chapter) of growth|maturing our (?:finance|operations|processes)|putting real (?:process|structure))\b/i,
    functions: ["Finance", "Operations", "People / HR"],
    whatFollows: "this phrase almost always precedes a first real controller, ops leader or HR hire",
  },
  {
    id: "scaling_pain", label: "Scaling pain", layer: 3, heat: 3,
    match: /\b(scaling has been (?:hard|challenging)|growing pains|outgrew our|systems (?:are|were) held together|manual (?:process|work) is)\b/i,
    functions: ["Finance", "Operations", "Engineering"],
    whatFollows: "the fix for this is usually a person before it is a system",
  },
];

/* ── Scoring ──────────────────────────────────────────────────────────────────────────────────── */

/** The owner's weights, verbatim and in one place so they can be argued with. Sum to 100. */
export const SCORE_WEIGHTS = {
  event: 30,      // strongest event found, scaled by its heat
  language: 25,   // explicit hiring / scaling / team-building language in the post
  authority: 15,  // the poster can actually authorise a hire
  companyFit: 10, // inside the target headcount band
  roleFit: 10,    // the event maps to functions this desk recruits
  recency: 10,    // posted within 48 hours
} as const;

export const THRESHOLDS = {
  /** Comment now and open an account-level opportunity. */
  act: 80,
  /** Comment or start watching the decision-makers. */
  engage: 60,
  /** Not yet worth a public comment; hold the company for a second signal. */
  track: 40,
} as const;

/** Titles that can authorise a hire. Kept narrow: a manager is a buyer for a req (see orgchart),
 *  but a manager posting about a funding round is not the person who decides what gets built. */
const AUTHORITY_RE = /\b(chief\s+\w+|c[efoimrphts]o|founder|co-?founder|owner|president|managing (?:director|partner)|general manager|\bvp\b|vice president|svp|evp|head of|partner at|board member|investor)\b/i;

/**
 * Hiring, SCALING or team-building language, independent of the event itself.
 *
 * Scaling verbs count and not only hiring verbs, which is what the owner's weight actually says
 * ("explicit language about hiring/scaling/team building"). It matters on the canonical example:
 * "the capital will allow us to accelerate expansion across the Southeast" is a company telling
 * you it intends to grow, and scoring it purely on the word "Series B" put that post in the
 * watch band when it belongs in the act band.
 *
 * Widening this is low-risk because language points are only ever ADDED to a post that already
 * fired an event. A congratulations post with no catalyst still scores zero however it is worded.
 */
const LANGUAGE_RE = /\b(hir(?:e|ing)|recruit(?:ing|ment)|headcount|team (?:build|expansion|growth)|building (?:out )?(?:the|our|my) team|add(?:ing)? (?:to )?(?:the|our) team|talent|staffing|onboard(?:ing)? new|grow(?:ing)? the team|bench|scal(?:e|ing)|expansion|expanding|accelerat(?:e|ing)|ramp(?:ing)? up|invest(?:ing)? in (?:the|our) (?:team|people|platform|infrastructure))\b/i;

export interface IntentRead {
  /** The highest layer present (1 explicit beats 2 event beats 3 inferred). */
  layer: IntentLayer | null;
  events: HiringEvent[];
  score: number;
  breakdown: Record<keyof typeof SCORE_WEIGHTS, number>;
  /** Functions the event implies demand in, deduped across every event found, best-first. */
  impliedFunctions: string[];
  /** What to do about it, from THRESHOLDS. */
  action: "act" | "engage" | "track" | "ignore";
  /** The strongest event, which is what the comment brief is written against. */
  primary: HiringEvent | null;
}

export interface IntentInput {
  text: string;
  authorTitle?: string;
  /** Confirmed headcount, when we hold one. */
  headcount?: number | null;
  /** Functions this desk actually recruits, so role relevance is per-workspace and not global. */
  deskFunctions?: string[];
  postAt?: string | Date | null;
  minHeadcount?: number;
  maxHeadcount?: number;
}

/**
 * Read a post. Returns a null layer and score 0 when nothing fires, which is the common case and
 * must stay cheap: this runs on every candidate the hunter screens.
 */
export function readIntent(input: IntentInput): IntentRead {
  const text = String(input.text || "");
  const empty: IntentRead = {
    layer: null, events: [], score: 0,
    breakdown: { event: 0, language: 0, authority: 0, companyFit: 0, roleFit: 0, recency: 0 },
    impliedFunctions: [], action: "ignore", primary: null,
  };
  if (text.length < 40) return empty;

  const events = HIRING_EVENTS.filter((e) => e.match.test(text));
  if (!events.length) return empty;

  // Strongest first: heat, then the more explicit layer wins a tie (a post that is both a funding
  // announcement and an explicit hiring post should be briefed as the hiring post).
  events.sort((a, b) => (b.heat - a.heat) || (a.layer - b.layer));
  const primary = events[0];
  const layer = events.reduce<IntentLayer>((lo, e) => (e.layer < lo ? e.layer : lo), 3 as IntentLayer);

  const impliedFunctions: string[] = [];
  for (const e of events) for (const f of e.functions) if (!impliedFunctions.includes(f)) impliedFunctions.push(f);

  const desk = (input.deskFunctions || []).filter(Boolean);
  const hours = input.postAt ? (Date.now() - new Date(input.postAt).getTime()) / 36e5 : Infinity;
  const min = input.minHeadcount ?? 100;
  const max = input.maxHeadcount ?? 2500;
  const head = typeof input.headcount === "number" && input.headcount > 0 ? input.headcount : null;

  const breakdown = {
    event: EVENT_STRENGTH[primary.heat],
    language: LANGUAGE_RE.test(text) ? SCORE_WEIGHTS.language : 0,
    authority: AUTHORITY_RE.test(String(input.authorTitle || "")) ? SCORE_WEIGHTS.authority : 0,
    // Company fit scores only on a CONFIRMED headcount inside the band. An unknown size scores
    // zero rather than half: this is a priority score, and guessing here would let unresolved
    // companies outrank resolved ones for no reason other than our own missing data.
    companyFit: head != null && head >= min && head <= max ? SCORE_WEIGHTS.companyFit : 0,
    roleFit: desk.length && impliedFunctions.some((f) => desk.includes(f)) ? SCORE_WEIGHTS.roleFit : 0,
    recency: hours <= 48 ? SCORE_WEIGHTS.recency : 0,
  };

  const score = Math.min(100, Object.values(breakdown).reduce((a, b) => a + b, 0));
  const action = score >= THRESHOLDS.act ? "act"
    : score >= THRESHOLDS.engage ? "engage"
    : score >= THRESHOLDS.track ? "track"
    : "ignore";

  return { layer, events, score, breakdown, impliedFunctions, action, primary };
}

/**
 * The brief handed to the comment writer, per trigger.
 *
 * The whole point is that the comment must NOT read as "congratulations, need help hiring?". That
 * sentence is what marks an automated recruiter. Instead the comment demonstrates knowledge of
 * what normally happens AFTER this event, which is a thing only somebody who runs these searches
 * would say, and which does not ask for anything.
 */
export function commentBrief(read: IntentRead, deskRole: string, city?: string): string {
  const where = city ? ` in ${city}` : "";
  if (!read.primary) return `The role they are hiring for is ${deskRole}${where}.`;
  if (read.layer === 1) {
    return `They are advertising an opening. The role they are hiring for is ${deskRole}${where}.`;
  }
  return [
    `They are NOT advertising a job. The post is a ${read.primary.label.toLowerCase()} announcement.`,
    `Do not congratulate them, do not ask if they are hiring, and do not offer candidates or help with a search.`,
    `Say one thing about what typically happens next after this kind of event: ${read.primary.whatFollows}.`,
    `Write it as an observation from a desk that has watched this sequence before, not as an offer.`,
    `Close with a low-pressure invitation to trade notes as they work through it, with no mention of candidates, fees, or a search.`,
  ].join(" ");
}
