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

EMAIL 2 — the FOLLOW-UP, sent a few days after email 1 (assume no reply yet). Reference the first note lightly ("coming back to my note about {{role}}", "wanted to put a face to it" — NEVER "circling back", "following up", "checking in": those are banned template phrases). Then introduce a short personalized video: the sender ON CAMERA, recorded over the prospect's ACTUAL job posting. Describe the video ONLY as that (a real person, a face to the name, over their real posting); never claim it contains role-specific analysis, sourcing plans, or fill-time estimates it does not have. Put the literal token {{videoembed}} on its OWN line where the video goes. 40-75 words. End with a low-friction question (worth a quick look? open to a short call?).

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
    subject: "{a 30-second video for your {{Open_Role}} search|30 seconds on your {{Open_Role}} search}",
    body:
      "Hi {{First_Name}}, {coming back to my note about|one more thought on} your {{Open_Role}}. {i'd rather not be just another name in your inbox|rather than send another email you'll skim past}, so i recorded a quick video, {it's 30 seconds of me|just me, about 30 seconds}, {putting a face to the name|so you can see there's a real person here}, recorded {over your actual {{Open_Role}} posting|right on top of your {{Open_Role}} posting}.\n\n{{videoembed}}\n\n{if the seat's still open|if this is still a priority}, {i'd genuinely like to help|i'd love to help you get it filled}. {worth a quick look?|worth 10 minutes?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{put a face to my note about {{Open_Role}}|a face to go with my {{Open_Role}} note}",
    body:
      "Hi {{First_Name}}, {wanted to put a face to my note about|thought a video would land better than another email about} your {{Open_Role}}. {i taped a short clip over your actual posting|i recorded 30 seconds in front of your job page} so you can {see who you'd be working with|see there's a real person on this end}.\n\n{{videoembed}}\n\n{if filling it is still on your plate|if it's still live}, {i think i can genuinely move it|i'd like to help you close it out}. {open to a quick look?|worth a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{recorded this for you, {{First_Name}}|made you a quick video, {{First_Name}}}",
    body:
      "Hi {{First_Name}}, {i made you a short video instead of writing another note|i'd rather show you than write another email}. {it's 30 seconds over your {{Open_Role}} posting|half a minute, recorded over your actual {{Open_Role}} page}, so you can {put a face to the name|see who's actually offering to help}.\n\n{{videoembed}}\n\n{if you're still hiring for it|if the role's still open}, {i'd love to help|i think i can help}. {worth a look?|worth comparing notes?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{30 seconds on your {{Open_Role}} posting|your {{Open_Role}} posting, in 30 seconds}",
    body:
      "Hi {{First_Name}}, {coming back to my note from the other day|one quick add to my note} about your {{Open_Role}}. {i pulled up your posting and recorded a short video over it|i recorded a quick clip right over your job page}, {so you can see it's really your posting, not a blast|so it's concrete, not another pitch}.\n\n{{videoembed}}\n\n{if it's still a live search|if the seat still needs filling}, {i'd genuinely like to take it on|i'd love to help}. {worth a quick watch?|open to a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{a real person behind that last email|proof there's a person behind my last email}",
    body:
      "Hi {{First_Name}}, {emails are easy to ignore, so here's my face instead|figured you should see who's actually writing you}. {i recorded 30 seconds over your {{Open_Role}} posting|a short clip on your {{Open_Role}}, short and to the point}, so you know {who you'd actually be dealing with|there's a real person on this end}.\n\n{{videoembed}}\n\n{if the role's still open|if this is still on your list}, {i'd like to help you fill it|i can genuinely move it}. {worth 30 seconds?|worth a quick look?}\n{Thanks|Best}, {{Your_Name}}",
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
      "Hi {{First_Name}}, {my last note was words, this one's a face|here's the human version of my last email}. {i recorded a short clip over your {{Open_Role}} posting|30 seconds on your {{Open_Role}}, recorded over the posting itself}, so you can {see who you're dealing with|put a person to the words}.\n\n{{videoembed}}\n\n{if it's still a priority|if the role's still open}, {i'd genuinely like to help|i can help you close it out}. {worth a quick look?|worth a conversation?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{before you archive this, {{First_Name}}|one video before you archive me}",
    body:
      "Hi {{First_Name}}, {before this thread goes quiet|before you file me under later}, {i recorded you a short video|here's 30 seconds of me} over your {{Open_Role}} posting, {a real person you can actually size up|who i am and why i'm writing}.\n\n{{videoembed}}\n\n{if you're still hiring for it|if the search is still live}, {i'd love to help|i'd like to take it on}. {worth 30 seconds?|worth a short call?}\n{Best|Thanks}, {{Your_Name}}",
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
    subject: "{one question about your {{Open_Role}}|quick question on the {{Open_Role}} opening}",
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
 * THE video-sequence pair. Day-0 is a search-anchored text intro from VIDEO_INTROS (one consistent
 * story with the video: "you're hiring this seat, i can help fill it"). Day-1 is the real-person
 * PiP video follow-up above. Every token is resolved per prospect (bd/mpc/resolve) and spintax
 * diversifies each send (copy/spintax) at render. `input.mpc` is kept for callers but no longer
 * steers the pick: the intro pool only uses tokens this flow can always honestly fill.
 */
export function templateOpener(input: OpenerInput): OpenerDraft {
  const seed = `${input.company}|${input.roleTitle}|${input.motion || "bd"}`;
  return { first: pickVideoIntro(seed), second: pickVideoFollowup(seed), source: "template" };
}

/**
 * Turn a drafted sequence into a runnable, APPROVED CampaignModel the autopilot cadence sends:
 * touch 1 (day 0) = the text intro, touch 2 (day N) = the video follow-up (its body carries
 * {{videoembed}}, filled per prospect from personalizedVideo at send time). The video is always
 * the SECOND touch. Auto-approved because the operator explicitly attached the sequence.
 */
export function videoSequenceModel(draft: OpenerDraft, motion: Motion, videoDelayDays = 1): CampaignModel {
  const nowIso = new Date().toISOString();
  return {
    generatedAt: nowIso,
    approvedAt: nowIso,
    engine: "video_sequence",
    motion,
    summary: "Text intro → personalized video follow-up (video is the 2nd touch)",
    touches: [
      { key: "email_intro", day: 0, channel: "email", label: "Text intro", subject: draft.first.subject, body: draft.first.body },
      { key: "email_video", day: Math.max(1, Math.round(videoDelayDays)), channel: "email", label: "Video follow-up", subject: draft.second.subject, body: draft.second.body },
    ],
  };
}
