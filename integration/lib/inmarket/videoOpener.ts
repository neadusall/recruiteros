/**
 * RecruitersOS · In-Market · AI email opener for a personalized role video
 *
 * Drafts the short cold-email opener that WRAPS a PiP role video — anchored on the real hiring
 * signal (they're hiring for this role), honest and specific (the project's Bernays "real signal
 * → relevance → response" baseline), never hype or fake familiarity. The draft leaves a
 * {{videoembed}} line where the prospect's clickable video goes, plus {{firstName}}/{{company}}/
 * {{role}} merge fields, so it drops straight into a sequence.
 *
 * On-demand only (one cheap call per role the operator drafts). With no ANTHROPIC_API_KEY it
 * returns null and the studio falls back to a solid built-in template. Model conventions mirror
 * lib/inmarket/aiManagers.ts.
 */

import Anthropic from "@anthropic-ai/sdk";

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
export interface OpenerDraft { subject: string; body: string; source: "ai" | "template"; }

const SYSTEM = `You write ONE short cold outreach opener (email) for a recruiting / business-development professional reaching the hiring manager who owns an open role.
Rules:
- Anchor on the REAL signal (they are hiring for {{role}} at {{company}}). Specific, honest, human. No hype, no fake familiarity, no "I hope this finds you well", no emojis.
- Reference that you recorded a short personalized video of their actual job posting. The video itself is inserted where you place the literal token {{videoembed}} on its own line.
- Use ONLY these merge fields: {{firstName}}, {{company}}, {{role}}. Do not invent stats or names.
- 55-90 words in the body. 3-5 short sentences. End with a low-friction question (worth a quick look? open to a short call?).
- Subject: <= 6 words, lowercase-ish, no clickbait.
Return STRICT JSON only, no prose: { "subject": "...", "body": "...with {{videoembed}} on its own line..." }`;

/** Draft an opener via the LLM. Returns null when the key is absent or the call fails. */
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
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e < 0) return null;
    const json = JSON.parse(text.slice(s, e + 1)) as { subject?: string; body?: string };
    let body = String(json.body || "").trim();
    if (!body) return null;
    if (!/\{\{\s*videoembed\s*\}\}/i.test(body)) body += "\n\n{{videoembed}}"; // guarantee the video slot
    return { subject: String(json.subject || `${input.company} + ${input.roleTitle}`).trim(), body, source: "ai" };
  } catch {
    return null;
  }
}

/** Deterministic fallback opener (used when the LLM key is absent or the call fails). */
export function templateOpener(input: OpenerInput): OpenerDraft {
  const recruiting = input.motion === "recruiting";
  const subject = `${input.company} + ${input.roleTitle}`;
  const body = recruiting
    ? `Hi {{firstName}},\n\nI saw {{company}} is hiring for {{role}}, so I recorded a quick look at the posting and how I'd approach it:\n\n{{videoembed}}\n\nIf filling {{role}} is a priority, I can share a shortlist worth reviewing. Worth a short call?`
    : `Hi {{firstName}},\n\nNoticed {{company}} is hiring for {{role}}. I recorded a 20-second walkthrough of your own posting with a couple of ideas:\n\n{{videoembed}}\n\nIf {{role}} is a priority this quarter, I'd love to help you fill it faster. Open to a quick chat?`;
  return { subject, body, source: "template" };
}
