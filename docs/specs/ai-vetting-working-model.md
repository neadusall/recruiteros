# AI Vetting Working Model (v1, 2026-07-16)

Source: teardown of a Retell AI "Recruitment Screening Agent" console (screenshot provided by owner), mapped element-by-element onto our existing AI Vetting stack (`integration/lib/vetting/`, Telnyx AI Assistant engine). This is the reference model for every future AI Vetting improvement: what a mature voice screening agent has, what we already have, and the build order to close the gap.

Goal stated by owner: make AI Vetting better and more human.

---

## 1. What the reference console shows (decoded)

The screenshot is Retell AI, one of the top hosted voice-agent platforms. Its screening agent is built from exactly these parts:

| Console element | What it is |
| --- | --- |
| LLM selector (GPT 5.1, "Suggested") | Swappable realtime brain per agent |
| Header telemetry: $0.135/min, 970-1300ms latency, 1539-3679 tokens | Per-agent cost and latency budget, surfaced constantly |
| Voice model tiers (ElevenLabs Flash V2 -> Turbo V2.5 -> Multilingual V2 -> V3 at $0.2/min) | Explicit latency-vs-quality-vs-price ladder, "Auto" default |
| Prompt: `# Role and Objective` | Role framing: "You are John, an interview screening agent... you do NOT make the judgment of whether this applicant moves forward; the actual recruiter makes the decision" |
| Prompt: `# Context` with `{{first_name}} {{last_name}} {{email}}` | Per-caller dynamic variables |
| Prompt: `## Resume {{resume}}` and `## Job Description` | The candidate's FULL RESUME injected into the live call prompt, next to the JD |
| Prompt: conversation plan | Open the screening (explain what happens next), let them introduce themselves, technical questions matched to the JD, follow-ups that bring up experience from their resume, room to share anything else |
| Pause Before Speaking: 0s | Turn-taking knob |
| Language selector (English US) | Per-agent language |
| Right panel: Functions | Mid-call tool calls (book, transfer, end call, custom webhooks) |
| Right panel: Knowledge Base | Docs the agent can answer questions from |
| Right panel: Speech Settings + Realtime Transcription Settings | STT/TTS tuning |
| Right panel: Call Settings | Timeouts, voicemail, max duration |
| Right panel: Post-Call Data Extraction | Structured fields pulled from every transcript |
| Right panel: Security & Fallback Settings | LLM/voice fallbacks, abuse guards |
| Right panel: Webhook Settings | Call lifecycle events out |
| Right panel: MCPs | Live external tools via MCP servers |
| Top tabs: Create / Simulation | Built-in simulated test calls |
| Agent Handbook | Reusable behavior style guide |

## 2. Where we already match or beat it

Our stack (Telnyx AI Assistant realtime loop + Claude reasoning passes) already covers a surprising amount, and beats Retell in three places:

