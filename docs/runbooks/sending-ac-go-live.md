# Sending.ac cold-send go-live (2 cold/day per inbox)

How the RecruitersOS Send Queue actually sends, and the exact steps to wire it so it launches itself
once the inboxes finish warming (about 20 days).

## The model

- **Smartlead warms** each inbox (roughly 3 to 7/day ramping to ~10/day). RecruitersOS never touches
  those warming sends.
- **RecruitersOS sends the 2 cold/day per inbox** through the recruiter's Sending.ac SMTP pool.
  `COLD_PER_INBOX = 2` is a hard cap (`integration/lib/senders/limits.ts`).
- The **Send Queue** screen is a supply gauge + gate, not a sender. It stages send-ready prospects and
  holds them until each has a verified email + 2nd-email video + watch page.
- The **actual sender** is the Autopilot loop (`runAutopilot`, `integration/lib/campaigns/cadence.ts`),
  ticked every 30 min by the in-process scheduler when `AUTOMATION_ENABLED=on`.
- The email dispatch (`integration/lib/channels/index.ts`) tries the recruiter's SMTP pool first, then
  the owned MTA, then Instantly. It only uses the Sending.ac pool when the **campaign is tied to that
  recruiter** (`campaign.recruiterId`); otherwise the send falls through to MTA/Instantly.

## The go-live checklist (Send Queue screen)

The Send Queue screen shows a live "Go-live checklist" for the chosen campaign. All six required rows
green = the plumbing is sound:

1. **Sending.ac inboxes imported** - Senders screen, paste/upload the CSV.
2. **Campaign tied to a recruiter** - set in the Send Queue campaign setup (Recruiter picker).
3. **Inboxes assigned to that recruiter** - that recruiter owns inboxes with capacity.
4. **Outreach model approved** - draft + approve the Day-0 text / Day-1 video sequence.
5. **Send-ready gate on** - the `sendQueue` flag (the "Set up as Send Queue campaign" button).
6. **Automation clock enabled** - `AUTOMATION_ENABLED=on` in the server env.

## Steps

### 1. Import the Sending.ac inboxes (Senders screen)

Paste/upload the inbox CSV. The parser (`integration/lib/senders/csv.ts`) auto-detects the common
Sending.ac / Smartlead headers. Minimum columns per row: **email, smtp host, smtp password**
(smtp user/port default sensibly). Optional: display name, imap host/port/user/pass, a `recruiter`
column to assign the owner per row.

- Assign the whole batch to one recruiter during import (`ownerId`), or bulk-assign afterward on the
  Senders screen (`assign` action).
- Inboxes import as **status "warming"**, `dailyCap = 2`. Note: a warming inbox is still *sendable* in
  code, so what keeps sends from going out early is the **campaign not being live yet** (next steps).

### 2. Build + approve the campaign

- In Campaign Studio / Autopilot: create the campaign, draft the model, edit, and **Approve** it
  (`approve-model`). Approval is the one-time gate; Autopilot refuses to send an unapproved model.

### 3. Set it up as the Send Queue campaign (one button)

On the Send Queue screen, pick the campaign, choose the **Recruiter (inbox pool)**, set the **Launch
date** (about 20 days out, when warm-up finishes), and click **"Set up as Send Queue campaign."** That
one action:

- turns on the send-ready gate (`sendQueue`),
- ties the campaign to the recruiter's Sending.ac pool (`recruiterId`),
- stamps the launch date (`scheduledFor`),
- times the 1st email to Day 0 and the 2nd (video) email to Day 1.

### 4. Arm it now, safely

- Confirm `AUTOMATION_ENABLED=on` on the server (the master clock). Turning this on does NOT start this
  campaign early - the launch date holds it.
- Turn **Autopilot on** for the campaign. Because `scheduledFor` is a hard launch gate (see below),
  the campaign stays completely inert (nothing drafted, sent, or advanced) until the launch date, then
  starts itself with no manual step.

## Why it stays inert until launch day

`runAutopilot` skips any campaign whose `scheduledFor` is a future YYYY-MM-DD date
(`integration/lib/campaigns/cadence.ts`). So you can fully pre-arm during warm-up (inboxes imported,
model approved, Autopilot on, gate on) and it will not send a single email before the launch date.

## Day-20 launch

Nothing to do if you armed it in step 4: on the launch date the gate opens and the Autopilot begins
sending the 2 cold/day per inbox through the Sending.ac pool. If you left Autopilot off, just toggle it
on that morning. Watch the Send Queue "Sending capacity" section drain live as sends go out.
