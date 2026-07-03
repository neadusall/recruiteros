/**
 * RecruitersOS · In-Market · AI email SEQUENCE for a personalized role video
 *
 * Drafts a TWO-EMAIL outreach sequence for the hiring manager who owns an open role:
 *   • Email 1 — TEXT ONLY (no video): a short cold intro anchored on the real hiring signal.
 *   • Email 2 — the FOLLOW-UP that carries the PiP role video. It references the first email
 *     ("circling back", "wanted to put a face to it") and drops the clickable video at the
 *     {{videoembed}} line. This is ALWAYS the second touch — never the first — because a video
 *     bump after a plain-text intro is what earns the click.
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

EMAIL 2 — the FOLLOW-UP, sent a few days after email 1 (assume no reply yet). Reference the first note lightly ("circling back", "following up on my note about {{role}}", "wanted to put a face to it"). Then introduce a short personalized video of their ACTUAL job posting. Put the literal token {{videoembed}} on its OWN line where the video goes. 40-75 words. End with a low-friction question (worth a quick look? open to a short call?).

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
 * is the clickable video (renderTouch only fills it on the 2nd email). Spintax diversifies every send.
 */
const VIDEO_FOLLOWUPS: EmailDraft[] = [
  {
    subject: "re: {{Open_Role}}",
    body:
      "Hi {{First_Name}}, {i'd rather not be just another name in your inbox|rather than send one more email you'll skim past}, so i recorded a quick video for you. {it's 30 seconds of me|just me, about 30 seconds}, {putting a face to the name|so you can see there's a real person here}, and how i'd actually help you fill your {{Open_Role}}.\n\n{{videoembed}}\n\n{if your {{Open_Role}} is still open|if this is still a priority}, {i'd genuinely like to help|i'd love to help you get it filled}. {worth a conversation?|worth 10 minutes?}\n{Thanks|Best}, {{Your_Name}}",
  },
  {
    subject: "a 30-second video re: {{Open_Role}}",
    body:
      "Hi {{First_Name}}, following up on my note about {{Open_Role}}. {instead of another wall of text|rather than pitch you on paper}, i taped a short clip in front of your actual posting so you can {see who you'd be working with|put a face to it}.\n\n{{videoembed}}\n\n{if filling {{Open_Role}} is still on your plate|if it's still a live priority}, {i think i can genuinely move it|i'd like to help you close it out}. {open to a quick look?|worth 10 minutes?}\n{Best|Thanks}, {{Your_Name}}",
  },
  {
    subject: "put a face to {{Open_Role}}",
    body:
      "Hi {{First_Name}}, circling back on {{Open_Role}}. {i figured a quick video would land better than one more email|i'd rather show you than tell you}, so here's 30 seconds of me over your job page and how i'd approach the search.\n\n{{videoembed}}\n\n{if this is still open|if you're still hiring for it}, {i'd love to help|i think i can help}. {worth a short call?|open to comparing notes?}\n{Thanks|Best}, {{Your_Name}}",
  },
];

/**
 * THE cold-email BD sequence. Day-0 is one of the 50 MPC templates (bd/mpc/templates), selected
 * deterministically per campaign from the universally-safe pool (no proximity/competitor assumptions
 * unless the flow supplies them). Day-1 is the real-person PiP video follow-up above. Every token is
 * resolved per prospect (bd/mpc/resolve) and spintax diversifies each send (copy/spintax) at render.
 */
export function templateOpener(input: OpenerInput, opts?: { index?: number }): OpenerDraft {
  // `index` is the recipient's slot among the decision-makers at this company. It rotates BOTH the
  // Day-0 template and the Day-1 video follow-up so that co-located DMs (DM #1/#2/#3) never receive
  // the same email — structural diversity on top of the per-send spintax in lib/automation/model.
  const idx = Math.max(0, Math.trunc(opts?.index ?? 0));
  const seed = `${input.company}|${input.roleTitle}|${input.motion || "bd"}`;
  const t = pickTemplate(seed, { proximityOk: false, hasCompetitor: false }, idx);
  const followup = VIDEO_FOLLOWUPS[idx % VIDEO_FOLLOWUPS.length];
  return { first: { subject: t.subject, body: t.body }, second: followup, source: "template" };
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
