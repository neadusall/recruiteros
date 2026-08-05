/**
 * RecruitersOS · In-Market · AI email SEQUENCE for a personalized role video
 *
 * Drafts a TWO-EMAIL outreach sequence for the hiring manager who owns an open role:
 *   • Email 1 — TEXT ONLY (no video): a short cold intro anchored on the real hiring signal.
 *   • Email 2 — the FOLLOW-UP that carries the PiP role video. It references the first email
 *     lightly ("coming back to my note about", "wanted to put a face to it" — never a banned
 *     template phrase) and drops the clickable video at the {{videoembed}} line. This is ALWAYS
 *     the second touch — never the first — because a video bump after a plain-text intro is what
 *     earns the click.
 *
 * Honest + specific (the project's Bernays "real signal → relevance → response" baseline): no
 * hype, no fake familiarity. Merge fields {{firstName}}/{{company}}/{{role}} drop into a sequence.
 *
 * On-demand only (one cheap call per role). With no ANTHROPIC_API_KEY it returns null and the
 * studio falls back to a solid built-in template. Model conventions mirror lib/inmarket/aiManagers.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CampaignModel, Motion } from "../core/types";
import { eligibleTemplates, pickTemplate } from "../bd/mpc/templates";

/** Email/outreach creation is pinned to Haiku for spend control (does NOT follow RECRUITEROS_LLM_MODEL). */
const MODEL =
  process.env.RECRUITEROS_OPENER_MODEL ??
  process.env.RECRUITEROS_EMAIL_MODEL ??
  "claude-haiku-4-5";

export function openerConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface OpenerInput {
  company: string;
  roleTitle: string;
  signalReason?: string;       // e.g. "reposted the role twice in 30 days"
  motion?: "bd" | "recruiting";
  /** Recruiter-side MPC data flags. Kept for callers (attach route) but no longer steers the
   *  Day-0 pick: the video sequence's intro pool (VIDEO_INTROS) only uses tokens that always
   *  resolve, so no send can be held for an unfillable city/competitor claim. */
  mpc?: { hasNearCity?: boolean; hasCompetitor?: boolean };
}
export interface EmailDraft { subject: string; body: string; }
/** A two-step sequence: text intro first, video follow-up second. */
export interface OpenerDraft {
  first: EmailDraft;           // Email 1 — text only
  second: EmailDraft;          // Email 2 — the video follow-up (carries {{videoembed}})
  source: "ai" | "template";
}

const SYSTEM = `You write a TWO-EMAIL cold outreach SEQUENCE for a recruiting / business-development professional reaching the hiring manager who owns an open role ({{role}} at {{company}}).

EMAIL 1 — TEXT ONLY, no video. A short cold intro anchored on the REAL signal (they are hiring for {{role}}). Offer to help FILL the search; do NOT claim you already have a specific candidate in hand, and do NOT invent locations, metrics, or candidate details. Specific, honest, human. 40-70 words, 2-4 short sentences. End with a low-friction question. Do NOT mention a video.

EMAIL 2 — the FOLLOW-UP, sent a few days after email 1 (assume no reply yet). Reference the first note lightly ("coming back to my note about {{role}}", "wanted to put a face to it" — NEVER "circling back", "following up", "checking in": those are banned template phrases). Then introduce a short personalized video: the sender ON CAMERA, recorded over the prospect's ACTUAL job posting. If you mention the video's length, use the literal token {{videolength}} (it renders as the real duration); NEVER write a specific number of seconds yourself. Describe the video ONLY as that (a real person, a face to the name, over their real posting); never claim it contains role-specific analysis, sourcing plans, or fill-time estimates it does not have. Put the literal token {{videoembed}} on its OWN line where the video goes. 40-75 words. End with a low-friction question (worth a quick look? open to a short call?).

Rules for BOTH: anchor on the real signal, no hype, no fake familiarity, no "I hope this finds you well", no emojis. Use ONLY these merge fields: {{firstName}}, {{company}}, {{role}}. Do not invent stats or names.
Return STRICT JSON only, no prose: { "subject1": "...", "body1": "...", "subject2": "...", "body2": "...with {{videoembed}} on its own line..." }`;

