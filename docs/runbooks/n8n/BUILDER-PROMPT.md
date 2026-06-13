# n8n infrastructure — RecruitersOS BD omnichannel (complete)

The finished n8n build: hiring-signal → personalized 4-channel outreach → 6-month nurture, with
de-dupe and reply-halt. n8n is the conductor; RecruitersOS owns every provider, gate, warm-up,
content engine, and cost cap. Own internal email (Postal MTA) — never Instantly.

## The model
```
  Hiring SIGNALS → prospects (RecruitersOS signal engine, internal)
        │
  n8n FLOW A (schedule-pull):  GET /api/prospects/queue  ── content pre-attached, de-duped,
        │                                                    confidence-gated
        ├─ ① EMAIL  /api/email/send  → internally fires ② AMD VOICEMAIL (landline, via voice cron)
        ├─ ③ LINKEDIN connect + accept-note  /api/linkedin/enroll
        └─ …window… connected → ④ VOICE NOTE  /api/linkedin/actions {voice_note}
  Everyone reached → enrolled in the 6-MONTH NURTURE (email / LinkedIn comment / voice note)
  n8n FLOW B (ticks):  linkedin/cron · voice/cron · sending/cron · bd/nurture/cron
  n8n FLOW C: LinkedIn "accepted" webhook → mark connected
  n8n FLOW D: reply / opt-out webhook → mark halted + pause nurture
```

## Endpoints (all on branch `feat/email-sent-voice-trigger`)
| Purpose | Endpoint | Auth |
|---|---|---|
| Pull ready prospects (content pre-attached, de-duped, confidence-gated) | `GET /api/prospects/queue?ws=&limit=` | Bearer |
| ① Email (own MTA; auto-fires ② AMD voicemail) | `POST /api/email/send` | Bearer |
| ③ LinkedIn connect + accept-note | `POST /api/linkedin/enroll` | Bearer |
| ④ LinkedIn voice note (connected only) | `POST /api/linkedin/actions {action:"voice_note"}` | Bearer |
| Tick: LinkedIn cadence | `GET /api/linkedin/cron?batch=100` | `x-cron-secret` |
| Tick: drain AMD voicemail queue | `GET /api/voice/cron` | `x-cron-secret` |
| Tick: email warm-up / reputation / governor | `GET /api/sending/cron` | `x-cron-secret` |
| Tick: advance 6-month nurture | `GET /api/bd/nurture/cron` | `x-cron-secret` |
| Pause nurture on reply / inspect | `POST /api/bd/nurture {action:"pause"}` | Bearer |

---

# PASTE THIS INTO n8n "Build with AI"

Build an n8n workflow named **"RecruitersOS BD — Omnichannel Outreach"** that conducts a four-channel
business-development funnel plus a six-month nurture, by calling the RecruitersOS HTTP API (BD motion).
RecruitersOS owns every provider, gate, warm-up, content engine, and cost cap. This workflow ONLY
calls RecruitersOS endpoints — make no direct SMTP/Telnyx/Unipile/email-provider calls anywhere.

Env variables (via `$env`):
- `RECRUITEROS_BASE_URL`, `RECRUITEROS_API_TOKEN` (header `Authorization: Bearer {token}`),
  `RECRUITEROS_CRON_SECRET` (header `x-cron-secret`), `RECRUITEROS_WS` (the workspace id),
  `RECRUITEROS_SEQUENCE_ID`, `RECRUITEROS_LINKEDIN_ACCOUNT_ID`, `RECRUITEROS_VOICE_CAMPAIGN_ID`.

Create FOUR flows in one workflow:

=== FLOW A — Initial funnel (schedule-pull, content pre-attached) ===
1. **Schedule Trigger** — every 30 minutes.
2. **HTTP "Pull Queue"** — `GET {{$env.RECRUITEROS_BASE_URL}}/api/prospects/queue?ws={{$env.RECRUITEROS_WS}}&limit=25`,
   header `Authorization: Bearer {{$env.RECRUITEROS_API_TOKEN}}`. Returns `{ prospects: [ { id, firstName,
   company, email, linkedinUrl, providerProfileId, subject, html, linkedinConnection, linkedinMessage,
   voiceNoteScript, audioUrl, voicemailScript, confidenceScore } ] }`. The queue already generated the
   content, de-duped (enrolled prospects are never returned), and gated on confidence.
3. **Split Out** — field `prospects`, so each item is one ready prospect with all fields above.
4. **HTTP "① Email"** — `POST {{$env.RECRUITEROS_BASE_URL}}/api/email/send`, bearer, JSON body
   `{ workspaceId: $env.RECRUITEROS_WS, prospect: { id: $json.id, firstName: $json.firstName,
   company: $json.company, email: $json.email }, subject: $json.subject, html: $json.html,
   voiceCampaignId: $env.RECRUITEROS_VOICE_CAMPAIGN_ID }`. Skip if no email. (This send auto-enqueues
   the AMD voicemail inside RecruitersOS — do NOT add a dial node.)
