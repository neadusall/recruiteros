/**
 * RecruiterOS · Parameterized Content Library — public surface
 *
 * Pull rich, on-voice, multi-channel outreach copy for any lead by parameters
 * (industry × function × seniority × signal × motion), rendered instantly from a
 * pre-authored fragment pool. No LLM on the send path.
 *
 *   import { pullForProspect } from "lib/content/library";
 *   const seq = pullForProspect({ title: "VP Engineering", company: "Acme",
 *                                 industry: "fintech", warmth: 85, signal: "funding_round" });
 *   // seq.touches -> ready-to-send email/LinkedIn/voice/SMS, day-sequenced.
 */

export * from "./taxonomy";
export { craftSequence, craftTouch, pullForProspect, libraryCoverage } from "./resolver";
export { INDUSTRY_PACKS } from "./industries";
export { FUNCTION_PACKS } from "./functions";
export { SIGNAL_ANGLES } from "./signals";
export { SENIORITY_TONE } from "./tone";
export { TOUCH_TEMPLATES, EMAIL_TEMPLATES, LINKEDIN_TEMPLATES, VOICE_TEMPLATES, SMS_TEMPLATES } from "./templates";
