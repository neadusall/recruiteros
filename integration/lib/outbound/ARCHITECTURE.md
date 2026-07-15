# Outbound Performance, Utilization & User Accountability System

The Admin Portal's "Outbound Performance" section plus the user-facing "My Outbound"
daily worksheet. This is a NORMALIZED ANALYTICS LAYER over systems that already
record activity; it introduces no duplicate tracking and no second admin app.

## Existing systems reused (the fact sources)

| Signal | Source of truth | Where |
|---|---|---|
| Email / LinkedIn / SMS / voice sends | core `ActivityEvent` (`*_sent`, stamped campaignId/variant/touch) | `lib/core/repository.ts` (`listAllActivity`) |
| Replies + classification (positive/soft_yes/stop/...) | Response pipeline `ProcessedResponse` | `lib/response` (`recentResponses`) |
| Meetings | `prospect.status="booked"` + `bookedAt` + `discovery_call_booked` events | `lib/core` |
| LinkedIn actions (connect/message/voice note/profile view/InMail), caps, reservations | LinkedIn OS ledger `LiActionRecord` | `lib/linkedin/os/ledger.ts` |
| LinkedIn daily capacity + safe limits + health | `AccountPolicy` x `capacityFactor(account)` | `lib/linkedin/os/{policy,health}.ts` |
| Connection accepts | `PersonIdentity.connectedAt` + `linkedin.connection.accepted` events | `lib/linkedin/os/identity.ts` |
| LinkedIn inbox needing attention | `LiConversation.needsAttention/unread` | `lib/linkedin/os/inbox.ts` |
| LinkedIn posts | Poster drafts (`status:"posted"`, `postedAt`) | `lib/linkedin/poster.ts` |
| Email capacity (mailboxes, hard 2/day cold caps, per-recruiter pools) | `sendCapacity(ws)` | `lib/senders/store.ts` |
| Deliverability (bounce/spam/opens per domain) | Postal `DeliveryMetrics` | `lib/sending/store.ts` |
| Campaign supply (queued contacts, send-ready gate) | prospects `status:"queued"` + `prospectReadiness` | `lib/core` + `lib/sending/sendReady.ts` |
| Users / roles / sessions (last login) | auth store (`listMembers`, sessions) | `lib/auth` |
| Notification transport (email) | MTA -> sender-pool fallback, same as `notifyReply` | `lib/providers/mta`, `lib/senders` |
| Notification transport (SMS) | `telnyxSms` provider | `lib/sms/provider.ts` |
| LLM | `anthropicClient()` | `lib/sourcing/anthropic.ts` |
| Scheduler | `TICKS` in the in-process clock (gated by AUTOMATION_ENABLED) | `lib/automation/scheduler.ts` |
| RBAC | `requireCapability` (`team:manage`, `analytics:view`) | `lib/api.ts` |

## What is genuinely new

New module `lib/outbound/*` (this directory):

- `types.ts`   - normalized event names (EMAIL_SENT, LINKEDIN_CONNECTION_SENT, ...), rollups, goals, alerts, score, checklist shapes.
- `events.ts`  - the normalizer: joins the fact sources above into per-user
                 `OutboundEvent`s. Attribution chain: `prospect.ownerId` ->
                 `campaign.recruiterId` -> sender `inbox.ownerId` -> unattributed
                 (shown honestly as workspace-level, never guessed onto a user).
- `rollup.ts`  - daily + hourly aggregation, persisted (`outbound_rollups_v1`) so
                 dashboards never rescan raw events and history survives ledger caps.
- `capacity.ts`- the Capacity Utilization Engine: per-user email capacity
                 (mailboxes x hard cold caps), shared LinkedIn account capacity
                 (policy targets x health factor, recruiting+BD combined), SMS
                 capacity (goal-configured), and CAMPAIGN SUPPLY so a user with
                 no contacts queued is flagged as a supply constraint, not blamed.
- `health.ts`  - system-health correlation: mailbox paused/error, domain red,
                 LinkedIn account cooldown/disconnected/kill switch, automation off,
                 Telnyx/OS Text absent, no active campaigns.
- `goals.ts`   - target configuration with inheritance global -> role -> user
                 (the model has no team entity; role is the team tier), stored in
                 `outbound_goals_v1`. Every change is audit-logged.
- `score.ts`   - Outbound Utilization Score 0-100 with published methodology;
                 channels a user cannot use are excluded and reweighted, never
                 counted as zeros.
- `triggers.ts`- trigger engine (warning/critical/opportunity/achievement/info)
                 with admin-configurable thresholds; emits user + manager alerts
                 into `outbound_alerts_v1`, deduped per user/kind/day.
- `notify.ts`  - per-user notification prefs + required categories; in-app store
                 (`outbound_notify_v1`), email + SMS delivery; morning / midday /
                 end-of-day builders driven by the real numbers.
- `insights.ts`- AI layer: per-user daily assessment + action plan and the admin
                 "Operations Director" brief. Numbers are computed FIRST and the
                 LLM only narrates them; deterministic fallback when no key.
- `checklist.ts`- the 10-15 minute Daily Worksheet: ordered steps, each with
                 Today's Target / Current / Remaining / Action Required; steps
                 auto-complete from live numbers, manual ticks persisted per day.
- `audit.ts`   - admin config audit log (`outbound_audit_v1`): admin, change,
                 previous value, new value, timestamp.
- `report.ts`  - CSV exports (user / team / channel / history).
- `worker.ts`  - the scheduler tick body: refresh rollups, evaluate triggers,
                 deliver scheduled notifications in each workspace's configured
                 windows/timezone/working days.

## API surface

- `GET/POST /api/outbound`       - view dispatch (`?view=team|user|me|checklist|goals|triggers|alerts|notifications|insights|methodology|audit`)
                                   + action dispatch (goals_put, trigger_put, check,
                                   notify_prefs, mark_read, insights_refresh, ...).
                                   Team/admin views need `team:manage`; `me` views
                                   need only a session and are self-scoped.
- `GET /api/outbound/export`     - CSV (`?report=team|user|channels|history`), `team:manage`.
- `POST /api/outbound/cron`      - redundant external trigger for the tick.

## Scheduler

One new `TickSpec` (`outbound`, default 10 min) in `lib/automation/scheduler.ts`;
same overlap-guard / unref / AUTOMATION_ENABLED discipline as every other tick.

## Frontend

- Admin Portal (`command.html` + `assets/js/command.js`): nav item "Outbound
  Performance" under the Admin group (`team:manage`), route `outbound` with
  chip sub-views: Overview (AI insights + KPIs + heatmap), Team, User profile
  drill-down, Channels, Capacity, Alerts & Triggers, Goals, Reports.
- Both portals: "My Outbound" route (`myoutbound`), the personal performance
  view + Daily Checklist worksheet.
- Styles appended to `assets/css/command.css` (`ob-` prefix), Meridian system:
  light-first, `--brand` accent, fg/bg status pairs, SVG icons, no gradients.

## Honesty rules baked in

- Supply constraint beats underutilization: a user is never flagged red for
  capacity they had no contacts to spend.
- System-health causes (paused mailbox, cooling LinkedIn account, automation
  off) are surfaced on the profile before any judgment about effort.
- Unattributed activity is reported at workspace level, not invented per user.
- Low-volume rates carry the same honesty flags the Outreach Statistics tab uses.
