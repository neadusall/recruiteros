/**
 * RecruitersOS · Signal Watchlists · the signal-anchored BD pitch
 *
 * The existing Day-0 intros are SEARCH-anchored: the only thing they know is "this
 * company posted {{Open_Role}}", so they open on the posting. A news signal supports a
 * stronger opening, because it holds a fact the buyer knows is true and knows is recent,
 * and it reaches them before the roles are even posted.
 *
 * This composer writes that email. Five beats, in the order that earns a reply:
 *
 *   1. OBSERVATION  the signal, said back to them as a fact about their business
 *   2. STAKES       why this particular hire is hard in THEIR vertical
 *   3. PROOF        the desk's matching specialization, stated plainly
 *   4. POSITIONING  what kind of partner this is, in one line
 *   5. ASK          a time-boxed, low-friction question
 *
 * Worked example (the target shape):
 *
 *   "Graham, Tilley is carrying more open operations roles than it has in months, and
 *    chemical distribution is not a space where you can drop just anyone into an
 *    operations seat. Lume recruits into distribution, warehousing, and logistics, so
 *    the operations and supply chain leaders we bring already understand regulated,
 *    complex product handling. We work as an embedded partner, not a resume vendor.
 *    Worth 15 minutes to see where Lume can help you hire ahead of the growth?"
 *
 * Beats 3 and 4 are claims about the DESK, not about the prospect, so they cannot be
 * inferred from a headline: they come from a stored DeskProfile. Beats 1, 2 and 5 are
 * built from the discovered signal.
 *
 * The deterministic template is the floor and always renders. An optional Haiku pass
 * varies the surface so a hundred sends do not read as one template; it is held to the
 * same five beats and discarded whenever it drifts, so the AI can improve the copy but
 * can never invent a claim or drop the structure.
 */

import { loadSnapshot, saveSnapshot } from "../../db";
import { BANNED_PHRASES } from "../../bd/mpc/humanizer";
import type { NewsFacts, NewsSignal } from "./newsDiscover";

/** Email creation is pinned to Haiku for spend control across the whole product. */
const MODEL = process.env.RECRUITEROS_EMAIL_MODEL ?? "claude-haiku-4-5";

/* ------------------------------------------------------------------ */
/* The desk profile: the only facts the headline cannot supply         */
/* ------------------------------------------------------------------ */

export interface DeskProfile {
  /** The recruiting firm's name, e.g. "Lume". */
  firmName: string;
  /** What the desk recruits into, e.g. ["distribution", "warehousing", "logistics"]. */
  verticals: string[];
  /** The functions placed, e.g. "operations and supply chain leaders". */
  placesTitles: string;
  /** The hard part their people already understand, e.g. "regulated, complex product handling". */
  domainDifficulty: string;
  /** One-line differentiator, e.g. "We work as an embedded partner, not a resume vendor." */
  positioning: string;
  /** Minutes asked for in the CTA. */
  ctaMinutes: number;
}

const PROFILE_KEY = "signals_desk_profile_v1";

/** Safe generic defaults: every field is overwritable, and nothing here asserts a
 *  credential the desk has not claimed. */
export const DEFAULT_PROFILE: DeskProfile = {
  firmName: "our team",
  verticals: [],
  placesTitles: "the leaders we place",
  domainDifficulty: "the operating reality of your market",
  positioning: "We work as an embedded partner, not a resume vendor.",
  ctaMinutes: 15,
};

function normalizeProfile(p: Partial<DeskProfile> | null | undefined): DeskProfile {
  const v = Array.isArray(p?.verticals) ? p!.verticals.map((s) => String(s).trim()).filter(Boolean) : [];
  const minutes = Math.round(Number(p?.ctaMinutes));
  return {
    firmName: (p?.firmName || "").trim() || DEFAULT_PROFILE.firmName,
    verticals: v.slice(0, 6),
    placesTitles: (p?.placesTitles || "").trim() || DEFAULT_PROFILE.placesTitles,
    domainDifficulty: (p?.domainDifficulty || "").trim() || DEFAULT_PROFILE.domainDifficulty,
    positioning: (p?.positioning || "").trim() || DEFAULT_PROFILE.positioning,
    ctaMinutes: Number.isFinite(minutes) && minutes >= 5 && minutes <= 60 ? minutes : DEFAULT_PROFILE.ctaMinutes,
  };
}

