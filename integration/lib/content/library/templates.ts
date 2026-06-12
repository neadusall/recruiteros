/**
 * RecruiterOS · Content Library — Multi-channel touch templates
 *
 * The 28-day sequence anatomy (lib/campaigns/sequence.ts) as composable templates.
 * Each body carries SLOT TOKENS the resolver fills from the selected fragment packs
 * + the prospect's merge fields. Authoring rule: every line must read cleanly even
 * if an optional slot resolves empty (the resolver strips empty lines + fixes
 * punctuation), so never write "X {{slot}}, Y" where an empty slot breaks the grammar.
 *
 * Slots: {{first_name}} {{full_name}} {{company}} {{title}} {{role}} {{industry}}
 *        {{signal_opener}} {{industry_context}} {{industry_pain}} {{industry_value}}
 *        {{function_pain}} {{function_hook}} {{cares_about}} {{proof}} {{vocab}}
 *        {{cta}} {{sender}} {{calendar_link}} {{callback_number}}
 */

import type { TouchTemplate } from "./taxonomy";

/** Email: the 7-touch drip. */
export const EMAIL_TEMPLATES: TouchTemplate[] = [
  {
    id: "email-0-signal-opener",
    channel: "email",
    day: 0,
    name: "Signal Opener",
    motions: ["bd"],
    maxChars: 700,
    subject: "{{first_name}}, a thought on {{company}}",
    body:
      "Hi {{first_name}},\n\n" +
      "{{signal_opener}}\n\n" +
      "For {{role}} leaders in {{industry}}, the harder part is usually {{function_pain}}, not the headcount itself.\n\n" +
      "Worth a short note on how {{company}} is approaching it, or not the right time?\n\n" +
      "{{sender}}",
  },
  {
    id: "email-0-signal-opener-rec",
    channel: "email",
    day: 0,
    name: "Signal Opener",
    motions: ["recruiting"],
    maxChars: 700,
    subject: "{{first_name}}, worth a quick hello",
    body:
      "Hi {{first_name}},\n\n" +
      "{{signal_opener}}\n\n" +
      "For {{role}} people in {{industry}}, the best moves usually start as a quiet conversation, long before any job board. {{function_hook}}\n\n" +
      "Open to comparing notes, or not the right time?\n\n" +
      "{{sender}}",
  },
  {
    id: "email-3-value-drop",
    channel: "email",
    day: 3,
    name: "Value Drop",
    maxChars: 800,
    subject: "Something useful, no ask",
    body:
      "{{first_name}},\n\n" +
      "No ask here. {{proof}}\n\n" +
      "{{industry_value}}\n\n" +
      "Thought it was worth passing along given {{cares_about}}.\n\n" +
      "{{sender}}",
  },
  {
    id: "email-7-comparable-proof",
    channel: "email",
    day: 7,
    name: "Comparable Proof",
    maxChars: 800,
    subject: "A comparable {{industry}} move",
    body:
      "{{first_name}},\n\n" +
      "{{proof}}\n\n" +
      "The part that made it work: {{function_hook}}.\n\n" +
      "Glad to share the specifics if {{cares_about}} is on your radar.\n\n" +
      "{{sender}}",
  },
  {
    id: "email-12-interactive-question",
    channel: "email",
    day: 12,
    name: "Interactive Question",
    motions: ["bd"],
    maxChars: 600,
    subject: "One question, {{first_name}}",
    body:
      "{{first_name}},\n\n" +
      "When {{function_pain}} comes up at {{company}}, does your team own that directly, or is it spread across functions?\n\n" +
      "Genuinely curious how you have structured it.\n\n" +
      "{{sender}}",
  },
  {
    id: "email-12-interactive-question-rec",
    channel: "email",
    day: 12,
    name: "Interactive Question",
    motions: ["recruiting"],
    maxChars: 600,
    subject: "One question, {{first_name}}",
    body:
      "{{first_name}},\n\n" +
      "When you picture your next move, is it more about {{cares_about}}, or something a job description never quite captures?\n\n" +
      "Genuinely curious how you are weighing it.\n\n" +
      "{{sender}}",
  },
  {
    id: "email-18-market-view",
    channel: "email",
    day: 18,
    name: "Market View",
    maxChars: 800,
    subject: "What we are seeing in {{industry}}",
    body:
      "{{first_name}}, three things landing with {{role}} leaders right now:\n\n" +
      "- {{industry_pain}}\n" +
      "- {{industry_value}}\n" +
      "- {{function_hook}}\n\n" +
      "Reply if any of these is live for you.\n\n" +
      "{{sender}}",
  },
  {
    id: "email-24-direct-ask",
    channel: "email",
    day: 24,
    name: "Direct Ask",
    maxChars: 700,
    subject: "15 min next week?",
    body:
      "{{first_name}},\n\n" +
      "I have shared a few notes on {{cares_about}}. If useful, a 15 minute call is the fastest way to go deeper: {{calendar_link}}\n\n" +
      "If the timing is off, just say so and I will step back.\n\n" +
      "{{sender}}",
  },
  {
    id: "email-28-breakup",
    channel: "email",
    day: 28,
    name: "Break-up",
    maxChars: 600,
    subject: "Should I close the file?",
    body:
      "{{first_name}},\n\n" +
      "I have not heard back, which usually means this is not a priority right now. Completely fair, and I will close the loop on my end.\n\n" +
      "If {{function_pain}} becomes pressing later, my door is open.\n\n" +
      "{{sender}}",
  },
];

