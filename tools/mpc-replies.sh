#!/usr/bin/env bash
# RecruitersOS · MPC reads + refreshes (the SLOW half, split out of mpc-monitor.sh 2026-08-20).
#
# The 900-mailbox reply sweep plus the stats, growth, sent-feed, deliverability and
# site-visitor refreshes. Split off its own timer because it used to run in the same tick
# as the senders: the sweep grinds against a rate-limited Mailbox API, and every minute it
# spent held up the NEXT tick's cold sends. Nothing here transmits mail, so it can take as
# long as it needs without costing send cadence.
set -euo pipefail
cd /opt/recruiteros
mkdir -p mpc-out
LOG="mpc-out/monitor-$(date +%F).log"

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