5. **HTTP "③ LinkedIn Enroll"** — `POST {{$env.RECRUITEROS_BASE_URL}}/api/linkedin/enroll`, bearer,
   JSON body `{ prospect: { id: $json.id, firstName: $json.firstName, company: $json.company,
   linkedinUrl: $json.linkedinUrl, providerProfileId: $json.providerProfileId },
   sequenceId: $env.RECRUITEROS_SEQUENCE_ID, accountId: $env.RECRUITEROS_LINKEDIN_ACCOUNT_ID }`.
   Re-read prospect fields from the "Split Out" node (the Email node replaced the item).
6. **Wait "Connection window"** — 4 days.
7. **Code "④ Voice-note gate"** (run once for each item) — re-read the prospect from
   `$('Split Out').item.json`. `const sd = $getWorkflowStaticData('global')`. Return null (drop) if
   `sd.halted?.[prospect.id]`, the prospect is NOT in `sd.connected`, or there is no
   `providerProfileId`/`audioUrl`. Else return the prospect item.
8. **HTTP "④ Voice Note"** — `POST {{$env.RECRUITEROS_BASE_URL}}/api/linkedin/actions`, bearer, JSON body
   `{ accountId: $env.RECRUITEROS_LINKEDIN_ACCOUNT_ID, prospect: { id: $json.id,
   providerProfileId: $json.providerProfileId, firstName: $json.firstName, company: $json.company },
   action: "voice_note", audio: $json.audioUrl }`.

=== FLOW B — Ticks (four separate Schedule Triggers → one HTTP each; header `x-cron-secret: {{$env.RECRUITEROS_CRON_SECRET}}`) ===
9.  every 3 min  → `GET {{$env.RECRUITEROS_BASE_URL}}/api/linkedin/cron?batch=100`.
10. every 15 min → `GET {{$env.RECRUITEROS_BASE_URL}}/api/voice/cron`.
11. daily 07:00 → `GET {{$env.RECRUITEROS_BASE_URL}}/api/sending/cron`.
12. every 6 hours → `GET {{$env.RECRUITEROS_BASE_URL}}/api/bd/nurture/cron`  (advances the 6-month drip).

=== FLOW C — LinkedIn accept events (mark "connected") ===
13. **Webhook (POST, path `recruiteros/linkedin-accept`)** — point your LinkedIn/Unipile
    connection-accepted webhook here. Body has the prospect id (`prospectId`/`prospect_id`/`ref.prospectId`).
14. **Code "Mark Connected"** (all items) — set `$getWorkflowStaticData('global').connected[prospectId] = true`.

=== FLOW D — Reply / opt-out events (halt + pause nurture) ===
15. **Webhook (POST, path `recruiteros/reply`)** — point your reply webhook here (email + LinkedIn replies, opt-outs).
16. **Code "Mark Halted"** (all items) — set `$getWorkflowStaticData('global').halted[prospectId] = true`.
17. **HTTP "Pause Nurture"** — `POST {{$env.RECRUITEROS_BASE_URL}}/api/bd/nurture`, bearer, JSON body
    `{ action: "pause", prospectId: <the id from the webhook> }`. Stops nurturing anyone who replied.

Important behaviors:
- The queue returns content pre-attached — there is NO separate content-generation node.
- HTTP nodes replace the item with their response; in every node after one, re-read prospect fields
  from the "Split Out" node via paired-item access.
- Do NOT add an AMD/voice dial node — the voicemail is triggered by the email send and drained by
  `/api/voice/cron`. AMD consent/window/cap/line-type gates are enforced inside RecruitersOS.
- Voice Note is for connected prospects only. Never inline tokens/secrets. Leave inactive until env set.

---

## Server prerequisites (deploy branch `feat/email-sent-voice-trigger`)
| Var | Why |
|---|---|
| `SENDING_EMAIL_PROVIDER=mta` | Email through the owned Postal MTA, not Instantly |
| `RECRUITEROS_OUTREACH_PROVIDER=unipile` + `UNIPILE_API_KEY`/`UNIPILE_DSN` | LinkedIn connect/note/voice-note AND nurture comments run on Unipile |
| `RECRUITEROS_VOICE_ON_SEND=on` + `RECRUITEROS_VOICE_ON_SEND_CAMPAIGN` | The email→voicemail trigger + its voice campaign |
| `ANTHROPIC_API_KEY` | The persona + nurture content engines |
| `RECRUITEROS_BD_MIN_CONFIDENCE` (default 0.7) | Confidence gate: below → held for review, not sent |
| `VOICE_CLONE_VOICE_ID` (placeholder) | Voice-note audio; dry-run URL until a clone provider is selected |
| `RECRUITEROS_LINKEDIN_ACCOUNT_ID` | Default Unipile account for nurture LinkedIn touches |
| `TELNYX_*`, `HCLOUD_TOKEN`/`HETZNER_DNS_TOKEN` + Postal creds | AMD voicemail + email infra |
| `RECRUITEROS_API_TOKEN`, `RECRUITEROS_CRON_SECRET` | n8n auth |

## Open items (generation works; these complete the sends)
- **LinkedIn nurture comment/voice-note send**: wired via Unipile `listPosts`/`commentOnPost`/`sendVoiceNote`,
  but needs each prospect's `providerProfileId` (profile enrichment) and the Unipile post/comment endpoint
  paths confirmed against Unipile's current API. Until then those touches are generated and staged
  (visible via `GET /api/bd/nurture`).
- **Voice clone provider**: placeholder until selected; drop the key into `VOICE_CLONE_VOICE_ID`.
