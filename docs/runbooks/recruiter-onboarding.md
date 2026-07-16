# Per-recruiter onboarding checklist (BD + Recruiting portal)

Run every new recruiter through this, in order. Workspace-level plumbing (Sending.ac import,
AUTOMATION_ENABLED, Telnyx keys, Unipile keys, custom domain) is covered by the other runbooks
(`sending-ac-go-live.md`, `lume-onboarding.md`, `lumesp-golive.md`) and is a prerequisite:
this list assumes the workspace itself is live.

> Legend: `[ ]` todo · `[x]` done · items marked **(admin)** are done by you, the rest by the recruiter.

---

## Phase 1: Account and access

- [ ] **(admin)** Invite the recruiter from **Team** in the admin portal. The invite link uses the
      verified branded domain (e.g. app.lumesp.com); they land in `/recruiter`.
- [ ] Recruiter accepts the invite, sets a password, and logs in.
- [ ] Recruiter confirms the branded portal loads (correct wordmark and theme, no house branding).

## Phase 2: Identity and channels (the per-person wiring)

- [ ] **(admin) Email: assign inboxes.** On the **Senders** screen, assign that recruiter's block of
      Sending.ac inboxes to them (owner assignment). Without this, campaigns tied to them have no
      pool and the Go-Live Checklist row "Inboxes assigned to that recruiter" stays red.
- [ ] **Sender identity.** Set the recruiter's sender name, signature, and voice/tone so drafted
      copy sounds like them, not the house.
- [ ] **LinkedIn: connect their account.** In LinkedIn OS, link the recruiter's own LinkedIn account
      (Unipile seat). Every LinkedIn action (connects, messages, posts, voice notes) routes through
      this one engine, so an unlinked recruiter has no LinkedIn capability. Note: actions stay
      simulated until the workspace UNIPILE keys are set.
- [ ] **Phone: set up calling.** BD Phone: **Numbers > Set up calling**, connect a number for the
      recruiter, and attest recording consent. Place one test dial from the browser phone.
- [ ] **PiP Studio: record a test video.** The Send Queue's send-ready gate holds every prospect
      until verified email + 2nd-email video + watch page exist, so each recruiter must be able to
      record. Have them record and preview one personalized video end to end.

## Phase 3: Campaigns and content

- [ ] **(admin) Tie their campaigns to them.** BD campaigns: set the Recruiter (inbox pool) in the
      Send Queue campaign setup so sends route through their Sending.ac inboxes. Recruiting
      campaigns: assign ownership; recruiting sends go out via the morning approval queue only
      (Autopilot is BD-only).
- [ ] Recruiter drafts (or reviews) their outreach model in Campaign Studio; admin/recruiter
      **Approves** it. Autopilot refuses unapproved models.
- [ ] Keep BD and Recruiting motions in separate campaigns (standing rule, never mixed).
- [ ] Confirm their prospect data is flowing in (ATS sync or import): name, verified email, phone,
      LinkedIn URL, company, title, signal.

## Phase 4: Daily operating routine (train on these, in this order)

- [ ] **Daily Checklist** (Outbound Performance): the 10-15 minute morning worksheet. Walk them
      through the fixed order: review alerts, answer waiting conversations (replies beat new
      outreach), complete due follow-ups, then hit the day's send/call targets. Steps auto-complete
      as the numbers are met.
- [ ] **Morning approval queue**: how to review and release the day's recruiting sends.
- [ ] **Send Queue screen**: read it as a supply gauge (send-ready coverage, capacity draining),
      not a send button.
- [ ] **LinkedIn Poster** (if they post): inspiration inbox, AI voice rewrite, approval gate before
      anything publishes.
- [ ] **BD Phone + AI call notes**: place calls from the browser, review the AI notes after.

## Phase 5: Verify before you call them live

- [ ] Test email: approve one draft to the recruiter's own address; it arrives in the inbox, from
      their assigned Sending.ac inbox, with their signature.
- [ ] Test LinkedIn action goes through their linked seat (or shows as simulated if keys pending).
- [ ] Test call connects and the recording-consent attestation is on file.
- [ ] Their Daily Checklist renders with real targets and capacity numbers.
- [ ] Go-Live Checklist for their campaign: all six required rows green.
