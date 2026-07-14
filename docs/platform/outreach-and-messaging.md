# Platform Reference — Outreach & Messaging

How touches go out and how replies come back. All paths are under
[`integration/lib/`](../../integration/lib/). See the [platform index](README.md) for the other groups.

---

### channels
- **Purpose:** The unified send layer routing touches to provider APIs (email/LinkedIn/SMS/voice) and the enrichment waterfall for discovering contact info. Every outbound touch logs a `person_event` to the ATS.
- **Key files:** `index.ts` (send dispatch + enrichment), providers abstraction, Telnyx/Instantly/Unipile integrations.
- **Main exports / entry points:** `sendTouch()` (dispatch a single touch and log to ATS), `enrich()` (resolve email/phone/title via Fresh LinkedIn and Tomba).
- **Depends on:** `core`, `ats`, `providers` (instantly, unipile, salesrobot, ostext, telnyx, freshLinkedin, tomba), `signals/phoneClassify`.
- **Start here:** `integration/lib/channels/index.ts`

### outreach
- **Purpose:** The Outreach tab readiness snapshot. Synthesizes ATS connection, SMS setup, enrichment credits, Job Search, warming sending domains (down to inbox), and LinkedIn warmup state into a single health model.
- **Key files:** `index.ts` (features store, snapshot builder, state machine).
- **Main exports / entry points:** `getFeatures()` / `setFeature()` / `topUpCredits()` / `consumeCredits()` (in-memory feature flags + credit tracking), `outreachSnapshot()` (full readiness model).
- **Depends on:** `connected` (integrations), `accounts` (domains, LinkedIn accounts), `core/ids`.
- **Start here:** `integration/lib/outreach/index.ts`

### sms
- **Purpose:** SMS provider abstraction and Telnyx messaging plus the two-way conversation handler. Classifies inbound texts, decides auto-reply vs escalation, drafts replies in recruiter voice.
- **Key files:** `provider.ts` (SmsProvider interface + Telnyx/internal implementations), `conversation.ts` (inbound handler using Claude).
- **Main exports / entry points:** `getSmsProvider()` (returns configured provider), `handleInbound()` (classify intent, auto-reply or escalate).
- **Depends on:** `@anthropic-ai/sdk`, `linkedin/classify` (reply classification).
- **Start here:** `integration/lib/sms/provider.ts`

### voice
- **Purpose:** Voice Drops — TCPA-compliant voicemail outreach via landline/VoIP only. Handles import (mobile filtering), compliance gates, personalized voicemail assembly with voice cloning, dial scheduling in the lead's local timezone, and outcome recording.
- **Key files:** `index.ts` (barrel), `types.ts` (domain model), `campaign.ts` (orchestration: import/launch/run/record), `provider.ts` (voice-clone abstraction, ElevenLabs adapter), `script.ts` (templating), `compliance.ts` (window/timezone logic), `store.ts` (in-memory state), `clones.ts` (playlist assembly).
- **Main exports / entry points:** `importLeads()` (classify numbers, filter mobiles), `checkLaunch()` (gates), `runDueDrops()` (dial tick per campaign), `recordOutcome()` (AMD result callback), `testDrop()`.
- **Depends on:** `core`, `billing/ledger`, `providers/telnyx`, `signals/phoneClassify`, `@anthropic-ai/sdk` (compliance window).
- **Start here:** `integration/lib/voice/campaign.ts`

### sequences
- **Purpose:** Message content store for one channel — the ordered touches a customer authors (email/LinkedIn/SMS/voice) with custom variables and merge tokens, separate from campaign deployment.
- **Key files:** `index.ts` (full lifecycle: upsert, list, delete, purge).
- **Main exports / entry points:** `listSequences()`, `getSequence()`, `upsertSequence()` (create/update with step normalization), `deleteSequence()`.
- **Depends on:** `core/ids` (rid, nowIso), `core/types` (Motion).
- **Start here:** `integration/lib/sequences/index.ts`

### campaigns
- **Purpose:** Campaign creation and the 7-phase deployment workflow (infrastructure → shell → discovery → channels → methodology → A/B → launch). Also exports the 28-day sequence anatomy (touch specs per channel) and daily cadence.
- **Key files:** `index.ts` (campaign CRUD, deploy phases, BD benchmarks), `sequence.ts` (touch specs: EMAIL_TOUCHES, LINKEDIN_TOUCHES, VOICE_TOUCH, timeline), `abtest.ts` (A/B variant logic), `cadence.ts` (7:00–9:00 daily automation: signals → enrich → draft → queue → send).
- **Main exports / entry points:** `createCampaign()` (Draft status), `activateCampaign()`, `timeline()` (ordered touches by warmth), `runDailyCadence()`.
- **Depends on:** `core`, `channels` (enrich, sendTouch), `sequences`, `content`.
- **Start here:** `integration/lib/campaigns/cadence.ts`

### content
- **Purpose:** Asset library (case studies, comp benchmarks, value props, voice scripts). Assignable to campaigns; the LLM drafter injects assets into specific touches.
- **Key files:** `index.ts` (full asset lifecycle: add, list, update, delete, assetForTouch).
- **Main exports / entry points:** `addAsset()`, `listAssets()`, `updateAsset()`, `deleteAsset()`, `assetForTouch()` (pick asset by touch intent).
- **Depends on:** `core/ids`.
- **Start here:** `integration/lib/content/index.ts`

### response
- **Purpose:** End-to-end inbound reply pipeline: normalize webhook → match prospect → classify intent → route (execute rules, update prospect, suppress, log ATS event).
- **Key files:** `index.ts` (orchestration), `ingest.ts` (webhook normalizers: Instantly/Unipile/OS Text), `classify.ts` (fast-path heuristics + Claude classifier), `router.ts` (rule execution, prospect/ATS updates), `rules.ts` (routing rules by class), `repository.ts` (inbox/suppression store), `types.ts` (ProcessedResponse, Classification).
- **Main exports / entry points:** `processInbound()` (one webhook → processed result, idempotent on message id), `classify()`, `route()`, `suppress()` (DNC), `markBooked()`.
- **Depends on:** `core`, `ats`, `providers` (Instantly, Unipile, OS Text), `@anthropic-ai/sdk`.
- **Start here:** `integration/lib/response/index.ts`
