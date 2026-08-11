#!/usr/bin/env bash
# RecruitersOS · MPC daily outreach (Ryan / CPA-Controller) + reply monitor.
# Sends today's FRESH, gated, de-duped, never-re-contacted batch, then reads replies back and
# refreshes the per-variant leaderboard. Sends nothing if there are no fresh prospects.
set -euo pipefail
cd /opt/recruiteros
mkdir -p mpc-out
LOG="mpc-out/daily-$(date +%F).log"
# Send ceiling. Actual sends = min(cap, fresh clean supply), so this never forces volume that
# isn't there; it just uncaps the pipeline up to the daily target.
DAILY_CAP="${MPC_DAILY_CAP:-400}"

echo "===== MPC daily run $(date -u +%FT%TZ) =====" >> "$LOG"

# 0) Standing rota: re-queue the finance search bank DAILY so the pool keeps refilling with fresh
#    postings. Daily uses a 3-day window (quota-efficient); Mondays widen to a full week.
WINDOW=3days; [ "$(date +%u)" = "1" ] && WINDOW=week
echo "-- refreshing finance search bank (window=$WINDOW) --" >> "$LOG"
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
  -e MPC_SEARCH_DATE="$WINDOW" --entrypoint node recruiteros-app \
  /tools/seed-finance-searches.mjs >> "$LOG" 2>&1 || true

# 1) Outreach: gate -> write -> render-gate -> suppress/dedupe -> send (capped for deliverability).
grep -E '^(ANTHROPIC_API_KEY|SENDINGAC_MAILBOX_API_KEY)=' .env.production > /tmp/mpc.env
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/mpc.env --entrypoint node recruiteros-app \
  /tools/batch.mjs --send --limit "$DAILY_CAP" >> "$LOG" 2>&1
rm -f /tmp/mpc.env

# 2) Monitor: read inboxes back, match replies, print the per-variant leaderboard.
grep -E '^(SENDINGAC_MAILBOX_API_KEY)=' .env.production > /tmp/mon.env
docker run --rm \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/mon.env --entrypoint node recruiteros-app \
  /tools/monitor.mjs >> "$LOG" 2>&1
rm -f /tmp/mon.env

echo "===== done $(date -u +%FT%TZ) =====" >> "$LOG"
