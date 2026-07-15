# Recruiting Calls (candidate outbound + AI submittals)

A "Calls" tab in the Recruiters workspace: dial candidates from the browser, record with lawful consent, auto-transcribe, and turn each screen into a polished hiring-manager submittal with Claude.

## How it fits together

```
Recruiter clicks Call (command.js renderCalls)
  -> POST /api/phone/dial       creates CallRecord (motion=recruiting), dials candidate via Telnyx Call Control
  -> Telnyx events -> POST /api/phone/webhook
        call.answered           optional recording disclosure played, recordStart({transcription:true, channels:"dual"})
        call.hangup             CallRecord.completed, pipeline=recording
        call.recording.saved    store recording, pipeline=transcribing
        call.recording.transcription.saved
                                transcript -> CallTurn[], pipeline=analyzing
                                analysisForMotion("recruiting") -> analyzeRecruitingCall()
                                store RecruitingCallAnalysis, pipeline=complete
Recruiter opens the call -> sees structured screen + submittal -> Copy submittal / send to hiring manager
```

The telephony rails (lib/phone/{types,store,infra}.ts, providers/telnyx.ts) are shared with the BD phone. Only the INTELLIGENCE is per-motion: `analyzeRecruitingCall` (lib/phone/analysis-recruiting.ts), registered in `analysisForMotion()` in analysis.ts.

## The submittal (the point of the feature)

`RecruitingCallAnalysis` (types.ts) carries the structured screen (currentRole, currentComp / compExpectations, availability, location, workModelPreference, relocation, motivations, mustHaves, dealBreakers, strengths, concerns, skills, fit + fitRationale) plus:
- `headline`: one-line pitch for the top of a submittal or a Slack message.
- `submittal`: 3-5 paragraph hiring-manager presentation, ready to send as-is.

Grounding is enforced in the system prompt: the model documents only what the candidate actually said, returns empty for anything not discussed, and is explicitly barred from protected-class inferences. Temperature 0 so the same call yields the same submittal.

## Recording consent (do not skip)

Call recording law is per-state. ~12 states require all-party (two-party) consent (CA, FL, WA, IL, PA, MA, MD, MI, MT, NH, CT, others vary). The system is SAFE-by-default:

1. `PhoneSettings.recordingConsentAttested` starts false. `shouldRecord()` returns false until an admin attests lawful consent in Recording settings. No attestation = no recording, transcript, or submittal.
2. Even after attestation, the dialer requires a per-call `consentAcknowledged` checkbox from the recruiter.
3. On answer, the webhook plays a spoken disclosure ("This call may be recorded for quality and training purposes.") before recordStart.

This mirrors the existing Voice Drops consent gate. Operators should confirm their own counsel's guidance before flipping attestation on; the plumbing does not decide the law for them.

## Config (env)

```
# Voice (shared with BD phone / Voice Drops)
TELNYX_API_KEY=
TELNYX_CONNECTION_ID=          # Call Control application the dialer places calls on
TELNYX_FROM_NUMBER=            # E.164 caller ID
TELNYX_PUBLIC_KEY=             # ED25519, verifies /api/phone/webhook (no-op until set)
RECRUITEROS_APP_URL=https://app.recruitersos.co   # webhook base

# AI submittals
ANTHROPIC_API_KEY=
RECRUITEROS_PHONE_MODEL=       # optional; falls back to RECRUITEROS_LLM_MODEL, then claude-sonnet-4-6
```

## Recruiter best practices baked in

- Local-presence caller ID (line selection), call dispositions via pipeline + fit, follow-up dates and action items extracted automatically, and a per-candidate call history timeline.
- Honest submittals: the prompt sells the real candidate and surfaces concerns rather than hiding them, which is what makes a hiring manager trust the next one.

## Status / remaining

Analysis engine, types, and the motion seam are code-complete and typechecked. The `/api/phone/*` routes and the Calls tab UI are built alongside. Going live needs Telnyx voice config (Call Control app + number + public key) and a deploy; the AI submittal path needs only `ANTHROPIC_API_KEY`, which the workspace already uses elsewhere.
