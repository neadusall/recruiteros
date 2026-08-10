# Sending.ac Mailbox API - sending the lume fleet without credentials

How the ~900 Sending.ac lume mailboxes send from RecruitersOS with **no SMTP password and
no CSV import**, and the one env var that turns them on.

## Why this exists

The lume fleet is Microsoft 365 mailboxes connected to Smartlead over OAuth. OAuth carries
no SMTP password, so those boxes imported credential-less and the SMTP send hop could never
sign in as them. Every route to get their passwords was a dead end:

- Smartlead API / UI export - returns no password for OAuth mailboxes.
- Sending.ac Provisioning API - advertised, but every `/v1` endpoint returns route-not-found
  and both advertised hosts are NXDOMAIN. Not deployed.
- Sending.ac CSV export - in this account produced the tal fleet, not lume.

The **Mailbox API** sidesteps all of it. It is a Microsoft Graph drop-in proxy that sends
and reads mail **as any mailbox you own**, authenticated by one account-level key plus the
mailbox's own address. No per-mailbox credential exists in the model, which is why no export
was ever going to work.

Verified 2026-08-10: a real email sent from `ryan.nead@lumesearchgroup.com` to the owner
inbox returned `202 Accepted`.

## The API

| | |
|---|---|
| Base | `https://api.customers.ac/api/mailbox/v1alpha1` (the `/api` prefix is mandatory) |
| Graph surface | under `/azure/v1.0` |
| Auth | `Authorization: Bearer sk_live_…` - a **Mailbox**-scope key |
| Rate limit | 60 requests/minute/key (`429` + `Retry-After`) |
| Mailboxes | Microsoft 365 only; `/google/` returns `501` |

Allow-list (everything else `404`s):

| Method | Path |
|---|---|
| POST | `/azure/v1.0/users/{email}/sendMail` |
| GET | `/azure/v1.0/users/{email}/messages` |
| GET | `/azure/v1.0/users/{email}/messages/{id}` |
| GET | `/azure/v1.0/users/{email}/mailFolders` |

Key scope matters: a **Provisioning** or sandbox key is rejected with `403 "This API key is
not a Mailbox API key"`. A mailbox that is not yours returns `404`, never `403`.

## Turning it on

One env var on `ros`, then restart:

```
SENDINGAC_MAILBOX_API_KEY=sk_live_xxxxxxxx
```

Generate it at **api.customers.ac → Production Credentials → Create key → scope "Mailbox"**.
That is the whole activation. The 900 lume addresses are already in the senders store, so
nothing needs importing.

## How it routes

`sendViaInbox` (`lib/senders/smtp.ts`) checks `canSendViaMailboxApi(m)` first:

```
canSendViaMailboxApi(m) = mailboxApiConfigured() && m.provider === "sending-ac" && !m.smtpPassEnc
```

That single condition splits the two fleets cleanly:

- **lume** - `sending-ac`, no stored SMTP password → sends via the Mailbox API.
- **tal** - `sending-ac`, real SMTP login stored (`talfleet.austin.inboxalways.com`) → keeps
  sending by SMTP, untouched. A tal address is never handed to the proxy (it would 404).

Pool eligibility (`lib/senders/pool.ts`) and the go-live capacity check
(`lib/sending/goLive.ts`) both now count a box as sendable when it has an SMTP login **or**
is Mailbox-API-sendable, so the lume pool stops reading as zero capacity the moment the key
is set. With no key configured, a credential-less lume box stays tracked-only exactly as
before - this change is inert until `SENDINGAC_MAILBOX_API_KEY` exists.

## Behavior worth knowing

- **No auto-retry on send.** `202` = accepted. A `502` is ambiguous (Microsoft may already
  have sent), so `sendViaMailboxApi` reports it as sent-but-unconfirmed (`ok:true`) rather
  than a clean failure - the prospect is never mailed twice. `429`/`503` come back as
  failures the cadence retries on its next tick.
- **Threading is limited.** Graph `sendMail` only accepts `x-` internet headers, so a
  `Message-ID` / `In-Reply-To` cannot be forced; Microsoft assigns the Message-ID. Reply
  threading for this fleet rides on subject + recipient, not RFC headers.
- **v1alpha1 is unstable.** Sending.ac can change endpoints/payloads without notice. If sends
  start failing with new error shapes, re-read the guide before assuming a regression.

## Tests

```bash
cd integration && npx tsx scripts/test-mailbox-api.mts   # 13 tests
```

Stubs the Graph proxy: transport selection, payload mapping, `202`/`502`/`404`/`403`
handling, reply read, and that the rotation picks a lume box only once the key is set.

## Files

| Path | What it is |
|---|---|
| `integration/lib/senders/mailboxApi.ts` | Mailbox API client (send, read, ping, routing predicate) |
| `integration/lib/senders/smtp.ts` | `sendViaInbox` routes lume → Mailbox API |
| `integration/lib/senders/pool.ts` | eligibility counts API-sendable boxes |
| `integration/lib/sending/goLive.ts` | capacity counts API-sendable boxes |
| `integration/scripts/test-mailbox-api.mts` | test suite against a stub |
