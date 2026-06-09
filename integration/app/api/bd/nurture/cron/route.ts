/**
 * POST or GET /api/bd/nurture/cron
 * Advances the 6-month BD nurture drip. Call every few hours (idempotent) from
 * the scheduler — n8n, a worker loop, or RecruiterOS's own job runner.
 *
 * Each tick finds every active enrollment whose next value-touch is due, generates
 * that touch fresh against the lead's role/industry/background, and dispatches it:
 *   - email  -> sent now through the owned MTA (no email->voicemail trigger here),
 *   - linkedin_comment / linkedin_voice_note -> generated and STAGED on the
 *     enrollment (the LinkedIn send is account-scoped and, for comments, needs the
 *     post target, so it is executed by the LinkedIn wiring / operator).
 * Then it schedules the next touch, or completes the sequence at week 26.
 *
 * Auth: x-cron-secret (RECRUITEROS_CRON_SECRET), matching the other cron ticks.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../../lib/linkedin/auth";
import { ensureNurtureReady, dueTouches, generateNurtureTouch, advance, addPending } from "../../../../../lib/bd/nurture";
import { sendEmail, mtaPreferred } from "../../../../../lib/providers/mta";
import { toHtml } from "../../../../../lib/bd/draftContent";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  await ensureNurtureReady();
  const at = new Date();
  const due = dueTouches(at);
  const results: Array<Record<string, unknown>> = [];

  for (const { enrollment: e, touch } of due) {
    try {
      const content = await generateNurtureTouch(e.lead, touch);

      if (touch.channel === "email" && e.lead.email && mtaPreferred()) {
        const m = await sendEmail(e.workspaceId, {
          to: e.lead.email,
          subject: content.subject ?? "",
          htmlBody: toHtml(content.body),
        });
        results.push({ prospectId: e.prospectId, week: touch.week, channel: "email", sent: m.ok, provider: m.provider, skipped: m.skipped });
      } else {
        addPending(e.prospectId, {
          channel: touch.channel,
          week: touch.week,
          subject: content.subject,
          body: content.body,
          generatedAt: at.toISOString(),
        });
        results.push({ prospectId: e.prospectId, week: touch.week, channel: touch.channel, staged: true });
      }

      advance(e.prospectId, at);
    } catch (err: any) {
      // Do not advance on failure -> the touch is retried on the next tick.
      results.push({ prospectId: e.prospectId, week: touch.week, channel: touch.channel, error: err?.message ?? "touch_failed" });
    }
  }

  return NextResponse.json({ ok: true, due: due.length, processed: results.length, results });
}

export const GET = run;
export const POST = run;
