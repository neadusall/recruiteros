/**
 * RecruitersOS · JD Sourcing
 * Lazy Anthropic client for the sourcing LLM stages.
 *
 * Building `new Anthropic()` at module load is a trap: with no key the SDK throws
 * "Could not resolve authentication method" the instant the module is imported, and
 * even when it succeeds the client is frozen to whatever key existed at boot — so a
 * key saved later (the AI engine card mirrors it into process.env at runtime) never
 * takes effect. Reading the CURRENT env key on each call fixes both: a clean,
 * actionable error when unset, and a live pickup the moment a key is saved.
 */

import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;
let cachedKey = "";

export function anthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw Object.assign(new Error("anthropic_not_configured: set ANTHROPIC_API_KEY"), { status: 409 });
  }
  if (!cached || cachedKey !== key) {
    cached = new Anthropic({ apiKey: key });
    cachedKey = key;
  }
  return cached;
}
