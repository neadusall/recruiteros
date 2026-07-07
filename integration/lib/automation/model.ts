/**
 * RecruitersOS · Autopilot · the outreach MODEL
 *
 * "Show me the models, let me approve the outreach, then set it and forget it."
 *
 * A campaign's *model* is its full multi-touch sequence written as merge-field
 * TEMPLATES (e.g. "Hi {{firstName}}, saw {{company}} is {{signal}}…"). A human
 * reviews and approves it ONCE; from then on the Autopilot runner sends ongoing
 * prospects by merge-filling those approved templates — no per-send LLM call, so
 * the copy never drifts from what was signed off, and there's no ongoing AI cost.
 *
 * `draftCampaignModel` writes the model with a solid LLM (Anthropic), motion-aware
 * (BD = win the meeting with the hiring company; Recruiting = open a candidate to
 * a role). With no ANTHROPIC_API_KEY it degrades to a strong built-in template
 * sequence so the feature still works — just less tailored.
 */

import type { Campaign, CampaignModel, CampaignModelTouch, Prospect } from "../core/types";
import { GUIDELINES_PROMPT } from "../copy/guidelines";
import { expandSpintax } from "../copy/spintax";
import { buildMpcTokens, fixArticles } from "../bd/mpc/resolve";

const MERGE_HELP = "{{firstName}}, {{company}}, {{title}}, {{role}}, {{signal}}, {{watchlink}}, {{videoembed}}";

/** Render one model touch for a specific prospect (merge-fill, graceful fallbacks). */
export function renderTouch(touch: CampaignModelTouch, p: Partial<Prospect>, opts?: { emailStep?: number }): { subject?: string; body: string } {
  const vals: Record<string, string> = {
    firstname: p.firstName || (p.fullName ? p.fullName.split(/\s+/)[0] : "") || "there",
    company: p.company || "your team",
    title: p.title || "your role",
    role: (p as any).signalReason || p.title || "the role you're hiring for",
    signal: (p as any).signalReason || "your recent hiring activity",
  };
  // PiP Studio video fields (empty when no video is attached, so templates degrade cleanly).
  // The watch link is personalized PER PROSPECT: their first name greets them on the page and
  // their id attributes the view in analytics.
  //
  // FAIL-SAFE: the video (thumbnail / GIF / watch link) is ONLY ever sent on the SECOND email.
  // We gate the personalizedVideo itself by the email step, so EVERY video merge field
  // ({{videoembed}}, {{videogif}}, {{watchlink}}) renders blank on any other touch — even if a
  // template author drops them on the first email by mistake. Only the 2nd email touch carries it.
  const pv = opts?.emailStep === 2 ? p.personalizedVideo : undefined;
  // When a role video is attached, {{role}} is the role being HIRED FOR (the video's subject),
  // not the manager's own title — so the opener reads correctly.
  if (pv?.roleTitle) vals.role = pv.roleTitle;
  const watch = (() => {
    if (!pv?.watchUrl) return "";
    const extra =
      (vals.firstname && vals.firstname !== "there" ? `&n=${encodeURIComponent(vals.firstname)}` : "") +
      (p.id ? `&rcpt=${encodeURIComponent(p.id)}` : "") +
      // The address this email is going to — so the watch page can prefill the reply box.
      (p.email ? `&pe=${encodeURIComponent(p.email)}` : "");
    return pv.watchUrl + extra;
  })();
  vals.watchlink = watch;
  vals.videogif = pv?.gifUrl || "";
  vals.videoposter = pv?.posterUrl || "";
  // Loom-style embed: a big clickable thumbnail of THEIR video. The static poster (real frame +
  // play button, JPEG) is preferred — Outlook/mobile clients freeze or block animated GIFs and
  // the poster is ~10× lighter, so the first paint is instant. Older videos without a poster
  // fall back to the animated teaser GIF. A plain text link follows for image-blocking clients.
  const thumb = pv?.posterUrl || pv?.gifUrl || "";
  vals.videoembed = watch && thumb
    ? `<a href="${watch}" target="_blank" style="text-decoration:none">` +
      `<img src="${thumb}" alt="▶ Play — a quick video I recorded about ${vals.company}" width="600" ` +
      `style="max-width:100%;height:auto;border-radius:12px;border:1px solid #e5e7eb;display:block" /></a>` +
      `<p style="margin:6px 0 0;font-size:13px"><a href="${watch}" target="_blank">▶ Watch the video I made for ${vals.company}</a></p>`
    : "";
  // MPC tokens (the recent-placement Day-0 sequence): resolved from the prospect + its mpcContext,
  // with a native-lexicon floor so it reads right even when the context is sparse. Keyed lowercase to
  // match fill(). Best-effort: non-MPC templates simply never reference these tokens.
  try {
    const ctx = p.mpcContext ?? {};
    const mpc = buildMpcTokens({
      firstName: p.firstName,
      company: p.company,
      openRole: p.title,
      placedRole: ctx.placedRole,
      placementLocation: ctx.placementLocation,
      jobLocation: p.location,
      competitor: ctx.competitor,
      industry: ctx.industry,
      mustHaves: ctx.mustHaves,
      metric: ctx.metric,
      gender: ctx.gender,
      yourName: ctx.yourName,
    });
    for (const [k, v] of Object.entries(mpc)) if (typeof v === "string") vals[k.toLowerCase()] = v;
  } catch { /* MPC token resolution is best-effort */ }

  // Content DIVERSITY: expand inline spintax {a|b} per prospect+touch (deterministic seed) BEFORE the
  // merge-fill, so one approved template sends as many distinct surface forms — the deliverability
  // win against repetition. Merge fields ({{...}}) are left alone by the spintax pass.
  const seed = `${p.id || ""}:${touch.key || ""}`;
  const fill = (s?: string) =>
    fixArticles(expandSpintax(s || "", seed).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => vals[String(k).toLowerCase()] ?? ""));
  return { subject: touch.subject ? fill(touch.subject) : undefined, body: fill(touch.body) };
}

