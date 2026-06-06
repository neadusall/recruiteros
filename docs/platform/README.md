# Platform Reference — `integration/lib/` domains

This is the **develop-fast index** for the backend. Every feature of RecruiterOS lives in a
domain folder under [`integration/lib/`](../../integration/lib/). Find your feature below, open the
linked reference for the full breakdown (purpose, key files, entry points, where to start), then go
straight to the `lib/<domain>/` folder and build.

> All three reference files follow the same shape per domain:
> **Purpose · Key files · Main exports/entry points · Depends on · Start here.**

---

## Find your feature

| I want to work on… | Domain | Reference |
|---|---|---|
| Sending a touch (email/LinkedIn/SMS/voice) | `channels` | [outreach-and-messaging](outreach-and-messaging.md) |
| Outreach-tab readiness/health | `outreach` | [outreach-and-messaging](outreach-and-messaging.md) |
| SMS send + two-way replies | `sms` | [outreach-and-messaging](outreach-and-messaging.md) |
| Voice Drops (voicemail) | `voice` | [outreach-and-messaging](outreach-and-messaging.md) |
| Message sequences (authored touches) | `sequences` | [outreach-and-messaging](outreach-and-messaging.md) |
| Campaigns + daily cadence | `campaigns` | [outreach-and-messaging](outreach-and-messaging.md) |
| Content/asset library | `content` | [outreach-and-messaging](outreach-and-messaging.md) |
| Inbound reply pipeline (classify/route) | `response` | [outreach-and-messaging](outreach-and-messaging.md) |
| Prospect pipeline lifecycle | `prospects` | [people-and-data](people-and-data.md) |
| Saved audiences | `prospect-lists` | [people-and-data](people-and-data.md) |
| Which motion LinkedIn scrapes land in | `importmotion` | [people-and-data](people-and-data.md) |
| "Who's in market" BD search | `inmarket` | [people-and-data](people-and-data.md) |
| Hiring signals + enrichment waterfall | `signals` | [people-and-data](people-and-data.md) |
| JD → ranked candidates (sourcing) | `sourcing` | [people-and-data](people-and-data.md) |
| LinkedIn engine (provider + cadence) | `linkedin` | [people-and-data](people-and-data.md) |
| People-data warehouse | `data` | [people-and-data](people-and-data.md) |
| Persistence / snapshots | `db` | [people-and-data](people-and-data.md) |
| LinkedIn accounts / domains / API keys | `accounts` | [platform-and-infra](platform-and-infra.md) |
| Auth, sessions, RBAC, teams | `auth` | [platform-and-infra](platform-and-infra.md) |
| Owner back office | `owner` | [platform-and-infra](platform-and-infra.md) |
| Cost/usage/pricing ledger | `billing` | [platform-and-infra](platform-and-infra.md) |
| External provider registry | `providers` | [platform-and-infra](platform-and-infra.md) |
| Integration pre-flight checks | `connected` | [platform-and-infra](platform-and-infra.md) |
| ATS sync (Loxo) | `ats` | [platform-and-infra](platform-and-infra.md) |
| The shared repository/data boundary | `core` | [platform-and-infra](platform-and-infra.md) |
| Dashboard read model | `overview` | [platform-and-infra](platform-and-infra.md) |
| Demo/dev seeding | `dev` | [platform-and-infra](platform-and-infra.md) |
| Chrome-extension ingest tokens | `exttoken` | [platform-and-infra](platform-and-infra.md) |

---

## The three references

- **[outreach-and-messaging.md](outreach-and-messaging.md)** — how touches go out and replies come back:
  `channels`, `outreach`, `sms`, `voice`, `sequences`, `campaigns`, `content`, `response`.
- **[people-and-data.md](people-and-data.md)** — who you reach and the data behind it:
  `prospects`, `prospect-lists`, `importmotion`, `inmarket`, `signals`, `sourcing`, `linkedin`, `data`, `db`.
- **[platform-and-infra.md](platform-and-infra.md)** — the foundation everything sits on:
  `accounts`, `auth`, `owner`, `billing`, `providers`, `connected`, `ats`, `core`, `overview`, `dev`, `exttoken`.

> **Convention:** a new feature = a new `integration/lib/<domain>/` folder with an `index.ts`
> barrel, plus an entry in the table above. Keep one domain = one concern.
