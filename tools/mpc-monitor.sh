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

# One reply monitor at a time: a fixed container name makes a still-running
# previous sweep visible, so this tick skips instead of stacking a second
# 900-box read against a rate-limited Mailbox API. Non-fatal: a bad sweep
# must not kill the stats/deliverability steps below.
if docker ps -q --filter name='^mpc-reply-monitor$' | grep -q .; then
  echo "$(date -u +%FT%TZ) reply monitor still running from a previous tick; skipping this pass" >> "$LOG"
else
  grep -E '^(SENDINGAC_MAILBOX_API_KEY)=' .env.production > /tmp/mon.env
  docker run --rm --name mpc-reply-monitor \
    -v recruiteros_app_data:/data \
    -v /opt/recruiteros/tools:/tools:ro \
    -v /opt/recruiteros/mpc-out:/out \
    --env-file /tmp/mon.env --entrypoint node recruiteros-app \
    /tools/monitor.mjs >> "$LOG" 2>&1 || true
  rm -f /tmp/mon.env
fi

# Refresh the BD cockpit stats (sent, reply rate by variant, replies by sentiment, supply, boards).
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app \
  /tools/mpc-stats.mjs >> "$LOG" 2>&1 || true

# Growth Engine: idle demand + capacity gap + campaign proposals (the push-more-outbound layer).
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app \
  /tools/growth-engine.mjs >> "$LOG" 2>&1 || true

# Sent-message feed for the "Sent" audit view (the real emails + bodies the engine sent).
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app \
  /tools/mpc-sent-log.mjs >> "$LOG" 2>&1 || true

# DELIVERABILITY tracker: real, documented numbers on whether mail is landing (acceptance,
# hard-fail, bounce, complaint per sending domain + live Smartlead inbox-placement/warm-up
# reputation), appended to a 30-day history the cockpit reads. Needs the Smartlead key.
grep -E '^(SMARTLEAD_API_KEY)=' .env.production > /tmp/dl.env
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/dl.env --entrypoint node recruiteros-app \
  /tools/mpc-deliverability.mjs >> "$LOG" 2>&1 || true
rm -f /tmp/dl.env

# WHO IS ON YOUR SITE: resolve new lumesp.com visitors (Caddy access log) into
# companies, matched against the send ledger -> Dashboard card + connect list.
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  -v recruiteros_caddy_data:/caddylog:ro \
  --entrypoint node recruiteros-app \
  /tools/site-visitors.mjs >> "$LOG" 2>&1 || true

# (watch -> connect pipeline runs at the TOP of this script, before the slow inbox monitor)

# Publish the send schedule for the portal (PiP performance header): next drain
# tick + next daily run, straight from systemd. Last so it reflects this tick.
bash /opt/recruiteros/tools/publish-send-schedule.sh || true