| Capability | Ours | Status |
| --- | --- | --- |
| Realtime voice loop (STT -> LLM -> TTS) | Telnyx AI Assistant, distil-whisper STT, ElevenLabs voice | HAVE |
| Recruiter's own cloned voice | ElevenLabs instant clone per desk | HAVE (Retell uses stock voices by default) |
| Dynamic variables webhook | `/api/vetting/context` resolves caller by phone -> first_name, current_title, current_company, experience | HAVE |
| Post-call data extraction | Per-desk `extraction[]` schema (`ExtractionField`, max 8, typed + coerced) | HAVE |
| Post-call webhook -> scoring | `/api/vetting/webhook` -> 100-point rubric, verdicts per qualifier, marketability, agentRealism | HAVE (richer than Retell's default) |
| Simulation / stress test | 5 synthetic personas chat-mode against the REAL prompt, judged for realism | HAVE |
| Self-learning loop | Optimizer auto-learn: every N scored calls -> bounded prompt+voice revision -> re-provisioned live | HAVE (Retell has nothing like this) |
| Human-behavior spec | HUMAN_BEHAVIOR_RULES: backchannels, barge-in stop, never "as an AI", no fabrication | HAVE |
| Turn-taking knobs | `TurnTuning` -> Telnyx interruption_settings | HAVE (partial, see gap 8) |
| Generate questions from JD | `qualifiers.ts` -> top 3-4 qualifiers with pass criteria | HAVE |

Structural advantages to protect: cloned recruiter voice, the auto-learn loop, and the deep scorecard. Nothing in the build order below may regress these.

## 3. The gaps (what the reference has that we do not)

Ranked by human-ness impact per unit of effort.

### Gap 1: Resume is not in the live call (HIGHEST impact)
Retell injects `{{resume}}` verbatim into the prompt. We collect `resumeText` on the candidate (vetting-resume.html) but `buildCallContext` only passes name/title/company/experience. Result: their agent says "I saw you led the Epic migration at Mercy Health, tell me about that" and ours cannot. Referencing specifics from someone's own resume is the single most human-feeling move a screener makes.

Build: add `resume` (sliced ~4000 chars) and `email` to `buildCallContext` in `prompt.ts:162`, add a `## THEIR RESUME` block with instructions to weave 2-3 resume-specific follow-ups into the qualifier questions, never read the resume back verbatim. Unknown caller or no resume: variable resolves to empty and the block instructs the agent to ask for a quick background rundown instead.

### Gap 2: No mid-call Functions (agent cannot DO anything)
Retell's agent books, transfers, and ends calls via functions. Ours can only talk; booking happens after the call via TidyCal links. A human screener says "let me grab you 20 minutes with Sarah Thursday" and does it live.

Build: Telnyx AI Assistants support tools (webhook tools + built-in hangup/transfer). Wire, in order:
1. `book_interview`: webhook tool -> our `tidycal.ts` (already integrated) -> agent confirms the slot on the call.
2. `transfer_to_recruiter`: hot transfer to the desk owner's BD Phone line when the candidate is a clear star or asks for a human (reuses `lib/phone/` call control).
3. `send_followup_sms`: fires the desk's opt-in/resume link via OS Text engine.
4. `end_call`: graceful hangup function instead of waiting for idle timeout.
Config lands in `assistant.ts::buildAssistantConfig`; each tool posts to a new `/api/vetting/tools` route (verify by desk lookup, same pattern as context webhook).

### Gap 3: No Knowledge Base (agent deflects candidate questions)
Candidates always ask: comp range, remote policy, benefits, interview process, who is the client. Retell agents answer from a knowledge base; ours has only the JD slice, so it deflects, which is the #1 "this is a bot" tell.

Build: `desk.knowledge` (array of Q/A pairs + free-text facts, per desk, cap ~2500 chars in prompt). New prompt block `## WHAT YOU KNOW ABOUT THIS ROLE AND COMPANY` with the rule: answer from knowledge if present, otherwise say the recruiter will cover it, never invent. UI: a "Role FAQ" card on the desk editor, plus a one-click "Draft FAQ from JD" (one Anthropic pass, same house pattern as `qualifiers.ts`).

### Gap 4: No voice-model tiering
Retell exposes a ladder (Flash = fastest, V3 = most expressive at $0.2/min). We hardcode one path. Expressiveness ceilings differ meaningfully: newer ElevenLabs models handle emotion, pacing, and laughter far better.

Build: `desk.voiceTuning.voiceModelTier: "fast" | "balanced" | "expressive"` mapped in `assistant.ts` to whatever model IDs Telnyx's ElevenLabs integration accepts (verify current list against Telnyx docs at build time; do not assume Retell's list). Default "balanced". Show est. $/min per tier in the UI so the recruiter makes the cost call.

