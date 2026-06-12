# Parameterized Content Library

A pre-authored, parameter-keyed outreach content pool. As a lead is enriched the
engine pulls **rich, on-voice, multi-channel copy** for it instantly — no LLM call
on the send path. The richness is authored up front in fragment packs; the resolver
just composes it for each person.

## Why this exists (vs the runtime LLM drafter)

The repo already has a runtime LLM drafter ([lib/bd/personaMessaging.ts](../../bd/personaMessaging.ts))
that calls Claude per lead. This library is the complement, not a replacement:

| | This library (static pool) | LLM drafter (personaMessaging) |
|---|---|---|
| Latency | microseconds | ~1-3 s per lead |
| Cost | $0 per send | tokens per lead |
| Failure on send path | none (pure function) | API errors / rate limits |
| Reviewable / versioned | yes (in git) | no (generated each time) |
| Ceiling on personalization | high (segment-level) | highest (per-lead reasoning) |

Best practice is **hybrid**: this pool is the instant, free, always-on default for
every lead at any volume; reserve the LLM drafter for high-value / hot leads where
per-lead reasoning earns its cost. They share the same taxonomy, so a lead can be
upgraded from pool copy to LLM copy without re-keying anything.

## Selection key

`industry × function × seniority × signal × motion → channel/touch`

Fallback chain guarantees a non-empty, on-voice message for **any** input:
unknown industry → `general`, unknown function → `other`, unknown signal → a generic
timing opener. Nothing renders empty.

## Files

- `taxonomy.ts` — types, key lists, the slot contract.
- `industries.ts` — `INDUSTRY_PACKS` (11): context, pains, value angles, proof framings, vocabulary, recruiting pitch.
- `functions.ts` — `FUNCTION_PACKS` (13): cares-about, pains, hooks, recruiting angle, objections.
- `signals.ts` — `SIGNAL_ANGLES` (all signal types): BD + recruiting opener per signal.
- `tone.ts` — `SENIORITY_TONE` (10): register + CTA per level.
- `templates.ts` — `TOUCH_TEMPLATES`: the 28-day anatomy as composable, motion-aware touches (email ×7, LinkedIn connect/DM/voice-note, voicemail drop, SMS ×2).
- `resolver.ts` — selection + render + fallback. The engine.
- `index.ts` — public surface.

## Usage

```ts
import { pullForProspect } from "lib/content/library";

const seq = pullForProspect({
  title: "VP of Engineering", company: "Northwind Pay", industry: "fintech",
  firstName: "Dana", warmth: 88, motion: "bd", signal: "funding_round",
  sender: "Ryan", calendarLink: "cal.com/ryan", callbackNumber: "+1-555-0100",
});
// seq.touches -> ready-to-send email/LinkedIn/voice/SMS, day-sequenced.
// Hot-only touches (voicemail drop, LinkedIn voice note) appear only when
// warmth >= voiceThreshold (default 80), mirroring RecruiterOS.
```

`pullForProspect` classifies the title into function + seniority and infers the
industry, so callers hand in raw enriched-lead data and get copy back. Pass explicit
`function`/`seniority`/`industry` to `craftSequence` to bypass classification.

## Where it is wired

- **Daily cadence drafter** — [lib/campaigns/cadence.ts](../../campaigns/cadence.ts) `draftsFor()` pulls each queued lead's day-0 touches (opening email + LinkedIn connect + warm voicemail) from this pool into the approval queue. This is the "crafted as leads come in" path.
- **API** — `GET/POST /api/content/craft` ([route](../../../app/api/content/craft/route.ts)) pulls by query params or a prospect body; `?action=coverage` reports library size.
- **n8n** — the outreach-router workflow's "Craft Preview" node calls `/api/content/craft` so the routing response shows the exact targeted copy per lead.

## Authoring / extending

- Add a sector: extend `IndustryKey` in `taxonomy.ts`, add the pack in `industries.ts`, add an inference regex in `resolver.ts` `INDUSTRY_INFER`.
- Add a touch: append a `TouchTemplate` to the right array in `templates.ts`. Tag `motions: ["bd"]` / `["recruiting"]` for motion-specific framing; omit for both.
- House style for every fragment: plain text, no emojis, never a fabricated statistic (use `{placeholder}` tokens for numbers — the approval queue or LLM-polish fills them).

## Deepening with LLM credits (optional)

The static pool is segment-level. To pre-generate per-lead exemplars for the highest
-value combinations, run the LLM drafter ([generatePersonaMessage](../../bd/personaMessaging.ts))
in a batch and store the results — the pool and the drafter share the taxonomy, so
generated copy slots into the same channels. Not required for the pool to work.
