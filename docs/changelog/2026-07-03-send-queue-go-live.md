# 2026-07-03: Send Queue Sending.ac go-live wiring + UI consolidation

Wired the Send Queue so the Sending.ac cold-send path can be fully pre-armed during the ~20-day
inbox warm-up and launch itself on the scheduled day, and consolidated the screen to essentials.
Deployed to production (recruitersos.co).

## The model it serves
Smartlead warms each inbox (~10/day). RecruitersOS sends the 2 cold/day per inbox
(`COLD_PER_INBOX = 2`, hard cap) through the recruiter's Sending.ac SMTP pool. The Send Queue is a
supply gauge + readiness gate; the actual sender is the Autopilot loop (`runAutopilot`), which routes
email through the recruiter's inbox pool only when the campaign is tied to that recruiter.

## Changes
- **Launch-date gate** (`integration/lib/campaigns/cadence.ts`): `runAutopilot` now skips any campaign
  whose `scheduledFor` is a future `YYYY-MM-DD` date, so a campaign can be fully armed (inboxes
  imported, model approved, Autopilot on, send-ready gate on) while inboxes warm, and start itself on
  the launch date with no manual step. Previously `scheduledFor` was display-only.
- **Campaign to recruiter assignment**: closed the critical gap where nothing set
  `campaign.recruiterId`, which made every send bypass the Sending.ac pool and fall back to
  MTA/Instantly. `setupSendQueueCampaign` + the send-queue `campaign_setup` action now accept
  `recruiterId`; the "Set up as Send Queue campaign" button sets `sendQueue` + `recruiterId` +
  `scheduledFor` + Day-0/Day-1 timing in one click. Added a recruiter picker to the setup row.
- **Go-live checklist** (`integration/lib/sending/goLive.ts`, `goLiveReadiness`): the send-queue GET now
  returns a readiness block + workspace recruiters; the Send Queue screen renders a "Go-live checklist"
  panel with the 6 required wiring checks, Autopilot status, and a launch countdown.
- **UI consolidation**: the Send Queue screen opens on the essentials (supply, runway, what is
  blocking, the auto-fill control); the sending-capacity table, day projection, and campaigns list fold
  into collapsible sections.
- **Runbook**: `docs/runbooks/sending-ac-go-live.md`.

## Deploy record
- Shipped ONLY the send-queue commit (`9eb3021` on the branch) by cherry-picking it onto `main` as
  `2bd8563`. The branch's MPC humanizer + PiP decision-maker commits were deliberately NOT shipped;
  they remain on `ship/hire-signals-ui-clean`.
- Prod: `ros` (Hetzner `ubuntu-8gb-ash-1`), checkout `/opt/recruiteros` (branch `main`), rebuilt the
  `app` service with `docker compose up -d --build app`. Data volumes (`app_data`, `pg_data`)
  preserved. `next.config.js` has `typescript.ignoreBuildErrors: true`, so the build does not gate on
  type errors.
- Verified: app container healthy, homepage HTTP 200 internally, and the publicly served
  `assets/js/command.js` carries the new go-live code.

## Branch reconciliation
After the prod deploy, `main` and `ship/hire-signals-ui-clean` had diverged (main carried the
cherry-picked commit under a different SHA plus a PiP-polish commit the branch lacked). Merged
`origin/main` into the branch to reconcile: the branch now fully contains `main`, the duplicated
send-queue change is deduped, and `main` remains the deployed subset (it intentionally does not carry
the branch's unshipped MPC/PiP work).

## Still required before day-20 launch (operator data steps)
1. Import the Sending.ac inbox CSV on the Senders screen and assign the batch to a recruiter.
2. Build + approve the campaign model (Day-0 text / Day-1 video) in Campaign Studio.
Then run the one-click Send Queue setup, set the launch date, and turn Autopilot on. The go-live
checklist goes green and the launch-date gate holds all sends until the launch day.
