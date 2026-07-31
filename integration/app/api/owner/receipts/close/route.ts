/**
 * POST or GET /api/owner/receipts/close[?month=YYYY-MM][&notify=0][&force=1]
 *
 * The unattended half of the receipt vault: the job that closes a month without anybody
 * opening the console.
 *
 * The nightly sweep next door COLLECTS. This one JUDGES, and it is the difference between
 * a system that gathers receipts and a system you can stop thinking about. Every run:
 *
 *   1. reads the last closed month against the register: is every dollar proven?
 *   2. asks whether anything is collecting at all, today, mid-month;
 *   3. emails the owner ONLY when a person is needed, and once when a month closes clean.
 *
 * Auth: x-cron-secret / ?secret= (RECRUITEROS_CRON_SECRET), same seam as the sweep.
 *
 *   ?notify=0   assess and report back, send nothing. The dry run.
 *   ?force=1    send even when the same picture was already reported. For testing the wiring.
 *   ?month=     close a specific month instead of the last closed one.
 *
 * Safe to run daily, and meant to be: the report rules inside decide when something is
 * worth saying, so the schedule does not have to be clever.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../../lib/linkedin/auth";
import { listReceipts, lastSweeps, pullerStates } from "../../../../../lib/owner/receipts";
import { listSpendItems, monthlyEquivalent } from "../../../../../lib/owner/spendRegister";
import { buildSpendMatrix, sourcingStatus, withinRegister } from "../../../../../lib/owner/spendMatrix";
import {
  assessMonth, assessCollectors, monthToClose, shouldReport, recordClose, lastSaid,
  settledAlreadySaid, markSettledSaid, collectorsSaid, recordCollectors, ensureCloseReady,
  monthReport, settledReport, collectorReport,
} from "../../../../../lib/owner/monthClose";
import { notifyOwner, noticeConfigured } from "../../../../../lib/owner/ownerNotice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  await ensureCloseReady();

  const url = new URL(req.url);
  const notify = url.searchParams.get("notify") !== "0";
  const force = url.searchParams.get("force") === "1";
  const period = url.searchParams.get("month") || monthToClose();
  const now = new Date();

  const [items, allReceipts] = await Promise.all([listSpendItems(), listReceipts()]);
  const receipts = allReceipts.filter(withinRegister);
  const pullers = pullerStates();
  const sourcing = sourcingStatus(items, receipts, pullers);

  /* The mailbox is reported from its own last sweep rather than probed here: this route
     must stay fast enough for a timer, and a failed sign-in is exactly what the sweep
     already records. */
  const mailboxError = lastSweeps().find((s) => !s.ok && s.error)?.error;

  const sent: Array<{ kind: string; subject: string; ok: boolean; reason?: string }> = [];

  /* ---- 1. is anything collecting, right now ---- */
  const monthlyByVendor: Record<string, number> = {};
  for (const i of items) {
    if (i.status !== "active") continue;
    const k = i.vendor.toLowerCase();
    monthlyByVendor[k] = (monthlyByVendor[k] || 0) + monthlyEquivalent(i);
  }
  const health = assessCollectors(sourcing, { mailboxError, monthlyByVendor });
  const collectorCall = force
    ? { report: health.digest !== "ok", why: "forced" }
    : shouldReport(collectorsSaid(), health.digest, now, 7);
  if (notify && collectorCall.report) {
    const mail = collectorReport(health);
    const res = await notifyOwner(mail);
    sent.push({ kind: "collectors", subject: mail.subject, ok: res.ok, reason: res.reason });
    if (res.ok) recordCollectors(health.digest, now);
  }

  /* ---- 2. the month itself ---- */
  let close = null;
  let monthCall: { report: boolean; why: string } = { report: false, why: "no month is closed yet" };
  if (period) {
    const matrix = buildSpendMatrix(items, receipts, { months: 14 });
    close = assessMonth(period, matrix, sourcing, { mailboxError });

    if (close.state === "settled") {
      /* Say so exactly once. Proof that the checking happened beats silence, but a monthly
         all-clear that repeats daily is noise like any other. */
      monthCall = { report: !settledAlreadySaid(period), why: settledAlreadySaid(period) ? "already said this month closed clean" : "the month closed clean" };
      if (notify && monthCall.report) {
        const mail = settledReport(close);
        const res = await notifyOwner(mail);
        sent.push({ kind: "settled", subject: mail.subject, ok: res.ok, reason: res.reason });
        if (res.ok) markSettledSaid(period);
      }
      recordClose(close, false, now);
    } else {
      monthCall = force ? { report: true, why: "forced" } : shouldReport(lastSaid(period), close.digest, now, 7);
      let reported = false;
      if (notify && monthCall.report) {
        const mail = monthReport(close);
        const res = await notifyOwner(mail);
        sent.push({ kind: "month", subject: mail.subject, ok: res.ok, reason: res.reason });
        reported = res.ok;
      }
      recordClose(close, reported, now);
    }
  }

  return NextResponse.json({
    ok: true,
    period,
    close,
    collectors: health,
    decisions: { month: monthCall, collectors: collectorCall },
    notify: { enabled: notify, configured: noticeConfigured(), sent },
  });
}

export const GET = run;
export const POST = run;
