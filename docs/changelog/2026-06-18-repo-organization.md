# 2026-06-18 — Repo organization + JD Sourcing engine map

Housekeeping pass to make the codebase faster to navigate and develop in.

## Cleanup
- Removed two accidental junk files (a saved Cognism GDPR webpage with a mangled
  path-style filename) from the repo root and from `integration/public/` — they had
  been picked up as a "page" by `sync-public.cjs`.

## Navigation / folders
- Added **[`integration/lib/sourcing/README.md`](../../integration/lib/sourcing/README.md)** —
  a map of the JD Sourcing domain (now 19 files). Shows the end-to-end flow
  (JD → brief → ICP → queries → discovery → score/rerank → save → enrich/vet → promote)
  and a one-line "what it owns" table for every file, plus where it's wired (API route,
  `renderJdSourcing()` in the SPA, and the Connected setup). Start there before touching
  the area.

## Workflows
- Documented the **fast local dev loop** in `docs/STRUCTURE.md`: from `integration/`, run
  `npm run dev:fast` (`integration/dev.cjs`) to run `next dev` + auto-resync `assets/` and
  root HTML on change — edits show on refresh with no push/deploy/restart. Reinforced the
  two working rules: push to `main` only after confirming locally (every push auto-deploys),
  and keep one session editing the repo at a time.

## Context: engine additions already on `main`
Since the 2026-06-16 entry the sourcing engine gained several modules (all committed/pushed,
documented in the new README): Laxis browser-worker enrichment (`laxis.ts`), a shared
profile+contact cache (`cache.ts` / `cacheKeys.ts`), deep-vet via Anthropic Message Batches
with sync fallback (`deepVet.ts` / `vetParse.ts`), optional LLM re-rank (`rerank.ts`),
cross-run "seen" memory for fresh-only runs (`seen.ts`), and a dedicated promote module
(`promote.ts`). The API route exposes them as `rerank / vet / vetStatus / laxisEnrich /
laxisStatus` in addition to the original actions.
