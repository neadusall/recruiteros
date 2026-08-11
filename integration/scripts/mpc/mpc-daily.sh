#!/usr/bin/env bash
# RecruitersOS · MPC daily outreach (Ryan / CPA-Controller) + reply monitor.
# Sends today's FRESH, gated, de-duped, never-re-contacted batch, then reads replies back and
# refreshes the per-variant leaderboard. Sends nothing if there are no fresh prospects.
set -euo pipefail
cd /opt/recruiteros
mkdir -p mpc-out
LOG="mpc-out/daily-$(date +%F).log"
DAILY_CAP="${MPC_DAILY_CAP:-40}"

echo "===== MPC daily run $(date -u +%FT%TZ) =====" >> "$LOG"

# 0) Standing rota: on Mondays, re-queue the finance search bank so the pool keeps refilling with
#    fresh postings (the runner scrapes them; curation enriches + validates over the week).
if [ "$(date +%u)" = "1" ]; then
  echo "-- Monday: refreshing finance search bank --" >> "$LOG"
  docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
    --entrypoint node recruiteros-app /tools/seed-finance-searches.mjs >> "$LOG" 2>&1 || true
fi

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
