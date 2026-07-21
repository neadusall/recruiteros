# OS Text Performance: what every stat means

The admin "OS Text Performance" tab (`/admin#ostextkpi`, cap `team:manage`) is one
data call: `GET /api/ostext/kpi?days=N`. The portal merges three sources:

1. **Engine rollup** `money-maker-sms /api/kpi-stats?days=N` (`src/lib/kpi-stats.ts`)
2. **Engine lifetime accuracy** `/api/phone-accuracy` (`src/lib/phone-accuracy.ts`)
3. **Supply rollup** from saved JD Sourcing runs + Boost billing ledger
   (`integration/lib/sourcing/ostextKpi.ts`)

Frontend: `assets/js/command.js` `renderOstextKpi` + `otk*` helpers.

## The window

Everything windowed uses the SAME period: the last N **calendar days in
APP_TIMEZONE** (prod: America/New_York), today included. `days=30` = today plus
the 29 days before it. This was changed from a rolling `now() - N*24h` cutoff on
2026-07-21 (engine 06c0c35) so the headline tiles always equal the sum of the
daily trend series; before that the rolling cutoff kept a partial extra day the
day axis never rendered.

Supply-side windowing matches by run `updatedAt`; Boost by ledger event time.
Not windowed by design: engine gauges (contacts by status, campaign counts,
freshness stamps: "what is the engine holding right now") and the source
scoreboard's outcome columns (engine lifetime ledger; only its "On lists"
column is windowed).

## Funnel stages (engine side = distinct contacts, not messages)

| Stat | Source of truth |
|---|---|
| Leads on lists | rows across recruiting runs updated in the window |
| With a phone | those rows with any phone filled |
| Checked / Cell-verified | `phone_check_outcomes` rows in window (`kept` = cell). Real Telnyx lookups only; verdict-cache hits do not re-record |
| Texted | distinct contacts with an outbound message in window |
| Delivered | distinct contacts with an outbound message with carrier status `delivered` in window |
| Replied | distinct contacts with an inbound message in window (INCLUDES people whose only reply was STOP) |
| Positive | distinct contacts whose conversation classification is one of positive/curious/referral/asked_* |
| Opted out | distinct phones in `suppressed_numbers` with `reason='opted_out'` created in window |

Messages block counts MESSAGES, funnel counts CONTACTS; "Texts sent" includes
statuses sent/delivered/failed ("unconfirmed" = still status `sent`, no carrier
receipt yet).

## Rates on the tiles

- Cell rate = cellConfirmed / checked
- Delivery rate = deliveredMsgs / sentMsgs (messages, not contacts)
- Reply rate = replied contacts / delivered contacts
- Positive reply rate = positive / delivered contacts
- Opt-out rate = optedOut / delivered contacts
- Cost per reply = window spend / replied contacts, where window spend = SMS
  (segment-estimated) + LLM (metered `usage_events`) + Telnyx lookups + profile
  enrichment + Boost. Same composition as the "What this window cost" card, so
  the two can never disagree (aligned 2026-07-21).

Benchmark coloring only starts past a 25-sample floor.

## Costs

- SMS: outbound GSM-7 segments (incl. the STOP footer) x `SMS_OUT_COST`
  (default $0.0079) + inbound x `SMS_IN_COST` ($0.001). ESTIMATE, not a Telnyx
  invoice.
- LLM: exact, from `usage_events` (every Anthropic call is metered).
- Lookups: window check count x `TELNYX_LOOKUP_COST` (default $0.0025).
- Enrichment: profiles enriched in window x `RAPIDAPI_PROFILE_COST`.
- Boost: billing-ledger `premium_phone_boost` events (exact).

## Data-correctness history (why numbers before 2026-07-21 look different)

- **Opt-outs read 0 until 2026-07-21.** The STOP path's suppression insert
  collided with the sender's earlier reason-`sent` row for the same
  (campaign, phone) and was silently dropped (`onConflictDoNothing`), so
  `reason='opted_out'` rows never existed. Fixed with an upsert (engine
  06c0c35: `src/lib/opt-out-record.ts`); the 8 historical STOP suppressions on
  prod were retagged to `opted_out` with `created_at` set to the STOP
  conversation's last message time (one-time SQL, 2026-07-21).
- **Unclassified replies.** Replies that arrive while `ANTHROPIC_API_KEY` is
  missing/broken get no classification, so reply mix / positive / wrong-number
  undercount. Since 06c0c35 the internal clock's classify-backlog drain triages
  them automatically (90-day lookback, 4 per 30s sweep) once a key is present.
  The engine reports `engine.triageReady` (key present) and
  `engine.unclassifiedReplies` (backlog size); the tab shows a red "AI reply
  triage off" pill and an n/a Positive tile when triage is down, and an amber
  "N replies awaiting triage" pill while the backlog drains. Source tripwires:
  `src/lib/__tests__/opt-out-ledger.test.ts` pins the whole opt-out ledger
  contract (upsert, both stop paths, cooldown immunity, KPI reason filter).
- **Phone-check ledger starts 2026-07-21.** `phone_check_outcomes` has no rows
  before then, so windows reaching further back show checks only from that date
  (texting history goes back to 2026-07-17). Checked/cell-verified and the
  texted cohort only line up causally for pushes after the ledger existed.
- **Engine gauges exclude archived contacts** (`deleted_at IS NULL`): a contact
  archived by the duplicate guard or a list wipe leaves the status gauge but
  keeps its message history in the windowed stats.

## Known limits

- JD Sourcing has no per-lead email-source tag (only `phoneSource`), so email
  attribution by rung is not possible without stamping emailSource at the
  koldinfo/laxis/gapfill merge sites.
- The source scoreboard's outcome columns are engine-lifetime, not windowed.
- Day bucketing uses the ENGINE's timezone; a viewer in another timezone can
  see edge-day drift on the trend axis.
- Supply "phones on lists" vs engine "contacts in campaign" legitimately differ:
  the Telnyx cell-only gate deletes landline/VoIP/toll-free on import.
