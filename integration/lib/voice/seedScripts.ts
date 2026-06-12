/**
 * RecruiterOS · Voice Drops · Seeded default scripts
 *
 * A small, opinionated library of cloned-voice voicemail scripts that every
 * workspace starts with, so an operator can pick a proven, natural-sounding
 * drop instead of writing one cold. Each is formatted for how a TTS clone
 * actually reads text aloud (see lib/voice/script.ts + lib/text/dashes):
 *
 *   - short, single-thought sentences (TTS paces off terminal punctuation, so
 *     one idea per sentence = correct intonation and breathing room),
 *   - spoken-language openers ("So,", "And") that cue a conversational drop in,
 *   - "..." for a single beat of natural hesitation (e.g. before a name),
 *   - a vocative comma on the name so the clone gives it the right inflection,
 *   - contractions throughout, no em-dashes, no digits/abbreviations,
 *   - honest identification ({agent_name}/{agent_company}) in every script, and
 *   - a rendered length inside the 15-25s landline-voicemail sweet spot.
 *
 * Two motions, each with a longer "natural callback" and a shorter "quick hello"
 * so there is a real A/B pair to compare. Performance per script is tracked via
 * the drop log (see scriptStats in ./store) so the operator can keep the winner
 * and retire the rest — the "learn from responses" loop.
 *
 * These are seeded as ordinary VoiceScript rows on a workspace's first read
 * (ensureSeedScripts), so they are editable, deletable, and attributable exactly
 * like a hand-written script — not special-cased read-only entries.
 */

import type { Motion } from "../core/types";

/** A seed definition — the durable fields; workspace + timestamps are filled on insert. */
export interface SeedScript {
  /** Stable id, shared across workspaces, so a seed is inserted at most once. */
  id: string;
  motion: Motion;
  name: string;
  template: string;
}

export const DEFAULT_VOICE_SCRIPTS: SeedScript[] = [
  {
    id: "vscr-seed-bd-natural",
    motion: "bd",
    name: "Natural callback (BD)",
    template:
      "Hey {first_name}... it's {agent_name}, over at {agent_company}. " +
      "So, I came across your {role} search. " +
      "And I figured I'd reach out directly. " +
      "We help teams hire faster. Plain and simple. " +
      "If that's useful, just give me a call back, right at this number. " +
      "Either way... thanks {first_name}. Talk soon.",
  },
  {
    id: "vscr-seed-bd-quick",
    motion: "bd",
    name: "Quick hello (BD)",
    template:
      "Hey {first_name}, it's {agent_name} with {agent_company}. " +
      "Saw you're hiring for a {role}. " +
      "We help teams fill roles like that, fast. " +
      "If it's worth a quick chat, give me a ring back at this number. " +
      "Thanks {first_name}... talk soon.",
  },
  {
    id: "vscr-seed-rec-natural",
    motion: "recruiting",
    name: "Natural callback (Recruiting)",
    template:
      "Hey {first_name}... it's {agent_name}, over at {agent_company}. " +
      "So, your name came up around the {role} world. " +
      "And I figured I'd reach out directly. No agenda here. " +
      "Just worth a quick hello, if you're ever weighing your options. " +
      "If that's useful, give me a call back, right at this number. " +
      "Either way... thanks {first_name}. Talk soon.",
  },
  {
    id: "vscr-seed-rec-quick",
    motion: "recruiting",
    name: "Quick hello (Recruiting)",
    template:
      "Hey {first_name}, it's {agent_name} with {agent_company}. " +
      "A {role} opportunity came across my desk, and I thought of you. " +
      "No pressure at all. " +
      "If you're curious, give me a call back at this number. " +
      "Thanks {first_name}... talk soon.",
  },
];
