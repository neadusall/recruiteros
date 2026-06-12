# LinkedIn Cloned-Voice Notes — Sending Safeguards

Design + safety reference for sending **personalized cloned-voice notes** on LinkedIn via the
Unipile API. Read this **before** wiring any auto-send loop. The point of this file is one thing:
**don't get accounts restricted or banned.** Volume is the lever people get wrong — relevance and
pacing matter more than raw count.

Status: **planned / being built out** (as of 2026-06-12). No auto-send loop is live yet.

---

## How the send actually works (two tools, two steps)

LinkedIn voice notes are a **two-step pipeline** — Unipile does NOT clone voice, it only delivers an
audio file you already have.

1. **Generate the audio** — cloned voice + per-person script → an `.m4a` file.
   Engine: the project's existing voice-clone/TTS stack (Cartesia / Telnyx-style). Personalization
   (name, company, signal) happens HERE, not in Unipile.
2. **Deliver it** — hand the `.m4a` to Unipile's `voice_message` parameter on the
   `POST /chats` (start-new-chat) endpoint → it lands as a native LinkedIn voice bubble.

Endpoint: `https://developer.unipile.com/reference/chatscontroller_startnewchat`
Key params: `account_id` (your sending LinkedIn), `attendees_ids` (recipient provider ID),
`voice_message` (the `.m4a`; LinkedIn prefers **.m4a**), plus optional `text`, `attachments`,
`linkedin[...]` options (e.g. `linkedin[inmail]`).

**Cost stack:** Unipile (~$55/mo, the pipe) **+** voice-clone/TTS provider (per-character/second).
Unipile alone does not do cloning.

---

## Hard limits to enforce in code (the safeguards)

These are the numbers the send loop MUST respect. Voice notes are **higher-friction than text**, so
these are set BELOW general text-message caps on purpose.

### Per-account daily voice-note caps
| Account state | Voice notes / day | Notes |
|---|---|---|
| **New / cold** (unwarmed, <30 days active automation) | **5–10** | Start at the bottom. |
| **Warmed** (aged, active human use, good reply rate) | **15–25** | Ceiling **30**. Do not exceed. |

### Supporting limits (gate the above)
| Action | Safe daily | Safe weekly | Hard flag risk |
|---|---|---|---|
| Connection requests | 20–30 | 60–100 | 50+/day → manual review |
| Any messages (text+voice combined) | 20–25 new acct → 50–80 warmed | ~100/wk free, ~150/wk Premium/SalesNav | — |

**Default the build to: ~10 voice notes/day to start, ramp to ~20–25/day only once warm.**

### Pacing rules (as important as the cap)
- Spread sends across **business hours**; never a burst at one timestamp.
- Send in **clusters of 5–10 with natural gaps** between clusters.
- **No constant mechanical interval** — randomize delays. Constant rates get flagged faster than
  high volume does.
- One account = one "human." Don't parallel-blast multiple accounts on identical timing.

---

## Eligibility gates (enforce before sending)

- **Voice notes only work with people who can already message you** — 1st-degree connections, or via
  InMail. Sending to non-connections without InMail will fail / is not allowed.
- Therefore the funnel is gated by **connection-accept rate first**. Don't queue voice notes to people
  who haven't accepted.
- Respect the project's existing **BD-only outreach scope** and consent posture — this is a
  business-development motion, person-direct, not a candidate blast. See `[[bd-only-outreach-scope]]`.

---

## The real ban trigger: quality, not count

This is the part that actually matters:

- **23% of users get restricted even while UNDER the official limits** — purely from low
  accept rates and spam-marks.
- LinkedIn weighs **reply rate, engagement, and spam reports** more heavily than raw volume.
- **One spam report hurts more than 10 extra messages.** An AI voice note from a stranger is a prime
  spam-flag candidate.

### Therefore the build MUST:
1. **Throttle on reply/spam signal, not just count.** If reply rate drops or any spam signal appears,
   auto-pause that account.
2. **Only target warm-ish recipients** — people likely to recognize the sender or the context.
3. **Personalize every clip** — no identical audio blasted to many people.
4. **Watch reply rate as the true throttle** — it's the leading indicator of trouble.

---

## Build checklist (when wiring the auto-send loop)

- [ ] Per-account daily counter with the caps above (default 10/day new, 25/day warmed).
- [ ] Randomized, business-hours-only scheduler with clustered gaps (no fixed interval).
- [ ] Eligibility check: 1st-degree connection OR valid InMail before queueing.
- [ ] Per-recipient personalization on the `.m4a` (name/company/signal).
- [ ] Reply-rate + spam-signal monitor that auto-pauses an account on degradation.
- [ ] Account-warmth state machine (cold → warming → warm) driving the cap tier.
- [ ] Audit log of every send (account, recipient, timestamp, clip) for review.

---

## Sources (2026 LinkedIn limit guidance)

- LinkedHelper — Automation Limits 2026: https://www.linkedhelper.com/blog/linkedin-automation-limits/
- Phantombuster — Safe Limits 2026: https://phantombuster.com/blog/linkedin-automation/linkedin-automation-safe-limits-2026/
- Valley — Daily Message Limit 2026: https://www.joinvalley.co/blog/linkedin-daily-message-limit-in-2026-what-s-the-real-number
- ConnectSafely — Mass Messaging 2026: https://connectsafely.ai/articles/linkedin-mass-messaging-guide-safe-outreach-2026
