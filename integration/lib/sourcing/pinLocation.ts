/**
 * RecruitersOS · JD Sourcing
 * Pin the ICP's geography to the location the recruiter explicitly typed.
 *
 * The LLM parse is recall-biased and will happily emit a national metro list for a
 * senior role; the typed location is ground truth. geos become the typed location plus
 * ONLY the parsed geos that mention the same city or state, so every generated query
 * stays local. Pure function — no I/O (kept import-light so it is unit-testable).
 */

import type { CandidateICP } from "./types";

/** Compact US state name -> abbreviation map, for location token matching. */
const STATE_ABBREV: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id",
  illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la",
  maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or",
  pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc", "south dakota": "sd",
  tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa",
  "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};

export function pinIcpLocation(icp: CandidateICP, location?: string): CandidateICP {
  const raw = (location || "").replace(/\s*\+\d+\s*mi\b/i, "").trim();
  if (!raw) return icp;
  const tokens: string[] = [];
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter((t) => t.length > 1)) {
    tokens.push(part);
    if (STATE_ABBREV[part]) tokens.push(STATE_ABBREV[part]);            // "new york" -> also "ny"
    const full = Object.keys(STATE_ABBREV).find((k) => STATE_ABBREV[k] === part);
    if (full) tokens.push(full);                                        // "ny" -> also "new york"
    // Comma-less "City ST" / "City Statename": recruiters often type "Garfield
    // Heights OH". Without splitting off the trailing state, the whole string was
    // one unmatchable token, every same-state metro the parse suggested got
    // filtered out, and the pinned geo list collapsed to just the typed string.
    const words = part.split(/\s+/);
    const abbrevOf = (t: string) =>
      STATE_ABBREV[t] ? STATE_ABBREV[t] : Object.values(STATE_ABBREV).includes(t) ? t : null;
    const tail2 = words.slice(-2).join(" ");
    const tail1 = words[words.length - 1];
    const tail = words.length > 2 && abbrevOf(tail2) ? tail2 : words.length > 1 && abbrevOf(tail1) ? tail1 : null;
    if (tail) {
      const ab = abbrevOf(tail)!;
      const city = part.slice(0, part.length - tail.length).trim();
      if (city.length > 1) tokens.push(city);
      tokens.push(ab);
      const fullName = Object.keys(STATE_ABBREV).find((k) => STATE_ABBREV[k] === ab);
      if (fullName) tokens.push(fullName);
    }
  }
  const local = (icp.geos || []).filter((g) => {
    const gn = " " + g.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
    return tokens.some((t) => gn.includes(" " + t + " ") || t.includes(gn.trim()));
  });
  icp.geos = [raw, ...local.filter((g) => g.trim().toLowerCase() !== raw.toLowerCase())].slice(0, 8);
  return icp;
}
