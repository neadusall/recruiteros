/**
 * RecruiterOS · Content Library — Seniority tone
 * Register + CTA discipline per level. The resolver uses `cta` to fill the
 * {{cta}} slot and picks the envelope by seniority (executives get shorter).
 */

import type { SeniorityTone, Seniority } from "./taxonomy";

export const SENIORITY_TONE: Record<Seniority, SeniorityTone> = {
  intern: {
    key: "intern",
    tone: "Warm, encouraging, low-pressure. Speak to growth and learning, not strategy.",
    cta: "Want me to send a couple of openings that fit?",
    brevity: "Short and plain. Avoid jargon.",
  },
  junior: {
    key: "junior",
    tone: "Friendly and concrete. Focus on the work, the team, and the path forward.",
    cta: "Open to a quick look at a role that fits?",
    brevity: "Short. Lead with the opportunity, not the company.",
  },
  mid: {
    key: "mid",
    tone: "Peer to peer, practical. Respect their craft; talk about scope and impact.",
    cta: "Worth a 15 minute call to see if it is a fit?",
    brevity: "Tight. One clear idea per message.",
  },
  senior: {
    key: "senior",
    tone: "Credible and specific. Reference real scope; assume they have options.",
    cta: "Happy to share details if the scope sounds right.",
    brevity: "Concise. Earn the reply with one sharp, relevant point.",
  },
  lead: {
    key: "lead",
    tone: "Technical peer. Talk architecture, ownership, and the hard problems.",
    cta: "Glad to walk through the technical scope on a short call.",
    brevity: "Direct. Substance over polish.",
  },
  manager: {
    key: "manager",
    tone: "Operator to operator. Speak to team outcomes, delivery, and headcount pressure.",
    cta: "Open to comparing notes for 15 minutes?",
    brevity: "Brief and outcome-led.",
  },
  director: {
    key: "director",
    tone: "Strategic peer. Frame around function-level outcomes and trade-offs.",
    cta: "A 15 minute call is the fastest way to go deeper if it is useful.",
    brevity: "Executive-tight. No throat-clearing.",
  },
  vp: {
    key: "vp",
    tone: "Advisor register. Org-level pressures, sequencing, and risk; never tactical.",
    cta: "If it is a priority this quarter, I can be useful in 15 minutes.",
    brevity: "Very short. One defensible observation, one question.",
  },
  c_level: {
    key: "c_level",
    tone: "Board-room peer. Business outcomes and existential pressures only; zero fluff.",
    cta: "Worth a brief conversation, or not the right time?",
    brevity: "Shortest envelope. Every word earns its place.",
  },
  founder: {
    key: "founder",
    tone: "Builder to builder. Speak to the company they are trying to build and what it costs.",
    cta: "Happy to be a sounding board for 15 minutes if helpful.",
    brevity: "Short and human. Respect the chaos they live in.",
  },
};
