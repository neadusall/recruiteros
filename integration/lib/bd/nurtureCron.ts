/**
 * RecruitersOS · BD nurture tick (engine)
 *
 * The body of the 6-month BD nurture drip, extracted from the /api/bd/nurture/cron
 * route so it can run BOTH ways with identical behavior:
 *   - the HTTP route (manual / redundant external trigger), and
 *   - the in-process Automation scheduler (the n8n replacement clock).
 *
 * Each tick finds every active enrollment whose next value-touch is due, generates
 * that touch fresh against the lead's role/industry/background, and dispatches it:
 *   - email  -> sent now through the owned MTA (no email->voicemail trigger here),
 *   - linkedin_comment / linkedin_voice_note -> generated and STAGED on the
 *     enrollment (the LinkedIn send is account-scoped and, for comments, needs the
 *     post target, so it is executed by the LinkedIn wiring / operator).
 * Then it schedules the next touch, or completes the sequence at week 26.
 */

import { ensureNurtureReady, dueTouches, generateNurtureTouch, advance, advanceDormant, dequeueTrigger, addPending, type NurtureEnrollment } from "./nurture";
import { dispatchNurture } from "./nurtureSend";
import { generateEarnedAsk } from "./booking";
import { ensureExperimentReady } from "./experiment";
import { voiceOnEmailSent, voiceOnSendEnabled } from "../voice/onEmailSent";
import { withWorkspaceCreds } from "../connected";

/** A minimal Prospect built from the frozen nurture lead, for the voicemail engine. */
function leadProspect(e: NurtureEnrollment): any {
  return {
    id: e.prospectId,
    workspaceId: e.workspaceId,
    firstName: e.lead.firstName,
    fullName: e.lead.fullName,
    title: e.lead.title,
    company: e.lead.company,
    location: e.lead.location,
    landlinePhone: e.lead.landlinePhone,
    phone: e.lead.phone,
  };
}

export interface NurtureTickResult {
  due: number;
  processed: number;
  results: Array<Record<string, unknown>>;
}

