/**
 * RecruitersOS · Senders · counter reconciliation
 *
 * THE PROBLEM THIS FIXES. The process that actually transmits cold mail is a HOST
 * script; it never calls back into the app. So every Email ID it sent through kept
 * `sent: 0` in the registry forever, while the bounce sweep wrote `bounced: N` onto
 * the same row from the other direction. On 2026-08-21 that was 129 mailboxes
 * carrying recorded bounces against zero recorded sends.
 *
 * That is not a display bug. Three things break when a mailbox has no denominator:
 *   - its bounce RATE is uncomputable, so the board shows a blank that reads clean
 *   - `healthGuard`'s bounce rule can never fire on that lane, because the rule needs
 *     a minimum sample it will never reach: the safety net is not down, it is absent
 *   - per-mailbox history in the health ledger records a flat zero line for a mailbox
 *     that has been sending for weeks
 *
 * THE FIX. The send log always knew which mailbox sent what; nobody was counting it.
 * `tools/mpc-deliverability.mjs` now publishes a per-box tally (sends from the send
 * log, bounces from the NDR sweep) and this module folds it back into the registry.
 *
 * AND THE TRAP THAT NEARLY SHIPPED WITH IT. The obvious repair, folding the tally's
 * bounces into `m.bounced` and letting the guard divide, would have auto-held most of
 * the fleet on its first tick. `m.bounced` counts every delivery notice that LANDS in
 * the mailbox, warm-up traffic included, while `sent` counts campaign sends. On the
 * ariel@ boxes that is 208 notices against 2 sends: a "bounce rate" of 10,400%. The
 * arithmetic was only ever harmless because the denominator was stuck at zero.
 *
 * So this writes a MATCHED PAIR instead: `coldSent` and `coldBounced`, both from the
 * same tally over the same population, and everything that needs a bounce RATE reads
 * those two and nothing else.
 *
 * RULES, deliberately conservative:
 *   - the matched pair is SET from the tally, because mixing it with anything else is
 *     the very bug being fixed. Lifetime `sent` may only rise, since the app's own
 *     lanes record sends the tally cannot see.
 *   - `m.bounced` is NEVER written here. It answers a different question (what landed
 *     in this mailbox) and it is worth keeping as its own signal.
 *   - `sentToday` is NOT touched. It governs live send headroom, and the host sender
 *     enforces its own caps off the published capacity ledger. Changing what the app
 *     believes it has left today is a sending-behaviour change, and it does not belong
 *     inside a counter repair.
 *   - fail-open. A missing or unreadable ledger reconciles nothing and throws nothing.
 */

import { loadSnapshot } from "../db";
import { listInboxes, saveInbox, listSenderWorkspaceIds } from "./store";

interface BoxRow {
  email: string;
  sent?: number;
  accepted?: number;
  failed?: number;
  sentToday?: number;
  lastAt?: string | null;
  bounces?: number;
  bounceRatePct?: number | null;
}

export interface ReconcileReport {
  at: string;
  /** Absent when the publishing tool has not shipped the per-box tally yet. */
  available: boolean;
  ledgerAt?: string;
  boxesInLedger: number;
  matched: number;
  sentRaised: number;
  bouncesRaised: number;
  /** Mailboxes STILL holding delivery notices with no matched pair after this ran:
   *  a real remaining gap (a box that only ever sent through a lane we do not log). */
  stillUnfed: number;
  /** Mailboxes where delivery notices SEEN exceed campaign sends. Not an error and
   *  not a bad mailbox: it is warm-up traffic bouncing, and it is the exact shape
   *  that made the old `bounced / sent` arithmetic produce rates above 100%. */
  mismatched: number;
}

export async function reconcileSenderCounters(): Promise<ReconcileReport> {
  const at = new Date().toISOString();
  const snap = await loadSnapshot<{ generatedAt?: string; byBox?: BoxRow[] }>("mpc_deliverability_v1").catch(() => null);
  const rows = snap?.byBox;
  if (!Array.isArray(rows) || !rows.length) {
    return { at, available: false, boxesInLedger: 0, matched: 0, sentRaised: 0, bouncesRaised: 0, stillUnfed: 0, mismatched: 0 };
  }
  const byEmail = new Map(rows.map((r) => [String(r.email || "").toLowerCase(), r]));

  let matched = 0, sentRaised = 0, bouncesRaised = 0, stillUnfed = 0, mismatched = 0;
  for (const ws of await listSenderWorkspaceIds()) {
    for (const m of await listInboxes(ws)) {
      const row = byEmail.get(m.email.toLowerCase());
      if (row) {
        matched++;
        let dirty = false;
        // The MATCHED PAIR is set, not maxed: both halves come from the same tally over
        // the same population, so anything else would mix definitions again. This is the
        // only pair anything is allowed to compute a bounce RATE from.
        const cs = row.sent || 0, cb = row.bounces || 0;
        if (m.coldSent !== cs || m.coldBounced !== cb) {
          if (cs > (m.coldSent || 0)) sentRaised++;
          if (cb > (m.coldBounced || 0)) bouncesRaised++;
          m.coldSent = cs; m.coldBounced = cb; m.coldStatsAt = at;
          dirty = true;
        }
        // Lifetime `sent` may only rise: the app's own lanes record sends this tally
        // cannot see, so taking the max keeps both truths. `bounced` is NEVER written
        // here; it counts delivery notices seen in the mailbox, which is a different
        // question, and overwriting it would destroy that signal.
        if (cs > (m.sent || 0)) { m.sent = cs; dirty = true; }
        if (row.lastAt && (!m.lastSendAt || row.lastAt > m.lastSendAt)) { m.lastSendAt = row.lastAt; dirty = true; }
        if (dirty) await saveInbox(m);
      }
      if ((m.bounced || 0) > 0 && typeof m.coldSent !== "number") stillUnfed++;
      if (typeof m.coldSent === "number" && (m.bounced || 0) > m.coldSent) mismatched++;
    }
  }
  return {
    at, available: true, ledgerAt: snap?.generatedAt,
    boxesInLedger: rows.length, matched, sentRaised, bouncesRaised, stillUnfed, mismatched,
  };
}
