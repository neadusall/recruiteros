# Director of Regional Marketing (healthcare) — how to run this search

Companion to `healthcare-regional-marketing-director-brief.md`, which holds the paste-in
brief. This file records the dial settings and why the brief is shaped the way it is.

## Run it

On app.lumesp.com → Command Center → JD Sourcing:

1. **City & state:** `Lawrence, KS` · radius **+250mi**. That circle covers every Ring A
   and Ring B market in the source spec: Kansas City, Overland Park, Topeka, Wichita,
   Columbia, Springfield, St. Louis, Omaha, Des Moines and Tulsa.
2. **List name:** `Healthcare Regional Marketing Director · Lawrence KS`
3. **Job description:** paste the whole brief body (between the two rules) from the
   brief file.
4. **Search breadth:** `Wide net`. This role's titles fragment across twenty-plus
   variants; wide is what runs all the title chunks plus the geo-free deep pass.
5. **Scan up to:** `500` (default). **Min fit:** `45` (default). If the ranked list
   comes back thin, re-run at min fit `30` before touching anything else.
6. **Fresh only:** off (first run of this role).
7. **Include out-of-area:** OFF — keep the 250-mile limit hard so contacts stay
   regional.
8. **Also list out-of-area (separate list):** ON. This is the "Ring C, selective"
   national tier from the spec: Dallas / Chicago / Nashville / Minneapolis / Atlanta
   healthcare multi-site leaders arrive in a clearly separated list without diluting
   the local one or being auto-contacted with locals.

Then Initiate Search. The overnight-queue checkpoint covers the run if the tab dies;
enrichment and delivery proceed on their own once the list saves.

## Optional second pass

Re-run the same brief with **Remote role** unticked, location `Wichita, KS +100mi` and
Fresh only ON if the Lawrence-centered run under-covers western Kansas. Usually
unnecessary — the 250mi Lawrence circle already contains Wichita.

## Why the brief is shaped like this

- **It is written as prose, not a keyword dump.** The parse
  (`lib/sourcing/parseJobDescription.ts`) is an LLM extraction into a CandidateICP;
  full sentences with explicit lists give it clean `titles`, `targetCompanies`,
  `industries` and `niceToHave` arrays. Search-syntax fragments ("X AND Y OR Z") do
  not survive the parse.
- **~90 named employers.** Every real company in `targetCompanies` becomes its own
  poaching query, so the employer map from the source spec is baked in as names the
  model only has to carry across, not invent. All are real Kansas/Missouri/Midwest
  healthcare operators or national multi-site groups with regional presence.
- **"There are no licences required" is stated outright.** `mustHave` is weighted
  heavily and each entry gates; an empty mustHave keeps the funnel wide, which is
  correct for a marketing seat with no gate-keeping credential.
- **The geography paragraph names cities, not rings.** The typed location + radius pins
  the ICP geos regardless (`pinIcpLocation`), but naming the metros also steers the
  parse's own geo list to the same places, and the Ring C metros ride the separate
  out-of-area list.
- **Red-flag / scoring / process sections from the source spec are omitted on
  purpose.** Disqualifiers are deliberately parsed only from explicit deal-breakers
  (a "red flags" list would gate out step-up candidates the spec itself wants), and
  the scoring model, Sales Navigator scripts and success-definition sections are
  recruiter process, not candidate evidence — they would only dilute the parse.

## The proof-library change that shipped with this search

`lib/sourcing/proofTerms.ts` gained a `growth_marketing` vertical. Before it, this brief
detected as `healthcare_ops` only, so the precision pass searched and scored on LNHA /
PDPM / MDS / PointClickCare — nursing-home administrator vocabulary — and the actual
marketers scored zero proof. Now the brief detects as `growth_marketing` +
`healthcare_ops`, the top proof group is ("patient acquisition" OR "demand generation"
OR "healthcare marketing" OR "de novo" OR "regional marketing" OR "multi-location"),
and the clinical-ops group that remains is ANDed with marketing titles, so it surfaces
marketing directors at senior-care and home-health networks — the spec's Tier B — rather
than administrators.
