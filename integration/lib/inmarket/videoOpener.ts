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
import { pickTemplate } from "../bd/mpc/templates";

const MODEL =
  process.env.RECRUITEROS_OPENER_MODEL ??
  process.env.RECRUITEROS_LLM_MODEL ??
  "claude-sonnet-4-6";

export function openerConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface OpenerInput {
  company: string;
  roleTitle: string;
  signalReason?: string;       // e.g. "reposted the role twice in 30 days"
  motion?: "bd" | "recruiting";
  /** What recruiter-side MPC data the campaign actually has, so the Day-0 template pick only
   *  chooses templates whose tokens will resolve (an unknown placement city must never pick a
   *  {{Near_City}} template — the render guard would hold every send of it). */
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

EMAIL 1 — TEXT ONLY, no video. A short cold intro anchored on the REAL signal (they are hiring for {{role}}). Specific, honest, human. 40-70 words, 2-4 short sentences. End with a low-friction question. Do NOT mention a video.

EMAIL 2 — the FOLLOW-UP, sent a few days after email 1 (assume no reply yet). Reference the first note lightly ("coming back to my note about {{role}}", "wanted to put a face to it" — NEVER "circling back", "following up", "checking in": those are banned template phrases). Then introduce a short personalized video of their ACTUAL job posting. Put the literal token {{videoembed}} on its OWN line where the video goes. 40-75 words. End with a low-friction question (worth a quick look? open to a short call?).

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
      "Hi {{First_Name}}, {coming back to my note about|one more thought on} your {{Open_Role}}. {i'd rather not be just another name in your inbox|rather than send another email you'll skim past}, so i recorded a quick video, {it's 30 seconds of me|just me, about 30 seconds}, {putting a face to the name|so you can see there's a real person here} and how i'd actually help you fill the seat.\n\n{{videoembed}}\n\n{if the seat's still open|if this is still a priority}, {i'd genuinely like to help|i'd love to help you get it filled}. {worth a quick look?|worth 10 minutes?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{put a face to my note about {{Open_Role}}|a face to go with my {{Open_Role}} note}",
    body:
      "Hi {{First_Name}}, {wanted to put a face to my note about|thought a video would land better than another email about} your {{Open_Role}}. {i taped a short clip over your actual posting|i recorded 30 seconds in front of your job page} so you can {see who you'd be working with|see there's a real person on this end}.\n\n{{videoembed}}\n\n{if filling it is still on your plate|if it's still live}, {i think i can genuinely move it|i'd like to help you close it out}. {open to a quick look?|worth a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{recorded this for you, {{First_Name}}|made you a quick video, {{First_Name}}}",
    body:
      "Hi {{First_Name}}, {i made you a short video instead of writing another note|i'd rather show you than write another email}. {it's 30 seconds over your {{Open_Role}} posting|half a minute, recorded over your actual {{Open_Role}} page}, on how i'd run the search.\n\n{{videoembed}}\n\n{if you're still hiring for it|if the role's still open}, {i'd love to help|i think i can help}. {worth a look?|worth comparing notes?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{30 seconds on your {{Open_Role}} posting|your {{Open_Role}} posting, in 30 seconds}",
    body:
      "Hi {{First_Name}}, {coming back to my note from the other day|one quick add to my note} about your {{Open_Role}}. {i pulled up your posting and recorded a short video over it|i recorded a quick clip right over your job page}, {so you can see exactly what i mean|so it's concrete, not another pitch}.\n\n{{videoembed}}\n\n{if it's still a live search|if the seat still needs filling}, {i'd genuinely like to take it on|i'd love to help}. {worth a quick watch?|open to a short call?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{a real person behind that last email|proof there's a person behind my last email}",
    body:
      "Hi {{First_Name}}, {emails are easy to ignore, so here's my face instead|figured you should see who's actually writing you}. {i recorded 30 seconds over your {{Open_Role}} posting|a short clip on your {{Open_Role}}, nothing scripted}, with how i'd approach the search.\n\n{{videoembed}}\n\n{if the role's still open|if this is still on your list}, {i'd like to help you fill it|i can genuinely move it}. {worth 30 seconds?|worth a quick look?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{would rather show you than tell you|show, not tell, on {{Open_Role}}}",
    body:
      "Hi {{First_Name}}, {rather than write you a wall of text|instead of one more paragraph in your inbox}, i recorded a quick video {over your {{Open_Role}} posting|in front of your actual job page}: {who i am and how i'd fill the seat|the person behind the note and my read on the search}.\n\n{{videoembed}}\n\n{if it's still open|if you're still looking}, {i'd love to help|i'd like to take a real swing at it}. {worth a watch?|worth 10 minutes this week?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{my read on your {{Open_Role}} search, on video|your {{Open_Role}} search, my take in 30 seconds}",
    body:
      "Hi {{First_Name}}, {i went through your {{Open_Role}} posting and recorded my honest read|i recorded a short take on your {{Open_Role}} posting}: {where i'd source and how fast it could fill|what i'd do first and why it fills}.\n\n{{videoembed}}\n\n{if you want it filled sooner than later|if the timeline matters}, {i'm happy to walk you through it live|i'd love to compare notes}. {worth a quick call?|worth a look first?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{quick video, no pitch deck|a video instead of a pitch, {{First_Name}}}",
    body:
      "Hi {{First_Name}}, {no deck, no one-pager|no pitch attached}, just {30 honest seconds over your {{Open_Role}} posting|a short clip recorded on your actual {{Open_Role}} page} {so you can size me up quickly|so you know exactly who's offering to help}.\n\n{{videoembed}}\n\n{if the seat's still empty|if you're still hiring}, {i'd like to earn the search|i'd love a shot at it}. {worth a watch?|open to a quick look?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "{the video version of my last note|my last note, as a video}",
    body:
      "Hi {{First_Name}}, {my last note was words, this one's a face|here's the human version of my last email}. {i recorded a short clip over your {{Open_Role}} posting|30 seconds on your {{Open_Role}}, recorded over the posting itself}, with {how i'd actually fill it|the way i'd run the search}.\n\n{{videoembed}}\n\n{if it's still a priority|if the role's still open}, {i'd genuinely like to help|i can help you close it out}. {worth a quick look?|worth a conversation?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "{before you archive this, {{First_Name}}|one video before you archive me}",
    body:
      "Hi {{First_Name}}, {before this thread goes quiet|before you file me under later}, {i recorded you a short video|here's 30 seconds of me} over your {{Open_Role}} posting, {a real person with a real plan for the seat|who i am and how i'd fill it}.\n\n{{videoembed}}\n\n{if you're still hiring for it|if the search is still live}, {i'd love to help|i'd like to take it on}. {worth 30 seconds?|worth a short call?}\n{Best|Thanks}, {{Your_Name}}",
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
 * THE cold-email BD sequence. Day-0 is one of the 50 MPC templates (bd/mpc/templates), selected
 * deterministically per campaign from the universally-safe pool (no proximity/competitor assumptions
 * unless the flow supplies them). Day-1 is the real-person PiP video follow-up above. Every token is
 * resolved per prospect (bd/mpc/resolve) and spintax diversifies each send (copy/spintax) at render.
 */
export function templateOpener(input: OpenerInput): OpenerDraft {
  const seed = `${input.company}|${input.roleTitle}|${input.motion || "bd"}`;
  // Conservative defaults: no proximity/competitor/city claims unless the campaign's MPC
  // context says the data exists — so the picked template always renders complete.
  const t = pickTemplate(seed, {
    proximityOk: false,
    hasCompetitor: !!input.mpc?.hasCompetitor,
    hasNearCity: input.mpc?.hasNearCity ?? false,
  });
  return { first: { subject: t.subject, body: t.body }, second: pickVideoFollowup(seed), source: "template" };
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
