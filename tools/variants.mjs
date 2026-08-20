// RecruitersOS · MPC · the variant catalog (the A/B/n test bank).
//
// Every variant is the SAME motion: you represent a real person, you are marketing them to a
// company hiring that exact title. What changes is the ANGLE on that person, one line of it.
// Each email is assigned ONE variant, the id rides along on the send log, and monitor.mjs reads
// the inbox back to show reply-rate PER VARIANT. Add or retire variants here and the whole loop
// (send -> tag -> measure) follows automatically.
//
// A variant steers ONE sentence. It never buys extra words, never adds a second idea, and never
// loosens the writer's hard rules (truth-locked, 35-55 words, no named competitor, no named
// individual, no market lecture).

export const VARIANTS = [
  {
    id: "quietly_looking",
    label: "quietly looking",
    lead: "ANGLE: they are looking quietly, still employed, not on any job board. State it flat in the close. Do not dramatize it.",
  },
  {
    id: "runner_up",
    label: "runner-up from a search you closed",
    lead: "ANGLE: you just placed this exact title for another company in their space and this person was the one you could not place. Say that in five words in the first sentence, then go straight to proof.",
  },
  {
    id: "ready_now",
    label: "available now",
    lead: "ANGLE: they are ready to move now, not in six months. One clause in the close, no elaboration.",
  },
  {
    id: "off_market",
    label: "never hit the market",
    lead: "ANGLE: this person never reached the open market, you have them because of the search you just ran. Compress it to one clause in the first sentence.",
  },
  {
    id: "exact_title",
    label: "same title, same size company",
    lead: "ANGLE: they are doing this exact title right now at a company the same size, in the same industry. First sentence only, then proof.",
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