/** LinkedIn: connect, signal-anchored DM, voice note (hot), direct ask. */
export const LINKEDIN_TEMPLATES: TouchTemplate[] = [
  {
    id: "li-3-connect",
    channel: "linkedin",
    day: 3,
    name: "Connect request",
    action: "connect",
    maxChars: 280,
    body: "Hi {{first_name}}, {{signal_opener}} Would value connecting.",
  },
  {
    id: "li-7-dm",
    channel: "linkedin",
    day: 7,
    name: "Signal-anchored DM",
    action: "message",
    motions: ["bd"],
    maxChars: 600,
    body:
      "{{first_name}}, {{signal_opener}} {{function_hook}}. " +
      "Curious how {{company}} is thinking about it. Open to a quick exchange?",
  },
  {
    id: "li-7-dm-rec",
    channel: "linkedin",
    day: 7,
    name: "Signal-anchored DM",
    action: "message",
    motions: ["recruiting"],
    maxChars: 600,
    body:
      "{{first_name}}, {{signal_opener}} {{function_hook}}. " +
      "Curious whether a move is even on your radar right now. Open to a quick exchange?",
  },
  {
    id: "li-14-voice-note",
    channel: "linkedin",
    day: 14,
    name: "Voice note",
    action: "voice_note",
    hotOnly: true,
    motions: ["bd"],
    maxChars: 600,
    body:
      "Hi {{first_name}}, it is {{sender}}. I will keep this short. {{signal_opener}} " +
      "For {{role}} leaders in {{industry}}, {{function_pain}} usually sits underneath that. " +
      "Not pitching anything, just curious whether it is on your radar at {{company}}. " +
      "If it is, reply here and I will share what has been working. Thanks.",
  },
  {
    id: "li-14-voice-note-rec",
    channel: "linkedin",
    day: 14,
    name: "Voice note",
    action: "voice_note",
    hotOnly: true,
    motions: ["recruiting"],
    maxChars: 600,
    body:
      "Hi {{first_name}}, it is {{sender}}. Keeping this short. {{signal_opener}} " +
      "For {{role}} people in {{industry}}, the most interesting roles rarely get posted. " +
      "Not pitching anything, just curious whether now is a moment you would entertain a conversation. " +
      "If so, reply here. Thanks.",
  },
  {
    id: "li-21-direct-ask",
    channel: "linkedin",
    day: 21,
    name: "Direct DM ask",
    action: "message",
    maxChars: 500,
    body:
      "{{first_name}}, I will be direct. If {{cares_about}} is a priority this quarter, " +
      "a short call is the fastest way I can be useful: {{calendar_link}} No worries if not.",
  },
];

/** Voicemail drop (cloned voice), reserved for warm prospects. */
export const VOICE_TEMPLATES: TouchTemplate[] = [
  {
    id: "voice-14-drop",
    channel: "voice",
    day: 14,
    name: "Voicemail drop",
    hotOnly: true,
    motions: ["bd"],
    maxChars: 520,
    body:
      "Hi {{first_name}}, this is {{sender}}. {{signal_opener}} " +
      "I work with {{role}} leaders in {{industry}} on {{cares_about}}, and your name came up. " +
      "No agenda, just thought a quick hello was worth it. " +
      "If useful, you can reach me at {{callback_number}}. Thanks, and take care.",
  },
  {
    id: "voice-14-drop-rec",
    channel: "voice",
    day: 14,
    name: "Voicemail drop",
    hotOnly: true,
    motions: ["recruiting"],
    maxChars: 520,
    body:
      "Hi {{first_name}}, this is {{sender}}. {{signal_opener}} " +
      "I partner with {{role}} people in {{industry}} when they are weighing a move, no pressure either way. " +
      "If it is useful to talk, you can reach me at {{callback_number}}. Thanks, and take care.",
  },
];

/** SMS: short post-engagement nudges (fire after a reply on another channel). */
export const SMS_TEMPLATES: TouchTemplate[] = [
  {
    id: "sms-0-nudge",
    channel: "sms",
    day: 0,
    name: "SMS nudge",
    maxChars: 160,
    body: "{{first_name}}, {{sender}} here, following up on my note about {{cares_about}}. Open to a quick chat?",
  },
  {
    id: "sms-3-value",
    channel: "sms",
    day: 3,
    name: "SMS value",
    maxChars: 160,
    body: "{{first_name}}, no rush. I have one quick example on {{function_pain}} if it helps. Want me to send it?",
  },
];

/** The full multi-channel pool, ordered by day. */
export const TOUCH_TEMPLATES: TouchTemplate[] = [
  ...EMAIL_TEMPLATES,
  ...LINKEDIN_TEMPLATES,
  ...VOICE_TEMPLATES,
  ...SMS_TEMPLATES,
].sort((a, b) => a.day - b.day);
