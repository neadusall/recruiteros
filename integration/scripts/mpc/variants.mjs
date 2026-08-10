// RecruitersOS · MPC · the variant catalog (the A/B/n test bank).
//
// The "watering hole" is the CATEGORY of hook (you already have people from a recent search).
// WHICH spin of it actually makes a decision-maker reply is an empirical question, so we treat
// the lead angle as a tracked variable: each email is assigned ONE variant, that id rides along
// on the send log, and monitor.mjs reads the inbox back to show reply-rate PER VARIANT. Add or
// retire variants here and the whole loop (send -> tag -> measure) follows automatically.
//
// Every variant still obeys the writer's hard rules (truth-locked, 45-70 words, no named
// competitor, no named individual). A variant only steers the LEAD, not the honesty.

export const VARIANTS = [
  {
    id: "peer_search",
    label: "just wrapped a peer search",
    lead: "LEAD with: you just wrapped a search for a comparable company in THEIR industry and came away with a few strong candidates for exactly this title, local to their market. You are not pitching a new search, you already have the people. Close by inviting a quick conversation to walk through who you have.",
  },
  {
    id: "runner_up",
    label: "placed one, have runners-up",
    lead: "LEAD with: you recently PLACED someone in this exact title for a peer company in their space, and have strong runner-up candidates, local to their metro, still available right now. Close by inviting a quick call to talk them through.",
  },
  {
    id: "market_scarcity",
    label: "local market is tight",
    lead: "LEAD with: how tight and competitive their LOCAL market is for this specific finance/accounting profile (the good ones get locked up fast), then that you already hold vetted people local to that metro for this title. Close by inviting a short conversation.",
  },
  {
    id: "speed_fill",
    label: "seat open while scaling costs you",
    lead: "LEAD with: the real cost of leaving THIS seat open while they are scaling (the strain it puts on the finance team), then that you can move fast because you already hold a shortlist for this exact title. Close by inviting a quick call.",
  },
  {
    id: "industry_bench",
    label: "active bench in your industry",
    lead: "LEAD with: you keep an active, current bench of this exact title within THEIR industry and metro, and a couple of those people map cleanly to this req right now. Close by inviting a short conversation about them.",
  },
];

const BY_ID = new Map(VARIANTS.map((v) => [v.id, v]));
export function variantById(id) {
  return BY_ID.get(id) || null;
}

// Deterministic, even rotation by position so the test is balanced and reproducible (no RNG):
// prospect i in the batch gets VARIANTS[i % n]. Over a run every angle gets a fair share.
export function pickVariant(i) {
  return VARIANTS[i % VARIANTS.length];
}