/* ----------------------------- LLM drafting ----------------------------- */

function systemPrompt(motion: Campaign["motion"]): string {
  const shared =
    "You are a senior outbound strategist. Write a multi-touch outreach sequence as REUSABLE TEMPLATES " +
    `with merge fields (only these: ${MERGE_HELP}). Natural, specific, human; no hype, no fake familiarity. ` +
    "Short sentences. Each touch earns the next.\n\n" + GUIDELINES_PROMPT + "\n\nReturn STRICT JSON only, no prose.";
  if (motion === "recruiting") {
    return shared +
      " Motion: RECRUITING. You are reaching a CANDIDATE about a specific role. Lead with why this role fits " +
      "them, respect that they may be passive, and make the ask low-friction (a quick chat, not a hard sell).";
  }
  return shared +
    " Motion: BUSINESS DEVELOPMENT. You are reaching a hiring DECISION-MAKER at a company showing a hiring " +
    "signal. Anchor the opener on the real signal ({{signal}}), offer relevant help, and ask if it's worth a short call.";
}

function userPrompt(c: Campaign): string {
  return JSON.stringify({
    instruction:
      "Draft the sequence for this campaign. Choose 4-7 touches across the allowed channels, spread over days. " +
      "Honor the methodology and voice threshold. Keep LinkedIn 'connect' notes under 300 chars. Voicemail/voice " +
      "scripts must read aloud naturally (terminal punctuation, ~45 words). Output JSON of shape: " +
      '{ "summary": string, "persona": string, "touches": [ { "day": number, "channel": "email"|"linkedin"|"voice", ' +
      '"action"?: "connect"|"message"|"voice_note", "label": string, "subject"?: string, "body": string } ] }',
    campaign: {
      motion: c.motion,
      name: c.name,
      goal: c.goal,
      methodology: c.methodology,
      voiceNoteThreshold: c.voiceNoteThreshold,
      icp: c.icp,
      signals: c.signals,
    },
  });
}

function coerceTouches(raw: any): CampaignModelTouch[] {
  const arr = Array.isArray(raw?.touches) ? raw.touches : [];
  const out: CampaignModelTouch[] = [];
  arr.forEach((t: any, i: number) => {
    const channel = t?.channel === "linkedin" || t?.channel === "voice" ? t.channel : "email";
    const body = String(t?.body ?? "").trim();
    if (!body) return;
    out.push({
      key: "t" + i,
      day: Number.isFinite(+t?.day) ? Math.max(0, Math.round(+t.day)) : i * 2,
      channel,
      action: t?.action ? String(t.action) : channel === "linkedin" ? "message" : undefined,
      label: String(t?.label ?? `Touch ${i + 1}`).slice(0, 60),
      subject: channel === "email" && t?.subject ? String(t.subject).slice(0, 160) : undefined,
      body: body.slice(0, 2000),
    });
  });
  return out.sort((a, b) => a.day - b.day);
}