### Gap 5: No cost/latency telemetry
Retell shows $/min, latency band, and token range in the header at all times. We meter billing minutes but surface nothing, so we cannot see when a desk gets slow (latency is the #2 bot tell after deflection).

Build: capture per-call duration, estimated cost, and (if Telnyx exposes it in insights/webhook payloads) response latency into `VettingCall`; roll up per desk; show a small "Engine health" strip on the desk card: avg latency, $/min, minutes this month. Feed latency into the Optimizer as evidence (slow turns -> shorten prompt, drop tier).

### Gap 6: Fallbacks are thin
Retell has a whole Security & Fallback panel. We fall back to Kokoro TTS if the clone is missing, and that is it. No LLM fallback, no behavior when the resume/context webhook times out, no abuse guard.

Build: (a) context webhook already degrades to neutral defaults, keep; (b) add engine-model fallback chain in `assistant.ts` if Telnyx supports it, else document the manual switch; (c) prompt-level abuse rule: one redirect, then polite end_call (uses Gap 2's function); (d) hard max call duration in telephony_settings.

### Gap 7: Explicit conversation arc in the prompt
The Retell prompt encodes a five-beat arc: explain what happens next, self-introduction, JD-matched technical questions, resume-driven follow-ups, open floor at the end. Ours opens and closes well but the middle is qualifier-list-driven, which can feel like a form being read.

Build: restructure `discoveryBlock` into the same arc, with two added beats: beat 1 "here's what this call is and what happens after" (transparency reads as human and is also our AI-disclosure moment), and final beat "anything you want the recruiter to know that we didn't cover?". Keep the honesty framing verbatim from the reference: the agent does not decide, the recruiter decides; say so if asked.

### Gap 8: Turn-taking pause knob
Retell exposes "Pause Before Speaking" directly. We derive interruption settings from `TurnTuning` but have no explicit pre-speech pause. A tiny variable pause (0.2-0.5s) before answering hard questions reads as thinking.

Build: add `turnTuning.pauseBeforeSpeakingMs` (clamped 0-800) -> Telnyx start-speaking plan; let the Optimizer nudge it within bounds like the other knobs.

### Gap 9: Outbound screening calls (bigger swing, phase 2)
Today the candidate must call the desk number. Retell agents dial out. "Our AI assistant will call you Tuesday at 2pm" converts far better than "call this number whenever".

Build: opt-in form gains a time picker -> scheduled job dials the candidate via Call Control and bridges to the desk's assistant. Compliance gate: outbound AI calls require disclosure at the top of the call and TCPA-safe consent captured at opt-in; reuse the consent pattern from BD Phone recording attestation.

### Gap 10: Multi-language desks (phase 2)
Reference has a language selector. Our STT (distil-whisper) and ElevenLabs multilingual voices can both do it; add `desk.language`, thread through prompt + transcription config. Only build when a client actually needs it.

Not adopting: MCPs panel (our Functions route covers the same need with less surface area), Retell itself as a vendor (we would lose the cloned voice + auto-learn moat and pay ~$0.135/min margin to a middleman; Telnyx keeps voice, telephony, and SMS on one account per workspace).

## 4. The working model (the picture to build against)

Every AI Vetting feature belongs to exactly one of these seven layers. When we add anything new, name its layer first.

```
L1 BRAIN        realtime LLM on Telnyx (env RECRUITEROS_VETTING_ENGINE_MODEL)
                + Claude (claude-sonnet-4-6) for all offline reasoning
L2 VOICE        cloned ElevenLabs voice + tier ladder (Gap 4) + fallback voice
L3 EARS/TURNS   STT + TurnTuning + pauseBeforeSpeaking (Gap 8) + barge-in
L4 SCRIPT       prompt = HUMAN_BEHAVIOR_RULES + conversation arc (Gap 7)
                + JD + qualifiers + RESUME (Gap 1) + KNOWLEDGE (Gap 3)
                + learnedNotes (Optimizer addendum)
L5 HANDS        Functions: book_interview, transfer_to_recruiter,
                send_followup_sms, end_call (Gap 2)
L6 MEMORY/DATA  context webhook in -> scorecard + extraction[] out
                -> store -> Loxo/no-double-contact guard
L7 FLIGHT DECK  Optimizer tab + simulator + realism trend
                + engine health telemetry (Gap 5) + fallbacks (Gap 6)
```

The human-ness thesis, in one line: a caller believes they are talking to a person when the agent (a) knows their resume, (b) answers their questions, (c) can actually do things, and (d) hesitates and yields like a person. That is Gaps 1, 3, 2, 8 in that order.

## 5. Build order

Phase 1 (ship together, all low-risk prompt/config work): Gaps 1, 7, 3, 8. Touches `prompt.ts`, `types.ts`, `context/route.ts`, desk editor UI. No new vendors, no new infra. Re-run simulator + lint on every desk after; expect agentRealism trend to move.

Phase 2 (agent gets hands): Gap 2 functions, then Gap 6 fallbacks (end_call is a dependency). New `/api/vetting/tools` route.

Phase 3 (console maturity): Gaps 4 and 5, voice tiers + engine health strip.

Phase 4 (growth): Gaps 9 and 10, outbound scheduled screens + languages.

House rules that apply to all phases: no em-dashes in any prompt/UI/email copy; recruiter-facing UI shows outcomes, never engine internals (model names, webhook errors); every LLM pass follows the house pattern (Anthropic, temp 0 where structured, STRICT JSON, defensive parse, empty-over-fabricated); visual verification screenshots before deploy; shared checkout: stage explicit blobs, never pathspec-commit sweeps.
