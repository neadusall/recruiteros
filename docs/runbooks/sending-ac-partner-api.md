# Sending.ac Partner API - turning the fleet on

How the ~1,450 Sending.ac mailboxes go from "imported but unsendable" to actually sending
from RecruitersOS, and the two things a person has to do to get there.

## The problem this solves

The Sending.ac fleet is provisioned as Microsoft 365 mailboxes and mirrored into
RecruitersOS through Smartlead. That mirror connects over **OAuth, which carries no SMTP
password**. `lib/senders/pool.ts` refuses any inbox without stored credentials, so every
one of those mailboxes imported as a tracked row the rotation would never pick. The Send
Queue showed capacity that could never be spent.

There was no way around it from inside Smartlead. The Partner API is the fix.

## What the Partner API actually is

**It is a provisioning API, not a send API.** There is no "send message" endpoint and
there is no "read inbox" endpoint - do not go looking for one. What it exposes is:

```
GET /senders                          the sender groupings on your account
GET /senders/{id}/mailboxes           the mailboxes under one, ?include=credentials
GET /mailboxes/{id}/credentials       IMAP + SMTP host, port, username, password
GET /users, /domains, /operations     account + provisioning bookkeeping
```

So "receiving and sending email" happens the way it always has in this codebase: the API
hands over IMAP/SMTP logins, `lib/senders/smtp.ts` sends through them and
`lib/senders/replySync.ts` reads replies from them. Nothing about the send path changes -
the mailboxes simply stop being credential-less.

| | |
|---|---|
| Live host | `https://live-api.customers.ac/v1` *(advertised; see below)* |
| Sandbox host | `https://sandbox-api.customers.ac/v1` (no real infrastructure) |
| Auth | `Authorization: Bearer <key>` |
| Rate limit | 120 requests/minute/token, `429 rate.quota_exceeded` + `Retry-After` |
| Pagination | cursor: `page[size]` (max 100) + `page[after]` |
| Scopes needed | `senders:read`, `mailboxes:read` |

## Blocked: the API is not reachable yet (checked 2026-08-07)

Two things the published spec says are not true of the running service, so verify both
before assuming a key is broken:

1. **Neither advertised host exists.** `live-api.customers.ac` and
   `sandbox-api.customers.ac` are both **NXDOMAIN**. The only host that resolves is
   `api.customers.ac`, which serves the dashboard and `openapi.json` but has **no API
   routes deployed** - every path returns Laravel's `"The route ... could not be found."`,
   which is route-not-found, not an auth failure.
2. **Key format differs.** The spec documents `sac_live_…` / `sac_test_…`; the key
   actually issued was `sk_sandbox_…`.

Consequences for this code, both handled:

- `SENDINGAC_API_BASE` overrides the host and is the mechanism for pointing at whatever
  Sending.ac actually ships, with no code change. It is not optional today.
- Key classification matches the environment **word** (`live|prod|production` vs
  `test|sandbox|dev`) anywhere in the prefix, not one literal. Anything unclassifiable is
  treated as **sandbox**: guessing "live" for an unrecognised key is the only guess that
  can aim a non-production key at production infrastructure. Matching only `sac_test_`
  would have sent the real `sk_sandbox_` key to the live host.

A **sandbox** key is not enough for the real goal either way. Per the spec's own words,
sandbox provisions no real infrastructure, so it can never return the real fleet or its
passwords. **A live key is required.**

## Steps

### 0. Get a working base URL and a LIVE key from Sending.ac

Blocked on them, per the section above. What to ask for:

- the real base URL for the Partner API, since neither host in their spec resolves;
- a **live** key (`sk_live_…` or whatever they issue), not sandbox;
- confirmation that the key carries `senders:read` and `mailboxes:read`.

The "Production Server name" their key form asks for is a label on their side. The API
has no allowlist, IP binding or host field anywhere in the spec, so it does not restrict
where the key can be called from.

### 1. Generate the key (only a person can do this)

Sign in at <https://api.customers.ac/request-live-setup> with the sending.ac account
(it redirects through `sso.ac`). Generate a key with **`senders:read` and
`mailboxes:read`**. No write scopes: RecruitersOS never creates or deprovisions upstream
infrastructure, and a key without write scopes means a bug here cannot tear down a
mailbox fleet.