/** Advance every due nurture touch once. Idempotent and safe to call repeatedly. */
export async function runNurtureTick(at: Date = new Date()): Promise<NurtureTickResult> {
  await ensureNurtureReady();
  await ensureExperimentReady();
  const due = dueTouches(at);
  const results: Array<Record<string, unknown>> = [];

  for (const { enrollment: e, touch, trigger, dormantFloor } of due) {
    try {
      // Credential isolation: this whole touch (email via MTA, voicemail dial,
      // LinkedIn voice note) runs against THIS workspace's own/granted keys — a
      // customer's nurture never rides the operator's Telnyx/Unipile/voice env.
      await withWorkspaceCreds(e.workspaceId, async () => {
      // SIGNAL TRIGGER: a real-world event (job change, company news, a post) that
      // overrides the scheduled cadence. Generated fresh, dispatched on its channel,
      // then the trigger is marked fired (the plan index is NOT advanced).
      if (trigger) {
        const content = await generateNurtureTouch(e.lead, touch);
        const sent = await dispatchNurture(e, touch, content);
        if (sent.staged) {
          addPending(e.prospectId, { channel: touch.channel, week: 0, subject: content.subject, body: content.body, generatedAt: at.toISOString() });
        }
        results.push({ prospectId: e.prospectId, kind: "trigger", triggerKind: trigger.kind, ...sent });
        dequeueTrigger(e.prospectId, at);
        return;
      }

      // DORMANT QUARTERLY FLOOR: a single useful read per quarter for a long-quiet
      // relationship. Generated + dispatched, then the next quarter is scheduled.
      if (dormantFloor) {
        const content = await generateNurtureTouch(e.lead, touch);
        const sent = await dispatchNurture(e, touch, content);
        if (sent.staged) {
          addPending(e.prospectId, { channel: touch.channel, week: 0, subject: content.subject, body: content.body, generatedAt: at.toISOString() });
        }
        results.push({ prospectId: e.prospectId, kind: "dormant_floor", ...sent });
        advanceDormant(e.prospectId, at);
        return;
      }

      // MONTH-1 WEEKLY WAVE: a value email PAIRED with a voicemail to their direct
      // line, falling back to a LinkedIn voice note when there is no dialable number.
      if (touch.channel === "email_voice_wave") {
        // 1) the value email (fresh angle each week)
        const emailContent = await generateNurtureTouch(e.lead, { ...touch, channel: "email" });
        const emailSent = await dispatchNurture(e, { ...touch, channel: "email" }, emailContent);
        if (emailSent.staged) {
          addPending(e.prospectId, { channel: "email", week: touch.week, subject: emailContent.subject, body: emailContent.body, generatedAt: at.toISOString() });
        }

        // 2) paired voicemail to their direct line, with a UNIQUE value-first script
        //    this week (not "did you get my email"). Same-day; the voice cron dials it
        //    inside their local window. allowReenqueue makes each wave a fresh drop.
        let voicemail: Record<string, unknown> = { attempted: false };
        const dialable = e.lead.landlinePhone || e.lead.phone;
        if (dialable && voiceOnSendEnabled()) {
          const vm = await generateNurtureTouch(e.lead, { ...touch, channel: "linkedin_voice_note", intent: "A 20 to 25 second voicemail script, about 55 words, spoken aloud. Lead with ONE genuinely useful point relevant to their role and market this week. Mention only in passing that you also sent a quick note by email. Warm, confident, no ask, no dashes." });
          const r = await voiceOnEmailSent(e.workspaceId, leadProspect(e), { voicemailScript: vm.body, allowReenqueue: true });
          voicemail = { attempted: true, queued: r.queued, reason: r.reason };
        }

        // 3) fallback: no dialable line (or voicemail not queued) -> LinkedIn voice
        //    note (only sends if connected). Up to 45s, so it can be warmer + fuller.
        let fallbackVoiceNote: Record<string, unknown> | undefined;
        if (!voicemail.queued) {
          const vn = await generateNurtureTouch(e.lead, { ...touch, channel: "linkedin_voice_note", intent: "A 35 to 45 second voice note, about 100 words, spoken aloud. Deliver this week's one useful point in a little more depth, warm and human, and mention in passing that you also sent a note by email. No ask, no dashes." });
          const vnSent = await dispatchNurture(e, { ...touch, channel: "linkedin_voice_note" }, vn);
          if (vnSent.staged) addPending(e.prospectId, { channel: "linkedin_voice_note", week: touch.week, body: vn.body, generatedAt: at.toISOString() });
          fallbackVoiceNote = { ...vnSent };
        }

        results.push({ prospectId: e.prospectId, week: touch.week, channel: "email_voice_wave", email: emailSent, voicemail, fallbackVoiceNote });
        advance(e.prospectId, at);
        return;
      }

      // The earned-ask rung uses the conversion copy in this prospect's A/B model;
      // every other rung is a value touch.
      const content =
        touch.channel === "ask_email"
          ? { channel: touch.channel, ...(await generateEarnedAsk(e.lead, { channel: "email", variant: e.lead.variant })) }
          : await generateNurtureTouch(e.lead, touch);
      const sent = await dispatchNurture(e, touch, content);

      // A LinkedIn touch with no account/profile context is generated but not yet
      // sendable — stash it so the operator / LinkedIn wiring can execute it.
      if (sent.staged) {
        addPending(e.prospectId, {
          channel: touch.channel,
          week: touch.week,
          subject: content.subject,
          body: content.body,
          generatedAt: at.toISOString(),
        });
      }
      results.push({ prospectId: e.prospectId, week: touch.week, ...sent });

      advance(e.prospectId, at);
      });
    } catch (err: any) {
      // Do not advance on failure -> the touch is retried on the next tick.
      results.push({ prospectId: e.prospectId, week: touch.week, channel: touch.channel, error: err?.message ?? "touch_failed" });
    }
  }

  return { due: due.length, processed: results.length, results };
}
