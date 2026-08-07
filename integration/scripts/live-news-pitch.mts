/* End-to-end demo: live news signal -> lead -> composed pitch. Manual tool (network). */
import { discoverFromNews } from "../lib/signals/watch/newsDiscover";
import { composePitch } from "../lib/signals/watch/signalPitch";

const SEGMENT = "supply chain software";

// A desk profile in the shape of the worked example: who you are, what you recruit
// into, the hard part your people already understand, and how you position.
const profile = {
  firmName: "Lazio",
  verticals: ["distribution", "warehousing", "logistics"],
  placesTitles: "the operations and supply chain leaders we bring",
  domainDifficulty: "regulated, complex product handling",
  positioning: "We work as an embedded partner, not a resume vendor.",
  ctaMinutes: 15,
};

const { leads } = await discoverFromNews({ segment: SEGMENT, signals: ["funding_round", "exec_hire"], windowDays: 30, limit: 4 });

for (const l of leads) {
  const pitch = composePitch({
    firstName: "Graham",                 // stands in for the curated decision-maker
    company: l.company,
    reason: l.reason,
    segment: SEGMENT,
    signal: l.signalType as never,
    roles: l.roles,
    facts: l.newsFacts,                  // structured evidence, carried on the lead
    profile,
  });
  console.log(`\n${"=".repeat(72)}`);
  console.log(`TO: the ${(l.roles ?? [])[0]} owner at ${l.company}   [score ${l.score}]`);
  console.log(`SUBJECT: ${pitch.subject}`);
  console.log("-".repeat(72));
  console.log(pitch.body);
}
