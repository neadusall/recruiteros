# Internal Automation — the in-process n8n replacement

RecruitersOS now runs its own outreach clock. The external **n8n** conductor is no
longer required: every engine n8n used to ping (cadence drafter, LinkedIn sequence
engine, voice-drop dialer, email warm-up, 6-month nurture) already lived inside the
app as a function, and n8n was only a timer plus a couple of webhooks. That timer now
lives in-process.

## How it works

- **The clock:** [`lib/automation/scheduler.ts`](../../integration/lib/automation/scheduler.ts)
  arms five self-ticking, overlap-guarded, `unref`'d timers on server boot (via
  [`instrumentation.ts`](../../integration/instrumentation.ts)) — the same proven
  pattern as the ATS sync scheduler. Each tick calls the engine **directly**
  (no HTTP, no shared-secret round-trip). The `/api/*/cron` HTTP endpoints stay as
  manual / redundant external triggers.

- **The per-campaign switch:** `campaign.autoRun` (the **Autopilot** toggle in
  Campaign Studio, next to Activate). A campaign with `status==="active" && autoRun`
  is run hands-off by the cadence tick — `runAutopilot` enriches, drafts, sends, and
  advances each queued prospect with nobody in the loop, **bypassing the human
  approval queue**. Campaigns without `autoRun` are untouched: their drafts still land
  in the morning approval queue for review. So a mixed workspace is safe.

- **The master switch:** `AUTOMATION_ENABLED`. Unset/`off` → the clock never arms
  (a fresh deploy is inert until you opt in). One global kill switch for all outreach.

## Tick cadence (all env-overridable, no redeploy needed)

| Tick | Default | Env override | Engine |
|---|---|---|---|
| LinkedIn cadence | 3 min | `RECRUITEROS_LINKEDIN_TICK_MS` | `SequenceEngine.tick` |
| Voice drops | 15 min | `RECRUITEROS_VOICE_TICK_MS` | `runDueDrops` per running campaign |
| Nurture drip | 6 h | `RECRUITEROS_NURTURE_TICK_MS` | `runNurtureTick` |
| Sending maintenance | 6 h | `RECRUITEROS_SENDING_TICK_MS` | `runSendingDaily` + seeds + auto-setup |
| Autopilot cadence | 30 min | `RECRUITEROS_CADENCE_TICK_MS` | `runAutopilot` per workspace |

## The Autopilot command center (UI)

The **Autopilot** tab (`#autopilot`, nav under Build) is the one-screen control room,
for **both BD and Recruiting**:

- **Engine strip** — live on/off, the five tick intervals, "Run a cycle now".
- **Pipeline** — Hiring signals → Enrich + draft → Sequenced campaigns, with live counts.
- **Pull from hiring signals (BD)** — the signal-pool breakdown by type; pick a target
  campaign, how many, contacts-per-company (1/3/5), optional direct-dial, then
  **Pull, enrich & stage** promotes + enriches pool leads into queued prospects.
  (Recruiting sources candidates via JD Sourcing; the rest of the flow is identical.)
- **Campaigns & workflows** — each campaign's state machine: **Draft model** (AI writes
  the sequence) → **Review & approve** → **Autopilot on**. Live counts per campaign.
- **Activity feed** — recent sends.

### The approve-once model ("see the models, approve, then set and forget")

Autopilot will not send for a campaign until its **outreach model** is approved:

1. `draftCampaignModel` ([lib/automation/model.ts](../../integration/lib/automation/model.ts))
   uses the LLM (Anthropic) to write the full multi-touch sequence as **merge-field
   templates** ({{firstName}}, {{company}}, {{role}}, {{signal}}). Motion-aware (BD vs
   Recruiting). Falls back to a strong built-in template sequence with no API key.
2. You review every touch in a modal, edit freely, and **Approve & arm Autopilot** —
   which sets `outreachApproved` + `autoRun` in one click.
3. From then on it's hands-off: `runAutopilot` is a day-paced sequence runner that
   merge-fills the **approved** templates per prospect and sends each touch as it comes
   due — **no per-send LLM call**, so the copy never drifts from what you signed off, and
   there's no ongoing AI cost. The gate: `status==="active" && autoRun && outreachApproved`.

API: `/api/autopilot` (GET overview; POST `create-campaign` / `draft-model` /
`update-model` / `approve-model` / `set-autorun` / `pull` / `run-now` / `get-model`).

## To turn it on

1. Set `AUTOMATION_ENABLED=on` on the server (keeper VPS) and redeploy/restart.
2. In Campaign Studio, open a campaign and click **🤖 Autopilot** (it also activates
   the campaign). That's it — the next cadence tick starts running it.

The provider keys the engines need (MTA / Unipile / Telnyx / Anthropic / voice clone)
are the same ones the manual path already uses; Autopilot doesn't add any.

## What this does NOT replace

This covers the **outbound clock** — the only real job n8n had. Inbound reply / opt-out
handling continues through the existing Response pipeline (`lib/response/*`) unchanged;
a reply on any channel still pauses sequences. If you ever want provider reply/accept
webhooks pointed straight at the portal (instead of through n8n's webhook nodes),
that's a small, separate follow-up — not required for Autopilot to run.
