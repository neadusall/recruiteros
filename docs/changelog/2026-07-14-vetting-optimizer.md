# 2026-07-14: AI Vetting Optimizer (self-improving voice agent)

The AI Vetting agent now learns from its own calls and measurably improves over time.
New **Optimizer** tab in the AI Vetting view; backend in `integration/lib/vetting/optimizer.ts`
and `integration/lib/vetting/simulator.ts`; API at `/api/vetting/optimizer`.
Shipped to production on `main` (`6e80975`, PR #42).

## What shipped

- **Realism trendline.** Every scored call already grades the agent 0-100 on human-likeness
  (the `agentRealism` field the scorer produces). The tab charts it per call with rolling
  averages, so "does my agent sound human" is a number you watch, not a feeling.
- **Voice delivery tuning.** Per-desk ElevenLabs settings (stability, similarity, style,
  speed, speaker boost) with three presets. Defaults moved to the documented phone-realism
  band: stability 0.40, similarity 0.80, style 0, speed 1.0, speaker boost on. Saving pushes
  straight to the live Telnyx assistant.
- **Optimize from calls.** One LLM pass studies recent scored transcripts plus their realism
  grades and proposes a versioned revision: a coaching addendum injected into the agent's
  prompt (new "WHAT YOU'VE LEARNED" section), bounded voice-tuning nudges (max 0.05 per pass
  so settings cannot oscillate), and a changelog grounded in specific call evidence. Nothing
  ships until "Apply + push live".
- **Stress test (GHL-Prompt-Optimizer style).** Five synthetic candidate personas: the skeptic
  who asks "is this an AI?", the rambler, the star, the confident-but-unqualified, and one
  built for the role, played chat-mode against the desk's exact live prompt, each judged for
  realism and expected behavior. Works on day zero; failures become optimizer evidence.
- **Check prompt.** Static lint of the live instructions (missing guardrails, unspeakable
  content, ambiguity), the equivalent of GHL's Prompt Evaluator.
- **Self-learning.** With auto-learn on, every N scored calls (default 3) the optimizer runs,
  applies, and re-provisions the live agent automatically. All revisions are versioned and
  revertible; "Reset to factory behavior" drops all applied coaching.
- **Speak-for-the-ear prompt rules.** The agent now writes speech, not text: numbers, money,
  and dates as words, ellipsis hesitations, CAPS stress, no lists or markdown.

## Why

Research pass over ElevenLabs' official realism guidance (voice-setting bands, telephony
formats, text normalization) and GoHighLevel's Prompt Optimizer plus Retell/Vapi/Bland/
Synthflow. Every platform optimizes against synthetic tests only; none closes the loop on
real production calls. Ours does both: the sims catch failures before launch, the real-call
loop keeps improving after.

## Operational note

Optimize / stress test / check prompt need `ANTHROPIC_API_KEY` on the server (the same key
call scoring uses). Without it they return a clean 409 with a setup hint in the UI.