### 2. Prove the key works before wiring anything

```bash
SENDINGAC_API_KEY=sac_live_xxx node integration/scripts/sendingac-probe.mjs
```

Read-only. It prints, per sender, how many mailboxes carry an SMTP password. The line
that matters:

```
With SMTP password     : 1450   <- these can send from RecruitersOS
```

If that number is 0 but mailboxes exist, they are not `active` upstream yet - credentials
are only issued for active mailboxes, so re-run later. If it fails with `auth.invalid_key`
the key is wrong or from the wrong environment; `auth.insufficient_scope` means the two
read scopes above are missing.

`--full` lists every mailbox. `--csv out.csv` writes a credential CSV - that file holds
live passwords in the clear, so delete it once imported.

### 3. Put the key on the server

On `ros`, add to the app env and restart:

```
SENDINGAC_API_KEY=sac_live_xxx
```

### 4. Pull the logins

Senders tab -> **"Pull Sending.ac logins"**. It reports how many mailboxes are ready to
send. Nothing else is needed: the tab also re-pulls on its own at most every 6 hours, so
credentials rotated upstream heal without anyone watching.

## What the sync does

`lib/senders/sendingAcSync.ts` walks every sender, pulls its mailboxes with
`include=credentials` (one request per 100 mailboxes - ~15 requests for the whole fleet,
not 1,450), and writes each into the portal pool its domain belongs to.

Portal routing is shared with the Smartlead sync through `buildPortalRouter()`
(`lib/senders/fleetSync.ts`), so both import paths put a mailbox in the **same** portal.
When each carried its own copy of that rule, the same lookalike domain could land in the
Lume pool via one sync and the house pool via the other - and the house workspace must
never send cold email speaking as a tenant's brand.

The two syncs are complementary and both are idempotent, so order does not matter:

- **Smartlead sync** - discovers mailboxes, warm-up reputation, health.
- **Partner API sync** - attaches the IMAP/SMTP credentials.

### What it will not do

- **Never blanks a working login.** If a run returns no credentials for a mailbox that
  has them stored, `addInbox` keeps the stored password with its host/port/user. Losing
  1,450 working logins to one bad network minute is the failure mode this is most careful
  about, and it is covered by a test.
- **Never resets the ramp.** `createdAt` survives a re-import; the cold-send ramp and the
  minimum-age gate are both measured from it, so restamping would hold the fleet at zero
  capacity forever.
- **Never overrides an operator.** Status and recruiter assignment carry across. The one
  exception is an upstream `suspended`/`deprovisioned` mailbox, which is paused with the
  reason recorded so the Senders tab shows a cause rather than a mystery.
- **Never writes upstream.** Read verbs only.

## Go-live checklist change

The "Inboxes assigned to that recruiter" row now counts **only inboxes that hold an SMTP
login**. It previously counted every assigned inbox, so a fully credential-less Sending.ac
pool reported the campaign as ready for sends that had nowhere to go. When inboxes are
assigned but none can send, the row now says so and points at the button.

## Tests

```bash
cd integration && npx tsx scripts/test-sendingac-api.mts   # 15 tests
```

Runs against a local stub of the Partner API: key/host routing, pagination across 250
mailboxes, 429 retry, typed auth errors, the credential import, the never-blank guard,
upstream suspension, and a failed run leaving stored logins untouched.

## Files

| Path | What it is |
|---|---|
| `integration/lib/senders/sendingAcApi.ts` | Partner API client (read-only, paced, paginated) |
| `integration/lib/senders/sendingAcSync.ts` | Credential sync into the portal pools |
| `integration/lib/senders/fleetSync.ts` | `buildPortalRouter()`, shared domain -> portal rule |
| `integration/scripts/sendingac-probe.mjs` | Standalone key/credential probe |
| `integration/scripts/test-sendingac-api.mts` | Test suite against a stub API |
| `integration/app/api/senders/route.ts` | `sync-sendingac`, `ping-sendingac` actions |
