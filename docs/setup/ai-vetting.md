# AI Vetting — inbound conversational screening

Bind one **job description** to one **phone number** and your **cloned voice**.
Candidates opt in (a short form), then *call the number*. A human-sounding AI
recruiter — your cloned voice — greets them by name, references their LinkedIn
experience, asks your top 3–4 qualifiers, then tells them the next step. Every
call is recorded, transcribed, summarized, and scored 1–100 on the recruiter
rubric (+ a 1–10 Marketability score).

Lives on the **Recruiting** motion → **AI Vetting** tab. Backend under
`integration/lib/vetting` + `integration/app/api/vetting`.

## How it works

```
Candidate opt-in form  ──POST /api/vetting/optin──▶  store candidate (keyed by phone)
                                                      + enrich LinkedIn experience
Candidate dials desk #  ──▶ Telnyx AI Assistant answers (your cloned voice)
        │  call connects ──POST /api/vetting/context──▶  resolve desk by dialed #,
        │                                                caller by caller-ID → return
        │                                                {{first_name, current_company, experience…}}
        │  conversation (barge-in, turn detection handled by Telnyx)
        ▼  call ends      ──POST /api/vetting/webhook──▶  parse transcript → score 1–100
                                                          → summary + qualify y/n + next step
Recruiter reads the scorecard in the AI Vetting tab.
```

The real-time STT→LLM→cloned-voice-TTS loop (with barge-in and turn detection)
is delegated to **Telnyx AI Assistant**. RecruitersOS owns everything else: the
JD↔number binding, candidate context + LinkedIn enrichment, the human-likeness
instructions (`lib/vetting/prompt.ts`), and the scoring (`lib/vetting/scoring.ts`).
Swapping the engine later is a one-file change (`lib/vetting/assistant.ts`).

## Setup

1. **Keys** (all optional — without them the feature runs as a safe dry-run):
   - `TELNYX_API_KEY` — required to take real calls and to list your numbers.
   - `VOICE_CLONE_API_KEY` + `VOICE_CLONE_VOICE_ID` — your ElevenLabs cloned voice
     (the same one Voice Drops uses). Per-desk override in the UI.
   - `ANTHROPIC_API_KEY` — required for the post-call scoring pass.
   - `FRESH_LINKEDIN_API_KEY` — LinkedIn enrichment for talking points (degrades
     gracefully if absent).
   - `RECRUITEROS_APP_URL` — public base the Telnyx webhooks point back to.
   - `TELNYX_PUBLIC_KEY` — verifies Telnyx webhook signatures (shared with Voice Drops).
   - Optional: `RECRUITEROS_VETTING_ENGINE_MODEL`, `RECRUITEROS_VETTING_MODEL`,
     `TELNYX_ELEVENLABS_KEY_REF`.

2. **Create a desk** (AI Vetting → Vetting Desks): name it, paste the JD, set the
   role title + hiring company, pick a number from your Telnyx account, set the
   top 3–4 qualifiers (with what a *pass* looks like; flag any must-haves), and
   the next-step messages for qualified / not-qualified.

3. **Go live** — provisions the Telnyx assistant and binds the number. With no
   `TELNYX_API_KEY` this is a dry-run: the desk flips to *live* and the whole
   flow is exercisable, but no real calls are taken.

4. **Share the opt-in link** — each desk card has an "Opt-in link" button. It
   points at `/vetting-optin?desk=<id>` (a brandable reference page; replace with
   your own — it just needs to POST `{deskId, firstName, lastName, phone, email,
   linkedinUrl}` to `/api/vetting/optin`).

## Swapping numbers between JDs

The number field is a pick-list of your real Telnyx numbers. A number bound to
another desk shows disabled. To move it: open the desk that holds it and click
**Detach #** (frees the number and tears down its assistant), then assign it on
the other desk and **Go live**.

## The scorecard (100 points)

| Category | Max |
|---|---|
| Communication | 20 |
| Response quality & length | 10 |
| Interpersonal presence | 15 |
| Self-awareness | 15 |
| Achievement orientation | 15 |
| Problem-solving | 10 |
| Energy & motivation | 10 |
| Cultural & behavioral fit | 5 |

Bands: 90+ exceptional · 80–89 strong hire · 70–79 worth advancing · 60–69
borderline · <60 do not advance. A **must-have** qualifier miss disqualifies
regardless of the total. **Marketability (1–10)** is scored separately — how
likely a client is to interview them (pedigree/scope), independent of personal
quality. **Agent realism (0–100)** grades how human *your* agent sounded.

## Operator-verify seam

Telnyx's AI-Assistant API surface (assistant CRUD + number↔assistant binding,
and the post-call/insight webhook payload shape) evolves; the calls are isolated
in `lib/providers/telnyx.ts` (the `AssistantConfig` methods) and
`lib/vetting/assistant.ts`. Confirm those against your current Telnyx account
before going live. The transcript/number parsing in the webhooks is deliberately
shape-tolerant.

## Compliance

Your cloned voice is *you*, acting as yourself — truthful self-identification,
never a claim to be a different person, never caller-ID spoofing. Calls are
inbound and consented (the candidate opted in and dialed you), and recorded;
disclose recording per your jurisdiction.
