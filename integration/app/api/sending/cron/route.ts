/**
 * POST or GET /api/sending/cron
 * Drives the owned email infrastructure's daily maintenance. Call this once a
 * day (or every few hours — it is idempotent) from your scheduler — n8n, a
 * worker loop, or RecruitersOS's own job runner.
 *
 * Each tick runs `runSendingDaily` for every workspace that owns a sending
 * domain: reset daily caps -> advance warm-up -> refresh reputation (SNDS) ->
 * run the deliverability governor (auto-pause bouncing/blacklisted domains) ->
 * optional warm-up engagement round. This is the warm-up/health half of the
 * sending stack — without it, mailboxes never graduate warm-up and reputation
 * is never re-evaluated.
 *
 * Auth: shared secret via x-cron-secret header or ?secret= (RECRUITEROS_CRON_SECRET),
 * matching /api/linkedin/cron and /api/voice/cron.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { listSendingWorkspaceIds, runSendingDaily, runSeedMaintenance, listAutoSetupWorkspaceIds, advanceAutoSetup } from "../../../../lib/sending";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  // Mirror the Smartlead warm-up fleet into the per-portal Email ID pools, so
  // every mailbox is a tracked row on its own portal without anyone importing
  // CSVs. Idempotent; refreshes credentials and never clobbers operator edits.
  let fleet: unknown = null;
  try {
    const { syncFleetInboxes } = await import("../../../../lib/senders");
    fleet = await syncFleetInboxes();
  } catch (e: any) { fleet = { error: e?.message ?? "fleet_sync_failed" }; }

  // Drive any in-progress one-click setup forward (provision → DNS verify → mailboxes)
  // so it completes hands-off once the registrar NS + Postal key clear.
  const setups: Array<Record<string, unknown>> = [];
  for (const ws of await listAutoSetupWorkspaceIds()) {
    try { const s = await advanceAutoSetup(ws); setups.push({ workspaceId: ws, done: s.done, gates: s.gates.length }); }
    catch (e: any) { setups.push({ workspaceId: ws, error: e?.message ?? "setup_advance_failed" }); }
  }

  const workspaces = await listSendingWorkspaceIds();
  const results: Array<Record<string, unknown>> = [];

  for (const ws of workspaces) {
    try {
      const report = await runSendingDaily(ws);
      results.push({ workspaceId: ws, ...report });
    } catch (e: any) {
      results.push({ workspaceId: ws, error: e?.message ?? "tick_failed" });
    }
  }

  // Seeds are global (shared across workspaces), so maintain them ONCE per tick:
  // re-verify every login (catch locked accounts / revoked app passwords) and read
  // any due inbox-placement probes back from the seed inboxes.
  let seeds: unknown = null;
  try { seeds = await runSeedMaintenance(); } catch (e: any) { seeds = { error: e?.message ?? "seed_maintenance_failed" }; }

  // Email ID health guard over every portal's pool: auto-hold cold sends on
  // inboxes going bad (warm-up keeps running so they regain strength) and
  // auto-revive held ones once health recovers, onto the reduced ramp.
  let guard: unknown = null;
  try {
    const { runSenderHealthGuard } = await import("../../../../lib/senders");
    guard = await runSenderHealthGuard();
  } catch (e: any) { guard = { error: e?.message ?? "health_guard_failed" }; }

  // Fleet outlook watcher: re-verify every milestone on the fleet monitor against the
  // ledger that gates it, stamp the check-offs that earned themselves this tick, and
  // raise the ones that went backwards or ran late. Runs after the guard so a
  // graduation stamped a moment ago is already visible as evidence.
  let outlook: unknown = null;
  try {
    const { runOutlookWatch } = await import("../../../../lib/senders");
    outlook = await runOutlookWatch();
  } catch (e: any) { outlook = { error: e?.message ?? "outlook_watch_failed" }; }

  // Reconcile inboxes stuck in error each tick, hands-off: clear false errors on
  // credential-less upstream senders (nothing to verify from here) and re-verify
  // real SMTP logins, flipping error->warming on success so a just-fixed
  // credential (e.g. a self-healed base64 password) rejoins the send rotation
  // without waiting for someone to open the Senders panel or the 24h sweep window.
  let revive: unknown = null;
  try {
    const { listSenderWorkspaceIds } = await import("../../../../lib/senders");
    const { reviveErroredSmtpLogins } = await import("../../../../lib/senders/infra");
    const ids = await listSenderWorkspaceIds();
    let checked = 0, revived = 0, stillFailing = 0, cleared = 0;
    for (const ws of ids) {
      try { const r = await reviveErroredSmtpLogins(ws, 60); checked += r.checked; revived += r.revived; stillFailing += r.stillFailing; cleared += r.cleared; }
      catch { /* per-workspace best-effort */ }
    }
    revive = { workspaces: ids.length, checked, revived, stillFailing, cleared };
  } catch (e: any) { revive = { error: e?.message ?? "revive_failed" }; }

  // Onboarding audit over never-audited Email IDs (any import path): SMTP login,
  // live DNS posture, blocklists, mail-server rDNS. Stamped per inbox, reported
  // to the health board, owner alerted once per new failure set. Bounded per
  // tick so a large backfill spreads across the day.
  let onboarding: unknown = null;
  try {
    const { auditPendingOnboards } = await import("../../../../lib/senders/onboarding");
    onboarding = await auditPendingOnboards();
  } catch (e: any) { onboarding = { error: e?.message ?? "onboarding_audit_failed" }; }

  // HEALTH LEDGER: observe every sending domain and Email ID, write today's row and
  // open/close the typed events that explain why anything stopped. Runs AFTER the
  // guard, the onboarding audit and the revive sweep, so a hold stamped a moment ago
  // is already visible as a cause rather than showing up an hour late. Self-debounced,
  // so a tighter tick cadence never re-pulls the warm-up fleet.
  let ledger: unknown = null;
  try {
    const { recordLedgerTick } = await import("../../../../lib/senders/ledger");
    ledger = await recordLedgerTick();
  } catch (e: any) { ledger = { error: e?.message ?? "ledger_tick_failed" }; }

  // Sending-IP reputation alarm: a public blocklist listing (named by the receivers
  // themselves in the block ledger) stops mail at many receivers at once and puts the
  // sending DOMAINS at risk, so it pages the owner once per distinct listing state.
  let ipReputation: unknown = null;
  try {
    const { checkSendingIpReputation } = await import("../../../../lib/senders/ipReputation");
    ipReputation = await checkSendingIpReputation();
  } catch (e: any) { ipReputation = { error: e?.message ?? "ip_reputation_check_failed" }; }

  // MPC variant bank: the weekly Haiku refresh of pre-generated Day-0 phrasing variants (the
  // layer that replaced per-send humanizer spend). Self-gating: a no-op unless the bank is
  // stale (>7d), incomplete, or a template changed; when it does run it's ~50 small calls.
  let variants: unknown = null;
  try {
    const { refreshVariantBank } = await import("../../../../lib/bd/mpc/variantBank");
    variants = await refreshVariantBank();
  } catch (e: any) { variants = { error: e?.message ?? "variant_refresh_failed" }; }

  // Bounce feedback loop: every address the fleet NDR sweep has recorded as bounced
  // (snap_mpc_ndr_v1, cumulative) is marked emailInvalid in the curation store, so a
  // known-dead email can never be re-curated or re-sent. This was a stopped-container
  // manual repair (tools/invalidate-bounced.mjs, 8/18); hourly + through the app it
  // needs no downtime and survives the hydration trap.
  let bounceFeedback: unknown = null;
  try {
    const { loadSnapshot } = await import("../../../../lib/db");
    const ndr = await loadSnapshot<{ bounced?: string[] }>("mpc_ndr_v1");
    const addrs = ndr?.bounced ?? [];
    if (addrs.length) {
      const { invalidateBouncedEmails } = await import("../../../../lib/inmarket/curation");
      const r = await invalidateBouncedEmails(addrs, new Date().toISOString());
      bounceFeedback = { bounced: addrs.length, newlyInvalidated: r.flagged };
    } else {
      bounceFeedback = { bounced: 0, newlyInvalidated: 0 };
    }
  } catch (e: any) { bounceFeedback = { error: e?.message ?? "bounce_feedback_failed" }; }

  // Verdict sync (owner mandate 2026-08-20): the send-time verification belt (tools/batch.mjs)
  // re-checks addresses live right before a send and caches the verifier's word in
  // snap_mpc_verify_cache_v1. Folding those verdicts back here keeps the store honest: a
  // live "invalid" becomes emailInvalid (and flows to the rescue finders), a live "safe"
  // gives the row its status word. Newer store verdicts are never overwritten.
  let verdictSync: unknown = null;
  try {
    const { loadSnapshot } = await import("../../../../lib/db");
    const cache = await loadSnapshot<{ entries?: Record<string, { at?: string; verdict?: string; status?: string }> }>("mpc_verify_cache_v1");
    const entries = cache?.entries ?? {};
    if (Object.keys(entries).length) {
      const { syncExternalVerdicts } = await import("../../../../lib/inmarket/curation");
      verdictSync = await syncExternalVerdicts(entries, new Date().toISOString());
    } else {
      verdictSync = { applied: 0, considered: 0 };
    }
  } catch (e: any) { verdictSync = { error: e?.message ?? "verdict_sync_failed" }; }

  // Staff-mailbox fail-safe sweep (owner mandate 2026-08-19): suppression
  // entries for workspace members' own login mailboxes rest 48h max. The Aug 5
  // incident hid five bouncing recruiter boxes behind a silent 30-day
  // suppression; this re-opens staff mail automatically once the rest is
  // served, and suppress() pages the owner the moment a new one appears.
  let staffSuppression: unknown = null;
  try {
    const { sweepStaffSuppressions } = await import("../../../../lib/sending/store");
    staffSuppression = await sweepStaffSuppressions();
  } catch (e: any) { staffSuppression = { error: e?.message ?? "staff_suppression_sweep_failed" }; }

  // Reply + bounce sync over the pool's own inboxes (IMAP). The hourly server
  // timer drives this in prod even when the in-process scheduler is off, so
  // replies to pool/MTA cold sends always stop sequences and reach a human.
  let replies: unknown = null;
  try {
    const { runReplySync } = await import("../../../../lib/senders");
    replies = await runReplySync();
  } catch (e: any) { replies = { error: e?.message ?? "reply_sync_failed" }; }

  // Candidate job blasts (lib/recruiting/jobBlast): send the next paced wave of
  // every active blast. Window-gated + capped inside the tick; a workspace with
  // no active blast is a no-op.
  let jobBlasts: unknown = null;
  try {
    const { runJobBlastTickAll } = await import("../../../../lib/recruiting/jobBlast");
    jobBlasts = await runJobBlastTickAll();
  } catch (e: any) { jobBlasts = { error: e?.message ?? "job_blast_tick_failed" }; }

  return NextResponse.json({ ok: true, ticked: results.length, results, seeds, setups, fleet, guard, outlook, revive, onboarding, ipReputation, ledger, variants, bounceFeedback, verdictSync, staffSuppression, replies, jobBlasts });
}

export const GET = run;
export const POST = run;