/** Draft the sequence via the LLM. Returns null when the key is absent or the call fails. */
export async function draftVideoOpener(input: OpenerInput): Promise<OpenerDraft | null> {
  if (!openerConfigured() || !input.company || !input.roleTitle) return null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const user =
      `Company: ${input.company}\n` +
      `Role they're hiring for: ${input.roleTitle}\n` +
      `Signal: ${input.signalReason || `actively hiring for ${input.roleTitle}`}\n` +
      `Motion: ${input.motion === "recruiting" ? "recruiting (placing candidates)" : "business development (winning the search/job order)"}`;
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e < 0) return null;
    const j = JSON.parse(text.slice(s, e + 1)) as { subject1?: string; body1?: string; subject2?: string; body2?: string };
    const body1 = String(j.body1 || "").trim();
    let body2 = String(j.body2 || "").trim();
    if (!body1 || !body2) return null;
    if (!/\{\{\s*videoembed\s*\}\}/i.test(body2)) body2 += "\n\n{{videoembed}}"; // guarantee the video slot
    return {
      first: { subject: String(j.subject1 || `${input.company} + ${input.roleTitle}`).trim(), body: body1 },
      second: { subject: String(j.subject2 || `re: ${input.roleTitle}`).trim(), body: body2 },
      source: "ai",
    };
  } catch {
    return null;
  }
}

/**
 * Day-1 PiP video email — written to read like a REAL PERSON, not a recruiter template. The whole
 * point of the video is to show there's an actual human here who can help fill the seat. {{videoembed}}
 * is the clickable video (renderTouch only fills it on the 2nd email).
 *
 * TEN rotating variants, picked deterministically per campaign; subjects AND bodies carry spintax
 * that renderTouch expands per prospect, so co-located decision-makers and same-day recipients never
 * cluster on one surface form. Copy rules (enforced by scripts/test-copy-hygiene.mts): no fake "re:"
 * subject on a first-contact thread, no banned template phrase (BANNED_PHRASES in bd/mpc/humanizer),
 * no em/en dashes, {{videoembed}} on its own line, sign-off {Thanks|Best}, {{Your_Name}}.
 */
