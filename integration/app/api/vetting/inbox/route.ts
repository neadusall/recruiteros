/**
 * AI Vetting · Resume inbox API (session-gated)
 *   GET  /api/vetting/inbox           -> sweep status + recent activity log
 *   POST /api/vetting/inbox           -> { action: "sweep" }  run a sweep right now
 *
 * The scheduled sweep lives in the automation clock (lib/automation/scheduler,
 * resume_inbox tick, default every 5 minutes). GET also self-heals: if the
 * inbox is configured but hasn't been swept recently (clock off or process
 * restarted), it kicks a background sweep so simply opening the Vetting tab
 * keeps the intake moving.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { resumeInboxStatus, sweepResumeInbox } from "../../../../lib/vetting";

const STALE_MS = 6 * 60_000;

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const status = await resumeInboxStatus(ws);
  if (status.configured) {
    const last = status.lastSweepAt ? Date.parse(status.lastSweepAt) : 0;
    if (!last || Date.now() - last > STALE_MS) {
      // Fire-and-forget; the card shows this run on its next refresh.
      void sweepResumeInbox(ws).catch(() => {});
    }
  }
  return ok(status);
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string }>(req);
  if (b?.action !== "sweep") return fail("unknown_action", 422);
  const res = await sweepResumeInbox(ws);
  if (!res.configured) {
    return fail("not_configured", 409, {
      detail: "Connect the resume mailbox first: set RESUME_INBOX_USER and RESUME_INBOX_PASS (app password), plus RESUME_INBOX_HOST if it isn't Gmail/Outlook.",
    });
  }
  const status = await resumeInboxStatus(ws);
  return ok({ swept: true, checked: res.checked, saved: res.saved, error: res.error, ...status });
}
