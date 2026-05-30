# RecruiterOS Outreach — Integration Architecture

How the three layers fit together to deliver MeetAlfred-class LinkedIn outreach
inside RecruiterOS, and where every MeetAlfred feature lives.

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  BACKEND  (integration/, Next.js)  — the team brain                    │
 │  workspaces · members/roles · multi LinkedIn accounts (quotas/warmup)  │
 │  campaigns · sequences · enrollments · server-side throttles           │
 │  provider adapter (Unipile | internal) · classified response inbox     │
 │  Auth: ros_session cookie (team) · Bearer token (engine, server-only)  │
 └───────────────▲───────────────────────────────────────▲──────────────┘
                 │ session-authed JSON (same origin)      │ executes via
                 │ /api/accounts /api/prospects            │ Unipile  OR
                 │ /api/campaigns /api/response/list       │ internal provider
                 │                                         │
 ┌───────────────┴───────────────┐         ┌───────────────┴──────────────┐
 │  PORTAL  (Outreach Studio)     │  ros.*  │  EXTENSION  (Chrome MV3)      │
 │  alfred.html + alfred engine   │◀───────▶│  the hands in the browser     │
 │  sequence builder · sim clock  │ bridge  │  - detect logged-in account   │
 │  Leads · Inbox · Analytics     │         │  - Sales Navigator scraper    │
 │  LinkedIn Live tab:            │         │  - queue + limiter + actions  │
 │   • connect extension          │         │  - CSV export                 │
 │   • connect backend            │         │  SAFE by default (simulated)  │
 │   • assign account to campaign │         └───────────────────────────────┘
 │   • push datasets → prospects  │
 └────────────────────────────────┘
```

## The end-to-end flow (a team member's day)

1. **Sign in** to RecruiterOS (backend sets the `ros_session` cookie). Open the
   **Outreach Studio** in the same browser.
2. **LinkedIn Live tab → Connect backend.** The portal calls `GET /api/auth/session`
   and lists your team's **LinkedIn accounts** from `GET /api/accounts` with their
   per-account **daily quotas and warm-up state** (multi-account, MeetAlfred-style).
3. **Assign an account** to the active campaign (the dropdown stores
   `campaign._backendAccountId`).
4. **Source leads.** Leads tab → **Source from Sales Navigator** → paste a
   people-search URL. The **extension** opens it and scrapes every person, page by
   page, into a dataset (the "database").
5. **Push to backend.** On the dataset, **Push to backend** sends the people to
   `POST /api/prospects { action:'bulk', rows }`. They become workspace prospects.
6. **Sequence + launch.** Build the multi-step sequence in the Studio; the backend's
   cadence (`/api/linkedin/cron`) advances enrollments under the **server-side rate
   limiter** (daily caps, working hours, human jitter) and executes via the chosen
   provider.
7. **Replies** flow into the **unified inbox** (`/api/response/list`), classified and
   routed; the portal shows the count and latest messages.

## Two execution modes (pick per workspace)

| Mode | Who performs the LinkedIn action | When to use |
|---|---|---|
| **Cloud (Unipile)** | Backend `unipileProvider` (`RECRUITEROS_OUTREACH_PROVIDER=unipile`) | Hands-off, server-driven, scalable. Needs Unipile creds. |
| **Browser (extension)** | The extension acts through the user's own session | No third-party API; the account owner runs it. Use the LinkedIn Live "Live actions" toggle. |
| **Simulated (default)** | Nothing real; the engine models accepts/replies | Build, demo, and train risk-free. |

**Browser mode is fully wired** via the **Outreach Bridge** (`bridge/`): the backend's
`internalProvider` POSTs actions to the bridge, the extension's agent drains them and
performs them in the user's session, and accept/reply events forward back to the
backend webhook so the cadence advances. Set `RECRUITEROS_OUTREACH_PROVIDER=internal`
and `RECRUITEROS_OUTREACH_URL=http://localhost:8787`. See `bridge/README.md`. (The
portal's `AlfredExtensionBridge` also lets the local engine route steps through the
extension directly, for portal-only use without the backend cadence.)

## Where each MeetAlfred feature lives

| MeetAlfred capability | Lives in | Notes |
|---|---|---|
| Multi-channel sequences (LinkedIn/email/X + delays) | Portal engine + backend sequences | view/follow/endorse/connect/message/inmail/like, email, X |
| Connect-first gating (follow-ups after accept) | Engine + backend enrollment | enforced + unit-tested in `alfred-core` |
| **Multiple LinkedIn accounts** | Backend `/api/accounts` | per-account quotas + warm-up + platform |
| **Assign account to campaign** | Portal LinkedIn Live + `ChannelConfig.linkedinAccountId` | dropdown writes the assignment |
| **Team / seats / roles** | Backend auth (workspaces, owner/admin/member) | `ros_session` |
| **Daily caps + warm-up ramp** | Backend `rateLimiter` + engine `limits` | invites 20, msgs 80, inmail 10, views 60 defaults |
| **Working hours + weekend pause + jitter** | Backend `rateLimiter` + engine safety | per-account timezone |
| Lead sourcing (Sales Navigator) | Extension scraper | paginated, resume-safe, CSV |
| Templates + personalization + A/B | Portal engine + backend `abtest` | merge fields + spintax + variants |
| Smart inbox + reply detection + routing | Backend `response/*` | classify, SLA, suppress, escalate |
| Blacklist / suppression / do-not-contact | Engine blacklist + backend suppression | |
| Analytics (funnel, accept/reply rates) | Portal analytics + backend overview | |
| CRM pipeline / lifecycle | Backend prospects (`queued..won`) | |

## Running it together (local)

```powershell
# 1) Backend (team brain)
cd integration
npm install
npm run dev            # serves the API, e.g. http://localhost:3000

# 2) Portal — either serve it from the backend (same origin = cookies just work),
#    or run the static server and set the backend base URL in the LinkedIn Live tab:
powershell -ExecutionPolicy Bypass -File .\START-STUDIO.ps1   # http://localhost:5173

# 3) Extension
#    chrome://extensions → Developer mode → Load unpacked → ./extension
#    copy its ID → Studio → LinkedIn Live → paste ID → Connect extension
```

**Same-origin tip:** for the session cookie to reach the portal automatically, serve
`alfred.html` and the static site from the Next.js app (e.g. drop them in
`integration/public`, or add a catch-all). Otherwise set the backend base URL and
enable CORS for the portal origin on the backend.

## Security / compliance
- `RECRUITEROS_API_TOKEN` and `RECRUITEROS_CRON_SECRET` are **server-side only** —
  the portal and extension never see them. The portal uses the session cookie; the
  extension drives only the user's own browser session.
- Automating LinkedIn can violate its ToS. Use for the account owner's own
  authorized outreach, keep volumes humane (the throttles default conservative),
  and honor opt-outs and suppression.