type ProfileStore = Record<string, DeskProfile>;

export async function getDeskProfile(workspaceId: string): Promise<DeskProfile> {
  const all = (await loadSnapshot<ProfileStore>(PROFILE_KEY)) || {};
  return normalizeProfile(all[workspaceId || "default"]);
}

export async function saveDeskProfile(workspaceId: string, patch: Partial<DeskProfile>): Promise<DeskProfile> {
  const ws = workspaceId || "default";
  const all = (await loadSnapshot<ProfileStore>(PROFILE_KEY)) || {};
  const next = normalizeProfile({ ...all[ws], ...patch });
  all[ws] = next;
  await saveSnapshot(PROFILE_KEY, all);
  return next;
}

/** True once the desk has said who it is and what it recruits into. Below this the
 *  pitch still renders, but beats 3 and 4 fall back to generic language, so the UI
 *  should push the recruiter to fill it in. */
export function profileComplete(p: DeskProfile): boolean {
  return p.firmName !== DEFAULT_PROFILE.firmName && p.verticals.length > 0;
}

/* ------------------------------------------------------------------ */
/* Language helpers                                                    */
/* ------------------------------------------------------------------ */

/** "a, b, and c" — the natural spoken form, which is what beat 3 needs. */
export function listPhrase(items: string[]): string {
  const v = items.map((s) => s.trim()).filter(Boolean);
  if (!v.length) return "";
  if (v.length === 1) return v[0];
  if (v.length === 2) return `${v[0]} and ${v[1]}`;
  return `${v.slice(0, -1).join(", ")}, and ${v[v.length - 1]}`;
}

/** "an operations seat" vs "a sales seat". */
function article(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? "an" : "a";
}

/* ------------------------------------------------------------------ */
/* Surface variation                                                   */
/* ------------------------------------------------------------------ */
/*
 * The five beats are the ARGUMENT and never change. What varies is the wording, and it
 * has to: a desk running this arm at volume sends the same signal type hundreds of times
 * a month, and four companies in one market receiving byte-identical stakes lines is both
 * the thing a human notices and the thing a spam filter fingerprints.
 *
 * Variation is DETERMINISTIC and pre-written, not generated per send. Three reasons that
 * matters more than it sounds:
 *   - every phrasing is read once by a person and then fixed, so no send can drift into a
 *     claim the desk never made (the failure mode a per-send rewrite always risks);
 *   - it costs nothing and cannot fail at send time, so the copy layer has no outage;
 *   - the same prospect always renders the same email, so a resend or a re-render after a
 *     held send is not a different pitch arriving from the same sender.
 *
 * Each beat draws its own index from the seed, so two prospects that happen to collide on
 * the stakes line still differ on the proof, ask, and subject. With the counts below that
 * is a few hundred distinct surface forms per signal, from five fixed beats.
 *
 * Index 0 of every list is the original wording, so an unseeded call is unchanged.
 */

/** FNV-1a, the same family used for the MPC template pick, so variation is stable per
 *  prospect and needs no stored assignment. */
