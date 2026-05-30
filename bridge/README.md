# Outreach Bridge — browser-execution seam

Closes the gap between the **backend cadence** (which decides *what* LinkedIn action
to run and *when*, under the rate limiter) and the **browser extension** (which
performs it through the user's own LinkedIn session). No Unipile, no third party.

```
backend cadence ──POST /connect /message …──▶  BRIDGE  ◀──poll/report──  extension
   (internalProvider)                       per-account queues          (browser)
            ▲                                                                │
            └────────── POST /api/linkedin/webhook ◀── forward accept/reply ─┘
```

## Run it
```powershell
node bridge/outreach-bridge.cjs        # http://localhost:8787
node bridge/bridge.test.cjs            # end-to-end self-test (13 assertions)
```
Config via env, see `.env.example`.

## Backend side
Point the backend's internal provider at the bridge:
```
RECRUITEROS_OUTREACH_PROVIDER=internal
RECRUITEROS_OUTREACH_URL=http://localhost:8787
RECRUITEROS_OUTREACH_TOKEN=dev-outreach-token   # == bridge OUTREACH_TOKEN
```
The backend's `internalProvider` then POSTs `/connect`, `/message`, `/inmail`,
`/view`, `/endorse`, `/withdraw`, `/voice`, `/resolve`, `/messages` to the bridge.

## Extension side
Popup → Settings → **Browser-execution agent**:
- Bridge URL: `http://localhost:8787`
- Agent token: matches the bridge `AGENT_TOKEN`
- Backend account id: the `LinkedInAccount.id` this browser session represents
- Enable it.

The extension then polls `/agent/poll`, navigates to each target profile, performs
the action (respecting Live mode + daily caps + working hours), and reports via
`/agent/report`. Observed accepts/replies post to `/agent/event`, which the bridge
forwards to the backend webhook so the engine fires accept-triggered follow-ups and
pauses on reply.

## Endpoints
| Caller | Method + path | Purpose |
|---|---|---|
| backend | POST /resolve /connect /message /inmail /voice /view /endorse /withdraw /messages | enqueue an action (optimistic ok), return providerMessageId |
| extension | POST /agent/poll `{accountId}` | claim the next queued action for that account |
| extension | POST /agent/report `{actionId, ok, providerMessageId, info}` | record the result |
| extension | POST /agent/event `{type, accountId, providerProfileId, text?}` | accept/reply → forwarded to backend webhook |
| anyone | GET /health, POST /agent/status | diagnostics |

In-memory by design (reference impl). Swap the queues/maps for Redis to run across
workers in production.
