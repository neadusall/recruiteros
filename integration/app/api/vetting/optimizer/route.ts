/**
 * AI Vetting · Optimizer API (the learning loop's control surface)
 *   GET  /api/vetting/optimizer?deskId=   -> learning state + voice tuning + realism trend
 *   POST /api/vetting/optimizer           -> { action, deskId, ... }
 *     action: "optimize"  run one optimizer pass over real calls (+ last sim);
 *                         stores the revision as PROPOSED and returns it
 *     action: "simulate"  run the scenario stress-test suite (chat-mode sims
 *                         against the desk's exact prompt), store + return it
 *     action: "lint"      static findings pass over the live instructions
 *     action: "apply"     make a revision the applied learning + push to the
 *                         live assistant (re-provision)
 *     action: "revert"    drop the applied learning back to factory + push
 *     action: "settings"  save voiceTuning and/or autoLearn cadence (+ push if live)
 *
 * Session-gated. Optimize/simulate/lint need ANTHROPIC_API_KEY and surface a
 * clean 409 setup hint without it (same convention as scoring).
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import {
  getDesk, deskLearning, addRevision, applyRevision, clearAppliedRevision,
  setDeskVoiceTuning, setDeskTurnTuning, setDeskAutoLearn, setLastSimulation,
  runOptimizer, runOptimizerVariants, realismTrend, runSimulation, lintPrompt, provisionDesk,
  synthesizeTunedSample, rehearseSimAudio,
  clampVoiceTuning, clampTurnTuning, VOICE_PRESETS, DEFAULT_VOICE_TUNING, normalizeExtraction,
  type VoiceTuning, type TurnTuning,
} from "../../../../lib/vetting";

/** Push the current desk config to the live assistant; never throws. */
async function pushIfLive(desk: ReturnType<typeof getDesk>): Promise<{ pushed: boolean; error?: string }> {
  if (!desk || desk.status !== "live" || !desk.assistantId) return { pushed: false };
  const res = await provisionDesk(desk);
  return { pushed: !res.error, error: res.error };
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const deskId = new URL(req.url).searchParams.get("deskId") || "";
  const desk = getDesk(ws, deskId);
  if (!desk) return fail("not_found", 404);
  return ok({
    learning: deskLearning(desk),
    voiceTuning: clampVoiceTuning(desk.voiceTuning),
    turnTuning: clampTurnTuning(desk.turnTuning),
    extraction: normalizeExtraction(desk.extraction),
    defaults: DEFAULT_VOICE_TUNING,
    presets: VOICE_PRESETS,
    trend: realismTrend(ws, desk.id),
    status: desk.status,
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{
    action?: string; deskId?: string; revisionId?: string;
    voiceTuning?: Partial<VoiceTuning>; turnTuning?: Partial<TurnTuning>;
    autoLearn?: boolean; minCallsBetweenRuns?: number;
    sampleText?: string; simIndex?: number;
  }>(req);
  if (!b?.action || !b?.deskId) return fail("missing_fields", 422);
  const desk = getDesk(ws, b.deskId);
  if (!desk) return fail("not_found", 404);

  try {
    switch (b.action) {
      case "optimize": {
        const out = await runOptimizer(desk);
        const rev = addRevision(desk, {
          source: "optimizer",
          status: "proposed",
          styleNotes: out.styleNotes,
          voiceTuning: out.voiceTuning,
          changelog: out.changelog,
          diagnosis: out.diagnosis,
          basedOnCalls: out.basedOnCalls,
          avgRealismBefore: out.avgRealismBefore,
        });
        return ok({ revision: rev, learning: deskLearning(desk) });
      }
      case "optimize-auto": {
        // GHL "Auto" mode: three competing revisions through different lenses.
        const outs = await runOptimizerVariants(desk);
        const revisions = outs.map((out) =>
          addRevision(desk, {
            source: "optimizer",
            status: "proposed",
            angle: out.angle,
            styleNotes: out.styleNotes,
            voiceTuning: out.voiceTuning,
            changelog: out.changelog,
            diagnosis: out.diagnosis,
            basedOnCalls: out.basedOnCalls,
            avgRealismBefore: out.avgRealismBefore,
          }),
        );
        return ok({ revisions, learning: deskLearning(desk) });
      }
      case "simulate": {
        const run = await runSimulation(desk);
        setLastSimulation(desk, run);
        return ok({ simulation: deskLearning(desk).lastSimulation });
      }
      case "preview": {
        // Hear the CURRENT (possibly unsaved) sliders in the desk's cloned voice.
        const out = await synthesizeTunedSample(desk, b.voiceTuning, b.sampleText);
        return ok(out);
      }
      case "rehearse": {
        // Hear one stress-test conversation's agent side in the cloned voice.
        const sim = deskLearning(desk).lastSimulation;
        const idx = Math.max(0, Math.round(Number(b.simIndex) || 0));
        const result = sim?.results?.[idx];
        if (!result || !result.transcript.length) return fail("no_sim_transcript", 404);
        const out = await rehearseSimAudio(desk, result.transcript);
        return ok(out);
      }
      case "lint": {
        const findings = await lintPrompt(desk);
        return ok({ findings });
      }
      case "apply": {
        if (!b.revisionId) return fail("missing_fields", 422);
        const rev = applyRevision(desk, b.revisionId);
        if (!rev) return fail("not_found", 404);
        const push = await pushIfLive(desk);
        return ok({ revision: rev, learning: deskLearning(desk), ...push });
      }
      case "revert": {
        clearAppliedRevision(desk);
        const push = await pushIfLive(desk);
        return ok({ learning: deskLearning(desk), ...push });
      }
      case "settings": {
        if (b.voiceTuning) setDeskVoiceTuning(ws, desk.id, b.voiceTuning);
        if (b.turnTuning) setDeskTurnTuning(ws, desk.id, b.turnTuning);
        if (typeof b.autoLearn === "boolean" || b.minCallsBetweenRuns) {
          setDeskAutoLearn(ws, desk.id, b.autoLearn ?? deskLearning(desk).autoLearn, b.minCallsBetweenRuns);
        }
        // Auto-learn flips don't touch the live agent config; only real config
        // changes (voice/turn) are worth a re-provision round-trip.
        const push = (b.voiceTuning || b.turnTuning) ? await pushIfLive(desk) : { pushed: false };
        return ok({
          voiceTuning: clampVoiceTuning(desk.voiceTuning),
          turnTuning: clampTurnTuning(desk.turnTuning),
          learning: deskLearning(desk),
          ...push,
        });
      }
      default:
        return fail("unknown_action", 422);
    }
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return fail("optimizer_failed", status, { detail: e?.message || "error" });
  }
}