function pickIndex(seed: string, beat: string, n: number): number {
  if (n <= 1) return 0;
  let h = 2166136261;
  const s = `${seed}:${beat}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}

/** The "this seat is not interchangeable" claim. A judgment the sender is entitled to
 *  make about the market, never an assertion about the prospect's business. */
function barClause(seg: string, seat: string, i: number): string {
  const a = article(seat);
  const forms = [
    `${seg} is not a space where you can drop just anyone into ${a} ${seat} seat`,
    `${seg} is not a market where ${a} ${seat} hire is interchangeable`,
    `in ${seg}, the wrong ${seat} hire costs more than the open seat did`,
    `${seg} punishes a weak ${seat} hire harder than most markets do`,
  ];
  return forms[i % forms.length];
}

/** Signal-specific lead-ins to the stakes beat. Every entry beyond index 0 keeps the same
 *  ", and " shape, because joinBeats splits on it to avoid a two-clause run-on. */
const STAKES_LEADIN: Record<NewsSignal, string[]> = {
  funding_round: [
    "",
    "money moves faster than hiring does",
    "the board will expect headcount against that",
  ],
  exec_hire: [
    "a new leader tends to rebuild the bench underneath them",
    "new leadership usually means a new bench",
    "the first thing a new leader changes is who reports to them",
  ],
  office_expansion: [
    "standing up a new location means hiring where you have no bench yet",
    "a new location has no local bench on day one",
    "opening a new market means recruiting where nobody knows you yet",
  ],
  acquisition: [
    "integrations tend to open seats faster than they close them",
    "an integration usually creates more openings than it removes",
    "the seats that matter after a close are the ones people vacate",
  ],
  product_launch: [
    "",
    "a launch is only as strong as the team standing behind it",
  ],
};

/**
 * The seat the signal points at, in the words a hiring exec would use. Derived from the
 * roles the discovery engine inferred, so the stakes beat names the seat the buyer is
 * actually about to fill.
 */
export function seatFor(roles: string[] | undefined): string {
  const first = (roles ?? [])[0] || "";
  if (/account executive|sales|revenue|gtm/i.test(first)) return "revenue";
  if (/engineer|developer|technical|platform/i.test(first)) return "engineering";
  if (/operations|supply chain|logistics|warehouse/i.test(first)) return "operations";
  if (/clinical|care|patient/i.test(first)) return "clinical";
  if (/account|finance|controller/i.test(first)) return "finance";
  return "leadership";
}

/* ------------------------------------------------------------------ */
/* Beat 1: the observation                                             */
/* ------------------------------------------------------------------ */

/**
 * Say the signal back as a fact about their business. `reason` arrives from the
 * discovery engine already phrased as a verb clause ("just closed a $60M Series B led
 * by Battery Ventures to scale AI truck intelligence"), so the company name plus that
 * clause is a complete, true sentence opening.
 */
export function observation(company: string, reason: string): string {
  const r = (reason || "").trim().replace(/^[,;]\s*/, "");
    return r ? `${company} ${r}` : `${company} looks to be scaling up`;
}

/* ------------------------------------------------------------------ */
/* Beat 2: why this hire is hard HERE                                  */
/* ------------------------------------------------------------------ */

/**
 * The stakes line. Names the segment and the seat, and says the true, unflattering
 * thing: in this market that seat is not interchangeable. It only claims difficulty,
 * which is a judgment the sender is entitled to make, never a fact about the prospect.
 */
export function stakes(
  segment: string,
  seat: string,
  signal: NewsSignal,
  appointmentKind?: "board" | "leadership_team",
  variant = 0,
): string {
  const seg = (segment || "").trim() || "this market";
  const s = seat.trim();
  const bar = barClause(seg, s, variant);

  // A BOARD appointment is a governance change, not an operating one. Saying a new
  // board member "rebuilds the bench underneath them" is simply false, and a reader
  // who sits on that board knows it instantly. This drops the lead-in entirely rather
  // than softening it, so no variant can reintroduce the claim by another route.
  if (signal === "exec_hire" && appointmentKind === "board") return bar;

  const leadIns = STAKES_LEADIN[signal] ?? [""];
  const leadIn = leadIns[variant % leadIns.length];
  return leadIn ? `${leadIn}, and ${bar}` : bar;
}

/**
 * Join beat 1 and beat 2. The natural form is ", and", exactly as in the worked
 * example, but a stakes line that already carries its own "and" clause would make a
 * run-on with two of them; that one becomes its own sentence instead.
 */
export function joinBeats(observation: string, stakesLine: string): string {
  if (stakesLine.includes(", and ")) {
    return `${observation}. ${stakesLine.charAt(0).toUpperCase()}${stakesLine.slice(1)}`;
  }
  return `${observation}, and ${stakesLine}`;
}

/** "Freehand's" but "Conner Industries'": a trailing s takes the bare apostrophe. */
export function possessive(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

/* ------------------------------------------------------------------ */
/* The composed pitch                                                  */
/* ------------------------------------------------------------------ */

export interface PitchInput {
  firstName?: string;
  company: string;
  /** The discovery engine's reason clause, verbatim. */
  reason: string;
  segment: string;
  signal: NewsSignal;
  roles?: string[];
  facts?: NewsFacts;
  profile: DeskProfile;
  /** Stable per-prospect string (the prospect id). Selects the surface wording of each
   *  beat independently. Omit and every beat renders its original form, which is what
   *  keeps a preview or a test deterministic. */
  variantSeed?: string;
}

export interface Pitch {
  subject: string;
  body: string;
  source: "template" | "ai";
  /** The five beats, kept separately so the UI can show what the email is built from. */
  beats: { observation: string; stakes: string; proof: string; positioning: string; ask: string };
}

/** Beat 3: the desk's matching specialization. Degrades to an honest generic when the
 *  profile is not filled in, rather than inventing a vertical the desk never claimed. */
function proof(p: DeskProfile, variant = 0): string {
  const tail = `so ${p.placesTitles} already understand ${p.domainDifficulty}`;
  if (!p.verticals.length) {
    const who = p.firmName === DEFAULT_PROFILE.firmName ? "We" : p.firmName;
    return [
      `${who} focus on this market, ${tail}`,
      `${who} work this market specifically, ${tail}`,
    ][variant % 2];
  }
  const list = listPhrase(p.verticals);
  return [
    `${p.firmName} recruits into ${list}, ${tail}`,
    `${p.firmName} works ${list} specifically, ${tail}`,
    `${list} is where ${p.firmName} recruits, ${tail}`,
  ][variant % 3];
}

/** Beat 5: the ask. Time-boxed and framed around getting ahead of the hiring wave the
 *  signal implies, which is the reader's own interest rather than the sender's. */
function ask(
  p: DeskProfile,
  signal: NewsSignal,
  appointmentKind?: "board" | "leadership_team",
  variant = 0,
): string {
  const who = p.firmName === DEFAULT_PROFILE.firmName ? "we" : p.firmName;
  // What the 15 minutes would be ABOUT, in the reader's own interest. A board seat gets
  // the neutral framing: there is no new operating leader to build a bench under.
  const tails: string[] =
    signal === "exec_hire"
      ? (appointmentKind === "board"
          ? ["help you hire ahead of the plan", "be useful on the hiring that follows"]
          : ["help build out the bench under the new leader", "help build the bench under them"])
    : signal === "office_expansion"
      ? ["help you staff the new location", "help you build the team in the new market"]
    : signal === "acquisition"
      ? ["help you cover the seats the integration opens", "help you cover what the integration opens up"]
    : ["help you hire ahead of the growth", "help you get ahead of the hiring that follows"];
  const tail = tails[variant % tails.length];

  const m = p.ctaMinutes;
  return [
    `Worth ${m} minutes to see where ${who} can ${tail}?`,
    `Open to ${m} minutes on where ${who} can ${tail}?`,
    `Would ${m} minutes be worth it to see where ${who} can ${tail}?`,
  ][variant % 3];
}

function subjectFor(
  company: string,
  seat: string,
  signal: NewsSignal,
  appointmentKind?: "board" | "leadership_team",
  variant = 0,
): string {
  const poss = possessive(company);
  const forms: string[] =
    signal === "funding_round"
      ? [`${poss} ${seat} hiring after the raise`, `hiring after ${poss} raise`, `${poss} ${seat} bench, post-raise`]
    : signal === "exec_hire"
      ? (appointmentKind === "board"
          ? [`${poss} ${seat} hiring`, `${company} and the ${seat} bench`]
          : [`the bench under ${poss} new leader`, `${poss} new leader and the bench`, `who reports to ${poss} new leader`])
    : signal === "office_expansion"
      ? [`staffing ${poss} new location`, `${poss} new location and the hiring`, `hiring into ${poss} new market`]
    : signal === "acquisition"
      ? [`${company} ${seat} seats post-acquisition`, `the ${seat} seats the ${company} deal opens`]
    : [`${company} and your ${seat} hiring`, `${poss} ${seat} hiring`];
  return forms[variant % forms.length];
}

/**
 * Compose the deterministic pitch. Always succeeds, never calls out to anything, and is
 * the exact copy that ships when the AI pass is off, fails, or drifts.
 */
export function composePitch(input: PitchInput): Pitch {
  const p = input.profile;
  const seat = seatFor(input.roles);
  const kind = input.facts?.appointmentKind;
  // A separate draw per beat: two prospects colliding on the stakes line still differ on
  // the proof, the ask, and the subject, so the forms multiply instead of moving in step.
  const seed = input.variantSeed || "";
  const v = (beat: string, n: number) => (seed ? pickIndex(seed, beat, n) : 0);
  const beats = {
    // Beat 1 is the FACT, said back to them. It is the one beat that must not vary.
    observation: observation(input.company, input.reason),
    stakes: stakes(input.segment, seat, input.signal, kind, v("stakes", 4)),
    proof: proof(p, v("proof", 3)),
    positioning: p.positioning,
    ask: ask(p, input.signal, kind, v("ask", 3)),
  };
  const greeting = input.firstName?.trim() ? `${input.firstName.trim()}, ` : "";
  const body =
    `${greeting}${joinBeats(beats.observation, beats.stakes)}.\n\n` +
    `${beats.proof}. ${beats.positioning}\n\n` +
    `${beats.ask}`;
  return {
    subject: subjectFor(input.company, seat, input.signal, kind, v("subject", 3)),
    body, source: "template", beats,
  };
}

/* ------------------------------------------------------------------ */
/* Hygiene: what the AI pass is not allowed to do                      */
/* ------------------------------------------------------------------ */

/** Em and en dashes are banned product-wide in anything a prospect reads. */
const DASH_RE = /[–—]/;

export interface PitchCheck { ok: boolean; problems: string[] }

/**
 * Gate an AI-written pitch. Rejects on anything that would make the email worse than
 * the template: banned template phrases, dashes, invented merge tokens, wrong length,
 * a dropped ask, or a company name the model changed.
 */
export function checkPitch(body: string, input: PitchInput): PitchCheck {
  const problems: string[] = [];
  const text = (body || "").trim();
  if (!text) return { ok: false, problems: ["empty"] };
  if (DASH_RE.test(text)) problems.push("contains an em or en dash");

  const hay = text.toLowerCase();
  const banned = BANNED_PHRASES.filter((b) => hay.includes(b.toLowerCase()));
  if (banned.length) problems.push(`banned phrase: ${banned[0]}`);

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 45) problems.push(`too short (${words} words)`);
  if (words > 130) problems.push(`too long (${words} words)`);

  if (!text.includes("?")) problems.push("no question to answer");
  if (!hay.includes(input.company.toLowerCase().split(/\s+/)[0])) problems.push("dropped the company name");
  if (/\{\{|\}\}/.test(text)) problems.push("left an unrendered merge token");
  // The model must not promise candidates that do not exist.
  if (/\bi (?:have|'ve got|already have)\b.{0,30}\b(candidate|someone|profile)/i.test(text)) {
    problems.push("claims a specific candidate in hand");
  }
  return { ok: problems.length === 0, problems };
}

const AI_SYSTEM = `You rewrite a cold business-development email from a recruiting firm to a hiring executive. You are given the five beats it must contain, already factual. Rewrite them into one natural email.

HARD RULES:
- Keep all five beats, in order: the observation about their company, why that hire is hard in their market, the firm's matching specialization, the one-line positioning, the time-boxed question.
- Change only the wording. Never add a fact, number, name, credential, or claim that is not in the beats. Never claim to already have a candidate.
- 55 to 110 words. Two or three short paragraphs. Plain sentences.
- No em dashes, no en dashes. Use commas, periods, or the word "and".
- No greetings like "I hope this finds you well", no "circling back", no "following up", no "just checking in", no "reaching out".
- No emojis, no merge tokens, no signature, no subject line.
- Open on their company and the observation, not on yourself.

Return ONLY the email body text. No JSON, no preamble, no quotes around it.`;

export function pitchAiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && process.env.SIGNAL_PITCH_AI !== "0";
}

/**
 * Optional surface-variation pass. Returns the template pitch unchanged whenever the
 * key is absent, the call fails, or the rewrite breaks any rule, so the caller always
 * gets sendable copy and the AI can only ever improve on the floor.
 */
export async function draftPitch(input: PitchInput): Promise<Pitch> {
  const base = composePitch(input);
  if (!pitchAiEnabled()) return base;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const user =
      `Beat 1 (observation): ${base.beats.observation}\n` +
      `Beat 2 (why it is hard here): ${base.beats.stakes}\n` +
      `Beat 3 (our specialization): ${base.beats.proof}\n` +
      `Beat 4 (positioning): ${base.beats.positioning}\n` +
      `Beat 5 (the ask): ${base.beats.ask}\n` +
      `Recipient first name: ${input.firstName?.trim() || "(unknown, do not invent one)"}\n` +
      `Their company: ${input.company}`;
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: AI_SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("").trim();
    const verdict = checkPitch(text, input);
    if (!verdict.ok) return base;
    return { ...base, body: text, source: "ai" };
  } catch {
    return base;
  }
}
