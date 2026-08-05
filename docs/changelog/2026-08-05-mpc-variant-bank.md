# MPC variant bank: per-send AI opener spend replaced by a weekly pre-generated bank

Date: 2026-08-05

## What changed

The Day-0 MPC opener used to pay a Haiku call on every single send (the per-send "humanizer"),
estimated at hundreds of dollars a month at full volume. The AI in that path only ever varied
phrasing, never facts, so the rewrite has been moved to the template level and done once:

- `integration/lib/bd/mpc/variantBank.ts` (new): a weekly job rewrites each of the 50 MPC
  templates into ~16 gate-approved phrasing variants with every `{{Merge_Token}}` kept intact,
  and stores them in `mpc-variant-bank.json` on the data volume. Roughly 50 small Haiku calls a
  week, about $2/month total, versus a call per send.
- Send path (`lib/campaigns/cadence.ts`): the first email of an MPC lead now picks a banked
  variant (seeded per prospect, so resends are idempotent), renders it through the normal
  merge-fill, and re-runs the render guard plus the naturalness gate on the result. Any miss
  falls back to the deterministic template copy, exactly the humanizer's old fail-safe contract.
- Refresh rides the hourly `/api/sending/cron` tick and self-gates: it only does real work when
  the bank is older than 7 days, incomplete, or a template was edited. The cron response now
  includes a `variants` report field.
- The per-send humanizer is demoted to an explicit testing switch: it only runs with
  `MPC_HUMANIZER=force` (or 1/true/on/yes) set, and only when the bank had nothing to offer.
  Default behavior is zero AI calls in the send loop.

## Why it is safe

Every banked variant passed the same discipline the humanizer enforced per send: banned-phrase
and em/en dash scan, token-set equality with its source template (no fact slot dropped, none
invented), no new numbers or links, exactly one soft question, bounded length, distinct opening.
At send time the rendered result must additionally clear `guardRenderedTouch`. Variation math
improves: 50 templates x ~16 variants x spintax x per-prospect selection is more surface
diversity than the per-send rewrite achieved with its 400-entry fingerprint window.

## Operator handles

- `npx tsx scripts/mpc-variant-bank.mts --status` shows coverage; `--force` regenerates now;
  `--show 3` prints samples. Needs `ANTHROPIC_API_KEY` to generate.
- Env: `MPC_VARIANTS=0` turns the whole layer off; `MPC_VARIANTS_PER_TEMPLATE` (default 16);
  `MPC_VARIANTS_TTL_DAYS` (default 7); model via `MPC_HUMANIZER_MODEL` or
  `RECRUITEROS_EMAIL_MODEL` (default `claude-haiku-4-5`).
- Until the first refresh runs on a fresh deploy, sends use the deterministic templates; the
  send path nudges a background generation the first time it finds the bank empty.

## Tests

`npx tsx scripts/test-variant-bank.mts` (13 checks): gate accept/reject cases, sign-off split
across all 50 templates, seeded idempotence and cross-prospect variety, send-time guard
rejection, and the humanizer demotion. Existing suites `test-copy-hygiene.mts` (295) and
`test-mail-compliance.mts` (23) still pass; `tsc --noEmit` clean.
