# KoldInfo enrichment — CSV round-trip (first rung)

KoldInfo has **no API** — it's a session-gated Next.js app (Server Actions, no REST surface, nothing
exposed unauthenticated). So we use it as the **first enrichment rung** via a daily CSV round-trip the
operator drives. A KoldInfo hit can skip both the free naming research and the permutation+Reoon walk
for that slot, and because every confirmed hit teaches the per-domain pattern cache, one address
unlocks the whole domain's colleagues for ~1 Reoon credit. This is the low-hanging-fruit lever.

## The loop (once/day, ~10 minutes) — Engine / Throughput panel has the buttons

1. **Export.** POST `/api/in-market` `{ action: "koldinfo_export", limit: 4000, mode: "seed" }`.
   Returns `{ count, domains, mode, filename, csv }`. The CSV holds the highest hiring-intent slots
   that have a **domain but no confirmed email — named OR un-named** — each carrying a `ros_id`
   passthrough plus `company`, `domain`, and the target `title` so KoldInfo can find the right person.
   - **`mode: "seed"` (default)** — ONE slot per domain. A single lookup learns the domain's email
     format; the pattern cache constructs the other decision-makers at that domain for ~1 Reoon credit
     on the next validator tick. Cheapest way to cover the most people.
   - **`mode: "all"`** — every un-confirmed slot, when you'd rather KoldInfo resolve each person.
   - Cap `limit` to roughly your daily send need so we only enrich what we can send.
2. **Enrich.** Upload the CSV to KoldInfo, run it, download the result CSV.
3. **Import.** POST `/api/in-market` `{ action: "koldinfo_import", csv: "<result CSV text>" }`.
   Returns `{ parsed, matched, named, found, catchAll, invalid, pending, unmatched }`
   (`named` = un-named slots KoldInfo filled with a real person).

## Why this is the FIRST rung (top of funnel)

Export includes **un-named** slots, so KoldInfo names *and* emails cold before the free research +
permutation/Reoon hop ever runs — it skims the low-hanging fruit first. Whatever it confirms, the free
pipeline then skips (it only touches rows without a verdict). And because each confirmed hit seeds the
per-domain pattern cache, `mode: "seed"` turns one KoldInfo credit into a whole domain: the other slots
at that domain get constructed and Reoon-confirmed automatically on the next tick. A KoldInfo company
lookup that returns several people is absorbed too — extra contacts fill that company's other open
slots (matched by company+domain when `ros_id` isn't on the row).

## What import does (the discipline)

- **Re-links** each returned address to its prospect by `ros_id`, else by name+domain
  (`koldInfoMatchKey`). Unmatched rows are counted, not guessed.
- **Re-verifies every address through our own Reoon credits** before trusting it
  (`verifyDetailedBatch`) — a vendor "verified" flag is never taken at face value.
  - `valid` → `emailValidated`, `emailSource: "koldinfo"`, promoted to **contactable**, and the
    domain pattern is learned.
  - `catch_all` → tiered as **catch-all** (NOT counted valid).
  - `invalid` / `role_account` → counted, **discarded** — never written over the prospect's state.
  - `deliverable` / `unknown` (e.g. Reoon not keyed yet) → address stored as **pending**, so the
    continuous validator confirms it later. KoldInfo still helped: we now have a real address where
    there was only a guess.
- `emailSource: "koldinfo"` makes KoldInfo's contribution visible in the Engine panel's
  `emailBySource` breakdown, so we can measure its true hit-rate.

## The format is placeholder until we see the real export

`lib/inmarket/koldInfo.ts` has two blocks to confirm against a real KoldInfo run:
- `EXPORT_HEADER` — the columns we WRITE for the upload template.
- `IMPORT_ALIASES` — defensive header aliases for KoldInfo's RESULT export.

Both are tolerant, but the moment we see KoldInfo's real upload template and one real export row,
update those two blocks to match. Nothing else changes.

## Guarding against KoldInfo UI changes (48-hour canary)

Because the loop depends on KoldInfo's UI/export, a redeploy can silently break it. `scripts/koldinfo-canary.mjs`
fingerprints the deployed build from outside (chunk names, deployment id, server-action ids) and flags
any change:

```
node scripts/koldinfo-canary.mjs           # exit 0 = unchanged, 3 = CHANGED
node scripts/koldinfo-canary.mjs --update   # re-baseline after you've re-verified the columns
```

Baseline lives in `scripts/koldinfo-baseline.json` (first captured 2026-07-04, hash `01a3f150b925a66d`).
It detects **redeploys**, not column changes directly (those are behind auth) — a changed fingerprint
is the signal to log in, re-verify the CSV template + the two blocks above, then `--update` the baseline.
A scheduled agent runs this every 48 hours.

## Phase 2 (later): headless browser worker

Same pattern as `lib/sourcing/laxis.ts`: a Playwright worker logs in with the operator's creds, records
the real upload/export Server-Action calls once, then runs the round-trip headless on a timer — feeding
the SAME `koldinfo_export` / `koldinfo_import` functions. Build only after Phase 1 proves the hit-rate;
it automates an early-access account, so that's an explicit operator decision.