const VIDEO_FOLLOWUPS: EmailDraft[] = [
  {
    subject: "{a quick video for your {{Open_Role}} search|{{videolength}} on your {{Open_Role}} search}",
    body:
      "Hi {{First_Name}}, {coming back to my note about|one more thought on} your {{Open_Role}}. {i'd rather not be just another name in your inbox|rather than send another email you'll skim past}, so i recorded a quick video, {it's {{videolength}} of me|just me, {{videolength}}}, {putting a face to the name|so you can see there's a real person here}, recorded {over your actual {{Open_Role}} posting|right on top of your {{Open_Role}} posting}.\n\n{{videoembed}}\n\n{if the seat's still open|if this is still a priority}, {i'd genuinely like to help|i'd love to help you get it filled}. {worth a quick look?|worth 10 minutes?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{put a face to my note about {{Open_Role}}|a face to go with my {{Open_Role}} note}",
    body:
      "Hi {{First_Name}}, {wanted to put a face to my note about|thought a video would land better than another email about} your {{Open_Role}}. {i taped a short clip over your actual posting|i recorded {{videolength}} in front of your job page} so you can {see who you'd be working with|see there's a real person on this end}.\n\n{{videoembed}}\n\n{if filling it is still on your plate|if it's still live}, {i think i can genuinely move it|i'd like to help you close it out}. {open to a quick look?|worth a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{recorded this for you, {{First_Name}}|made you a quick video, {{First_Name}}}",
    body:
      "Hi {{First_Name}}, {i made you a short video instead of writing another note|i'd rather show you than write another email}. {it's {{videolength}} over your {{Open_Role}} posting|{{videolength}}, recorded over your actual {{Open_Role}} page}, so you can {put a face to the name|see who's actually offering to help}.\n\n{{videoembed}}\n\n{if you're still hiring for it|if the role's still open}, {i'd love to help|i think i can help}. {worth a look?|worth comparing notes?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{a {{videolength}} take on your {{Open_Role}} posting|your {{Open_Role}} posting, in {{videolength}}}",
    body:
      "Hi {{First_Name}}, {coming back to my note from the other day|one quick add to my note} about your {{Open_Role}}. {i pulled up your posting and recorded a short video over it|i recorded a quick clip right over your job page}, {so you can see it's really your posting, not a blast|so it's concrete, not another pitch}.\n\n{{videoembed}}\n\n{if it's still a live search|if the seat still needs filling}, {i'd genuinely like to take it on|i'd love to help}. {worth a quick watch?|open to a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{a real person behind that last email|proof there's a person behind my last email}",
    body:
      "Hi {{First_Name}}, {emails are easy to ignore, so here's my face instead|figured you should see who's actually writing you}. {i recorded {{videolength}} over your {{Open_Role}} posting|a short clip on your {{Open_Role}}, short and to the point}, so you know {who you'd actually be dealing with|there's a real person on this end}.\n\n{{videoembed}}\n\n{if the role's still open|if this is still on your list}, {i'd like to help you fill it|i can genuinely move it}. {worth {{videolength}}?|worth a quick look?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{would rather show you than tell you|show, not tell, on {{Open_Role}}}",
    body:
      "Hi {{First_Name}}, {rather than write you a wall of text|instead of one more paragraph in your inbox}, i recorded a quick video {over your {{Open_Role}} posting|in front of your actual job page}: {who i am and why i think i can help|the person behind the note, on camera}.\n\n{{videoembed}}\n\n{if it's still open|if you're still looking}, {i'd love to help|i'd like to take a real swing at it}. {worth a watch?|worth 10 minutes this week?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{a quick video on your {{Open_Role}} posting|your {{Open_Role}} posting, with a face attached}",
    body:
      "Hi {{First_Name}}, {i recorded a short video right over your actual {{Open_Role}} posting|i put a quick video together on top of your {{Open_Role}} posting}: {me, on camera, offering to help you fill it|a real person, not another automated email}.\n\n{{videoembed}}\n\n{if you want it filled sooner than later|if the timeline matters}, {i'm happy to talk it through live|i'd love to compare notes}. {worth a quick call?|worth a look first?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{quick video, no pitch deck|a video instead of a pitch, {{First_Name}}}",
    body:
      "Hi {{First_Name}}, {no deck, no one-pager|no pitch attached}, just {30 honest seconds over your {{Open_Role}} posting|a short clip recorded on your actual {{Open_Role}} page} {so you can size me up quickly|so you know exactly who's offering to help}.\n\n{{videoembed}}\n\n{if the seat's still empty|if you're still hiring}, {i'd like to earn the search|i'd love a shot at it}. {worth a watch?|open to a quick look?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{the video version of my last note|my last note, as a video}",
    body:
      "Hi {{First_Name}}, {my last note was words, this one's a face|here's the human version of my last email}. {i recorded a short clip over your {{Open_Role}} posting|{{videolength}} on your {{Open_Role}}, recorded over the posting itself}, so you can {see who you're dealing with|put a person to the words}.\n\n{{videoembed}}\n\n{if it's still a priority|if the role's still open}, {i'd genuinely like to help|i can help you close it out}. {worth a quick look?|worth a conversation?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{before you archive this, {{First_Name}}|one video before you archive me}",
    body:
      "Hi {{First_Name}}, {before this thread goes quiet|before you file me under later}, {i recorded you a short video|here's {{videolength}} of me} over your {{Open_Role}} posting, {a real person you can actually size up|who i am and why i'm writing}.\n\n{{videoembed}}\n\n{if you're still hiring for it|if the search is still live}, {i'd love to help|i'd like to take it on}. {worth {{videolength}}?|worth a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
];

/** Deterministic follow-up pick (stable per seed, same FNV-1a family as pickTemplate), so one
 *  campaign keeps one variant while different campaigns spread across all ten. */
export function pickVideoFollowup(seed: string): EmailDraft {
  let h = 2166136261;
  const s = `video|${seed}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return VIDEO_FOLLOWUPS[(h >>> 0) % VIDEO_FOLLOWUPS.length] ?? VIDEO_FOLLOWUPS[0];
}

/** The full pool, exported for the copy-hygiene test. */
export { VIDEO_FOLLOWUPS };

/**
 * Day-0 TEXT INTRO pool for the video sequence. These are SEARCH-anchored, not candidate-anchored:
 * the only signal we truly hold is "this company is hiring {{Open_Role}}", and the video that
 * follows is the sender offering to help fill that search, so email 1 must set up exactly that
 * story, never "i already have a strong one" (an MPC candidate claim whose tokens, like the
 * candidate's target city, this flow can't honestly fill; that combination once rendered
 * "wants . no pressure"). Tokens are limited to ones that ALWAYS resolve here:
 * {{First_Name}} {{Company}} {{Open_Role}} {{A_Open_Role}} {{Your_Name}}.
 */
const VIDEO_INTROS: EmailDraft[] = [
  {
    subject: "{your {{Open_Role}} search|the {{Open_Role}} seat you're filling}",
    body:
      "Hi {{First_Name}}, {saw {{Company}} is hiring {{A_Open_Role}}|noticed the {{Open_Role}} opening at {{Company}}}. {these are exactly the searches i run|this is the seat i work}, and {i can likely put strong people in front of you quickly|i think i can fill it faster than the posting will}. {worth a conversation?|open to comparing notes?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{here if your {{Open_Role}} search is a priority|if the {{Open_Role}} search is a priority}",
    body:
      "Hi {{First_Name}}, {if filling the {{Open_Role}} seat is on your plate this quarter|if the {{Open_Role}} opening is a priority right now}, {that's the exact search i run|this is the work i do all day}. {no pitch deck, just help|no pressure at all}. {worth a conversation?|worth a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{one question about your {{Open_Role}}|a question on the {{Open_Role}} opening}",
    body:
      "Hi {{First_Name}}, quick one: {do you have the {{Open_Role}} search fully covered|is the {{Open_Role}} seat fully covered}, or {could you use one more set of eyes on it|is there room for real help on it}? {this is the profile i place|i place this profile regularly}, and {i move fast when a seat matters|i'm happy to prove it quickly}. {worth a conversation?|open to a quick call?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{about the {{Open_Role}} you posted|your {{Open_Role}} posting at {{Company}}}",
    body:
      "Hi {{First_Name}}, {your {{Open_Role}} posting came across my desk|the {{Open_Role}} opening at {{Company}} came across my desk}, {and this isn't a blast|so this is a real note, not a mass email}. {seats like this are my lane|this is squarely the work i do}, and {i'd like a shot at filling it|i'd like to help you close it}. {worth a conversation?|worth a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{before the {{Open_Role}} applicant pile grows|the applicants you won't get for {{Open_Role}}}",
    body:
      "Hi {{First_Name}}, {job boards will bury you in near misses for a seat like {{Open_Role}}|the applicant pile rarely holds the {{Open_Role}} you actually need}. {i work the other side of that|my work starts where the postings stop}: {the people who aren't applying|the ones already doing the job well somewhere else}. {want them in front of you?|worth a conversation?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{a hand with the {{Open_Role}} seat|help on the {{Open_Role}} seat, if useful}",
    body:
      "Hi {{First_Name}}, {i'll keep this short|short and honest}: {{Company}} is hiring {{A_Open_Role}}, {and that's a search i know well|and i know that search well}. {if it's moving slower than you'd like|if you want it filled sooner than later}, {i can help|i'd like to help}. {worth a conversation?|open to a quick call?}\n{Best|Thanks}, {{Your_Name}}",
  },
];

/** Deterministic intro pick (same FNV-1a family), offset-seeded so the intro and follow-up
 *  variants rotate independently across campaigns. */
export function pickVideoIntro(seed: string): EmailDraft {
  let h = 2166136261;
  const s = `intro|${seed}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return VIDEO_INTROS[(h >>> 0) % VIDEO_INTROS.length] ?? VIDEO_INTROS[0];
}

/** The intro pool, exported for the copy-hygiene test. */
export { VIDEO_INTROS };

/**
 * Day-4 CLOSER pool: the third email that ties the sequence together and makes the
 * direct ask. Two variants of each closer:
 *   - standard (no watch signal): re-anchor the signal, mention the intro + video
 *     WITHOUT claiming they saw either, direct CTA, graceful exit line. It never
 *     re-embeds the video and never uses video tokens, so it can always render.
 *   - watched (the prospect's watch telemetry shows a view): acknowledge softly
 *     (never "I saw you watching", which reads like surveillance), then the same
 *     direct ask.
 * Claims stay inside what we know: they are hiring {{Open_Role}}, we wrote twice,
 * a video was in note two. Tokens: {{First_Name}} {{Company}} {{Open_Role}}
 * {{A_Open_Role}} {{Your_Name}} only.
 */
export interface CloserDraft extends EmailDraft { subjectWatched: string; bodyWatched: string }

const VIDEO_CLOSERS: CloserDraft[] = [
  {
    subject: "{closing the loop on {{Open_Role}}|last note on your {{Open_Role}} search}",
    body:
      "Hi {{First_Name}}, {last note from me on this|i'll make this the last unprompted one}. {you're hiring {{A_Open_Role}}, i sent a note and a short video|i've sent a note and a quick video about your {{Open_Role}} search}, {and i still think i can help you fill it|and the offer stands: i think i can fill it}.\n\n{can we take 15 minutes this week?|worth 15 minutes this week to compare notes?} {a one-word reply works|even a quick 'not now' helps me close the loop}. {if the seat's already filled, congrats, and ignore me|if it's handled, ignore me and good luck with the start date}.\n{Thanks|Best}, {{Your_Name}}",
    subjectWatched: "{the next step on {{Open_Role}}|following the video, {{First_Name}}}",
    bodyWatched:
      "Hi {{First_Name}}, {glad the video made it in front of you|hope the video was worth the minute}. {you're hiring {{A_Open_Role}} and that's exactly the search i run|the {{Open_Role}} seat is exactly the work i do}, {so let's make it concrete|so here's the direct ask}:\n\n{15 minutes this week|a quick call this week}, {i'll bring specific people we could put in front of you|i'll walk in with names, not a pitch}. {does tuesday or thursday work?|what day works best?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{should i close the file on {{Open_Role}}?|keep working your {{Open_Role}}, or stand down?}",
    body:
      "Hi {{First_Name}}, {quick yes or no|one simple question}: {is the {{Open_Role}} search still open|are you still filling the {{Open_Role}} seat}? {i've written twice, once with a short video|my note and video are in your inbox somewhere}, {because this is the exact seat i fill|because i genuinely work this exact search}.\n\n{if yes, give me 15 minutes this week|if it's still open, 15 minutes is all i need}. {if no, tell me and i'm gone|if not, one word and i'll close the file}.\n{Best|Thanks}, {{Your_Name}}",
    subjectWatched: "{a concrete next step for {{Open_Role}}|making {{Open_Role}} easy to say yes to}",
    bodyWatched:
      "Hi {{First_Name}}, {since the video reached you, i'll skip the intro|you've seen my face, so i'll get to it}: {the {{Open_Role}} seat is my lane|{{Open_Role}} searches are the work i do daily}, {and i'd like to earn this one|and i'd like a real shot at this one}.\n\n{15 minutes this week and i'll show you exactly who i'd put forward|give me 15 minutes and i'll bring specifics, not a deck}. {tuesday or thursday?|what day suits you?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{third and final note on {{Open_Role}}|calling it on {{Open_Role}} after this}",
    body:
      "Hi {{First_Name}}, {third note, and i cap it here|i keep these to three, so this is the last}. {the {{Open_Role}} opening at {{Company}} is still the reason i'm writing|{{Company}}'s {{Open_Role}} search is still worth filling fast}, {and between my first note and the video, you know who i am by now|and you've got my note and video for context}.\n\n{the ask is small: 15 minutes|all i'm asking is 15 minutes}. {worth it this week?|can we find a slot this week?} {either way, i'll stop cluttering your inbox|no reply and i'll leave you to it}.\n{Thanks|Best}, {{Your_Name}}",
    subjectWatched: "{one small ask on {{Open_Role}}|the 15-minute version of {{Open_Role}}}",
    bodyWatched:
      "Hi {{First_Name}}, {thanks for giving the video a look|glad the video landed}. {so here's the honest close|so let me close the loop properly}: {the {{Open_Role}} seat is open, i fill seats like it|you have {{A_Open_Role}} to fill and that's my exact lane}, {and one short call tells us both if there's a fit|and 15 minutes tells us both whether i can help}.\n\n{what does this week look like?|does this week have 15 minutes in it?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{before i let {{Open_Role}} go|last thought on the {{Open_Role}} seat}",
    body:
      "Hi {{First_Name}}, {i'll be straight|straight to it}: {i've sent a note and a video about your {{Open_Role}} search|two notes so far, one with a video, all about your {{Open_Role}}}, {because seats like it are where i earn my keep|because it's squarely the search i run}. {silence usually means busy, not no|no reply usually just means a busy week}, {so here's one last, easy out|so one final, low-effort ask}:\n\n{reply 'yes' and i'll send times|reply with a day and i'll work around it}, {or 'no' and i'll close the file politely|or tell me it's covered and i'm gone}.\n{Best|Thanks}, {{Your_Name}}",
    subjectWatched: "{turning the video into a call?|from video to 15 minutes, {{First_Name}}}",
    bodyWatched:
      "Hi {{First_Name}}, {the video did its job if you know who i am now|hopefully the video made me a person, not a template}. {what it couldn't do is fill your {{Open_Role}}|the {{Open_Role}} seat still needs a person in it}, {which is the part i'm good at|which is where i come in}.\n\n{15 minutes this week and i'll bring real candidates to the conversation|one short call and i'll show you exactly what i'd do with the search}. {which day works?|when's good?}\n{Best|Thanks}, {{Your_Name}}",
  },
];

/** Deterministic closer pick (same FNV-1a family, its own salt). */
export function pickVideoCloser(seed: string): CloserDraft {
  let h = 2166136261;
  const s = `closer|${seed}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return VIDEO_CLOSERS[(h >>> 0) % VIDEO_CLOSERS.length] ?? VIDEO_CLOSERS[0];
}

/** The closer pool, exported for the copy-hygiene test. */
export { VIDEO_CLOSERS };

/**
 * THE video-sequence pair. Day-0 is a search-anchored text intro from VIDEO_INTROS (one consistent
 * story with the video: "you're hiring this seat, i can help fill it"). Day-1 is the real-person
 * PiP video follow-up above. Every token is resolved per prospect (bd/mpc/resolve) and spintax
 * diversifies each send (copy/spintax) at render. `input.mpc` is kept for callers but no longer
 * steers the pick: the intro pool only uses tokens this flow can always honestly fill.
 */
export function templateOpener(input: OpenerInput): OpenerDraft {
  const seed = `${input.company}|${input.roleTitle}|${input.motion || "bd"}`;
  // DAY 0 = one of the 50 MPC templates, custom to their post at render time
  // (the original design, restored by owner decision). Eligibility is strict:
  // a template claiming a nearby placement or a competitor story is only in
  // the pool when that data is REALLY present, so the render guard never holds
  // a send for an unfillable {{Near_City}}/{{Competitor}} and the "wants .
  // no pressure" class of collapse cannot recur. With no MPC flags at all,
  // only the always-fillable angles remain, and the search-anchored intro
  // pool stays as the final fallback if eligibility ever empties the pool.
  const el = {
    proximityOk: input.mpc?.hasNearCity === true,
    hasCompetitor: input.mpc?.hasCompetitor === true,
    hasNearCity: input.mpc?.hasNearCity === true,
  };
  const pool = eligibleTemplates(el);
  const first: EmailDraft = pool.length
    ? (({ subject, body }) => ({ subject, body }))(pickTemplate(seed, el))
    : pickVideoIntro(seed);
  return { first, second: pickVideoFollowup(seed), source: "template" };
}


/**
 * Turn a drafted sequence into a runnable, APPROVED CampaignModel the autopilot cadence sends.
 * EXACTLY TWO EMAILS by owner decision (the original design):
 *   touch 1 (day 0) - the custom intro from the 50 MPC templates, rendered per prospect
 *                     against their actual post (templateOpener picks it)
 *   touch 2 (day N) - the video follow-up (its body carries {{videoembed}}, filled per
 *                     prospect from personalizedVideo at send time; always the 2nd touch)
 * The follow-up threads onto the first (In-Reply-To/References) so it arrives as a reply
 * in the same conversation. The LinkedIn connect is NOT a scheduled touch: it fires from
 * watch telemetry (lib/inmarket/watchConnect) only after the prospect actually plays the
 * video. Auto-approved because the operator attached the sequence.
 */
export function videoSequenceModel(draft: OpenerDraft, motion: Motion, videoDelayDays = 1): CampaignModel {
  const nowIso = new Date().toISOString();
  const videoDay = Math.max(1, Math.round(videoDelayDays));
  return {
    generatedAt: nowIso,
    approvedAt: nowIso,
    engine: "video_sequence",
    motion,
    summary: "Custom MPC intro → personalized video follow-up (2 emails, threaded; a video watch triggers the LinkedIn connect)",
    touches: [
      { key: "email_intro", day: 0, channel: "email", label: "Text intro", subject: draft.first.subject, body: draft.first.body },
      { key: "email_video", day: videoDay, channel: "email", label: "Video follow-up", subject: draft.second.subject, body: draft.second.body },
    ],
  };
}