/** Draft a campaign's outreach model with the LLM, or fall back to a template sequence. */
export async function draftCampaignModel(c: Campaign): Promise<CampaignModel> {
  const now = new Date().toISOString();
  try {
    const { anthropicClient } = await import("../sourcing/anthropic");
    const client = anthropicClient();
    const model = process.env.AUTOPILOT_MODEL_LLM || "claude-opus-4-8";
    const resp = await client.messages.create({
      model,
      max_tokens: 2400,
      system: systemPrompt(c.motion),
      messages: [{ role: "user", content: userPrompt(c) }],
    });
    const text = resp.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const touches = coerceTouches(json);
    if (touches.length) {
      return { generatedAt: now, engine: model, motion: c.motion, persona: json?.persona, summary: json?.summary, touches };
    }
  } catch {
    /* fall through to the built-in template sequence */
  }
  return fallbackModel(c, now);
}

/* --------------------------- no-LLM fallback ---------------------------- */

function fallbackModel(c: Campaign, now: string): CampaignModel {
  const bd = c.motion !== "recruiting";
  const touches: CampaignModelTouch[] = bd
    ? [
        { key: "t0", day: 0, channel: "linkedin", action: "connect", label: "Connect (signal note)", body: "Hi {{firstName}}, saw {{company}} is {{signal}}. I work with teams hiring for {{role}} and had a couple of ideas. Open to connecting?" },
        { key: "t1", day: 0, channel: "email", label: "Signal opener", subject: "{{company}} + {{role}}", body: "Hi {{firstName}},\n\nNoticed {{company}} is {{signal}}. We help teams fill {{role}} faster without the usual agency drag.\n\nWorth a short call to see if it's a fit?\n\nBest" },
        { key: "t2", day: 3, channel: "email", label: "Value follow-up", subject: "Re: {{company}} + {{role}}", body: "Hi {{firstName}},\n\nQuick follow-up. If filling {{role}} is a priority this quarter, I can share how similar teams cut time-to-hire.\n\nHappy to send a one-pager or grab 15 minutes." },
        { key: "t3", day: 7, channel: "voice", action: "voice_note", label: "Voicemail (hot only)", body: "Hi {{firstName}}, it's a quick note about {{role}} at {{company}}. I sent a short email too. If hiring's on your plate, I'd love to help. No pressure. Talk soon." },
        { key: "t4", day: 12, channel: "email", label: "Break-up", subject: "Closing the loop", body: "Hi {{firstName}},\n\nI'll stop here so I'm not a pest. If {{role}} hiring heats up, just reply and I'll jump in.\n\nAll the best" },
      ]
    : [
        { key: "t0", day: 0, channel: "linkedin", action: "connect", label: "Connect (role intro)", body: "Hi {{firstName}}, I'm working on {{role}} and your background stood out. Open to connecting? No pitch, just think it could be a strong fit." },
        { key: "t1", day: 0, channel: "email", label: "Role opener", subject: "A {{role}} that fits your background", body: "Hi {{firstName}},\n\nI'm helping fill {{role}} and your experience lines up well. Even if you're not looking, worth a quick chat to compare notes?\n\nBest" },
        { key: "t2", day: 3, channel: "email", label: "Why-you follow-up", subject: "Re: {{role}}", body: "Hi {{firstName}},\n\nWhat caught my eye: your background maps closely to what this team needs. I can share the details and comp range so you can decide if it's worth 15 minutes.\n\nInterested?" },
        { key: "t3", day: 8, channel: "voice", action: "voice_note", label: "Voice note", body: "Hi {{firstName}}, quick voice note about a {{role}} opening I think fits you well. Sent an email too. If the timing's right, I'd love to walk you through it. Cheers." },
        { key: "t4", day: 14, channel: "email", label: "Break-up", subject: "Closing the loop", body: "Hi {{firstName}},\n\nI'll leave it here for now. If a move makes sense down the line, reply anytime and I'll line things up.\n\nAll the best" },
      ];
  return { generatedAt: now, engine: "library", motion: c.motion, summary: bd ? "Signal-anchored BD sequence" : "Candidate-fit recruiting sequence", touches };
}
