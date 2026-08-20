#!/usr/bin/env bash
# Reply monitor (fast cadence): inbox read-back + variant leaderboard + reply bridge to the portal,
# then refresh the BD cockpit stats snapshot the Dashboard reads.
# Tracked in the repo since 2026-08-20 (deploys manage it); the systemd unit runs this path.
set -euo pipefail
cd /opt/recruiteros
mkdir -p mpc-out
LOG="mpc-out/monitor-$(date +%F).log"

# ============================================================================
# WATCH -> CONNECT pipeline runs FIRST, before the slow inbox monitor, so a video
# watcher gets their LinkedIn connection request promptly each cycle instead of
# waiting behind the 900-mailbox read-back. Resolve profiles (watchers first) ->
# rebuild the watchers snapshot -> auto-connect sweep (LinkedIn OS paces sends).
# ============================================================================
grep -E '^(ANTHROPIC_API_KEY)=' .env.production > /tmp/li.env || true
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/li.env --entrypoint node recruiteros-app /tools/linkedin-resolve.mjs >> "$LOG" 2>&1 || true
rm -f /tmp/li.env
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app /tools/mpc-watchers.mjs >> "$LOG" 2>&1 || true
CRON_SECRET=$(grep -E '^RECRUITEROS_CRON_SECRET=' .env.production | cut -d= -f2-)
if [ -n "$CRON_SECRET" ]; then
  curl -fsS -m 30 -X POST -H "x-cron-secret: $CRON_SECRET" https://app.lumesp.com/api/mpc-connect/sweep >> "$LOG" 2>&1 || true
fi

# CONTINUOUS OUTBOUND (every 20 min): drain ready leads to the daily cap so nothing warm ever sits
# waiting for a once-a-day run. Per-run cap paces it; the daily cap is the safe ceiling across
# runs; suppressed/snoozed cohorts are skipped by the sender. This is the always-on machine.
# 2026-08-20: the send env now carries the verifier key (pre-send verification belt), the owner
# alert keys (fuse/breaker emails) and every MPC_* tuning knob from .env.production.
grep -E '^(ANTHROPIC_API_KEY|SENDINGAC_MAILBOX_API_KEY|REOON_API_KEY|REOON_VERIFY_MODE|RESEND_API_KEY|OWNER_EMAIL|EMAIL_FROM|MPC_[A-Z_]+)=' .env.production > /tmp/send.env
grep -E '^ALERT_(TELNYX_KEY|SMS_FROM|SMS_TO|SMS_PROFILE)=' /etc/ros-alert.env >> /tmp/send.env 2>/dev/null || true  # owner SMS on fuse trips
# SEND FUSE: evaluate the fleet fuse + per-source breakers against the latest bounce sweep BEFORE
# anything sends (batch.mjs re-evaluates too; this pass is what emails the owner on a state change
# even on a tick where nothing is due). Exit 2 = tripped; the senders below hold on their own.
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/send.env --entrypoint node recruiteros-app \
  /tools/send-fuse.mjs >> "$LOG" 2>&1 || true
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/send.env -e MPC_DAILY_CAP="${MPC_DAILY_CAP:-1500}" --entrypoint node recruiteros-app \
  /tools/batch.mjs --send --limit "${MPC_SEND_PER_RUN:-150}" >> "$LOG" 2>&1 || true

# FILL THE GAP: after fresh leads, spend any remaining daily capacity on follow-ups to prospects
# who never replied (2nd/3rd touch). Shares the daily ceiling; hard-stops on any reply. This is what
# guarantees capacity is never left on the table when fresh supply is thin.
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/send.env -e MPC_DAILY_CAP="${MPC_DAILY_CAP:-1500}" --entrypoint node recruiteros-app \
  /tools/followup.mjs --send >> "$LOG" 2>&1 || true

# PUBLISH TODAY'S COLD CEILING (read-only, spends nothing). The portal's Senders tab, Send
# Queue gauge and story card all read this ledger, so the number a person sees is the number
# the sender just enforced. Runs AFTER the senders so it also captures this tick's sends;
# running it here (not only inside a send) keeps the figure fresh on a tick that had nothing
# to send, instead of going stale and reading as "the lane stopped".
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/send.env --entrypoint node recruiteros-app \
  /tools/batch.mjs --capacity >> "$LOG" 2>&1 || true
rm -f /tmp/send.env

# ============================================================================
# THE SLOW HALF MOVED OUT (2026-08-20). Everything below the send steps — the
# 900-mailbox reply sweep and the stats/deliverability/site-visitor refreshes —
# now runs from mpc-replies.sh on its own timer.
#
# WHY. This script is the continuous SENDER, and the reply sweep sits after the
# send steps in the same tick, so a slow sweep pushes the NEXT tick's sends back
# with it. The sweep runs against a rate-limited Mailbox API and grinds in partial
# throttle, so ticks were taking ~55 min against a 20-min timer. Measured on
# 2026-08-20 the send lane fired at 11:52, 12:47, 13:41, 14:42, 15:39, 16:56,
# 18:25, 19:30, 20:25, 21:21 — roughly hourly, a third of the intended cadence,
# on a day the fleet had 700+/day of unused headroom. Reads and writes are
# independent here, so they no longer share a clock.
# ============================================================================
