#!/usr/bin/env bash
# RecruitersOS · daily numbers pass — refresh every portal figure, then prove it is right.
#
# The fast cadence (mpc-monitor.timer, every 20 minutes) already rewrites most number snapshots.
# What it never did was CHECK them, and it skips the once-a-day work. On 2026-08-20 the Dashboard
# sat on "0 replies / 0% reply rate" for two days against nine real replies, refreshing punctually
# the whole time, because a confident wrong number looks exactly like a right one.
#
# So, every day: rebuild the numbers from source, run the once-a-day advisor (which mpc-daily.sh
# only ran Mon-Fri), and then audit every portal figure against the ledger underneath it. The
# audit emails the owner when the verdict gets worse, and always feeds the System Health board.
#
# Runs on the HOST via recruiteros-numbers.timer.
set -euo pipefail
cd /opt/recruiteros
mkdir -p mpc-out
LOG="mpc-out/numbers-$(date +%F).log"
echo "===== numbers pass $(date -u +%FT%TZ) =====" >> "$LOG"

DOCK=(docker run --rm
  -v recruiteros_app_data:/data
  -v /opt/recruiteros/tools:/tools:ro
  -v /opt/recruiteros/mpc-out:/out
  --entrypoint node recruiteros-app)

# 1) Rebuild the Dashboard's own numbers from the send + reply ledgers, so the audit below reads
#    a snapshot written seconds ago rather than up to twenty minutes old. Any drift it then finds
#    is a real fault in the aggregator, never a timing artefact.
"${DOCK[@]}" /tools/mpc-stats.mjs >> "$LOG" 2>&1 || true

# 2) The Advisor card ("how to move the needle") is one Haiku read of the engine. It used to be
#    written only by mpc-daily.sh, which is Mon-Fri, so the card aged over every weekend. Daily.
grep -E '^(ANTHROPIC_API_KEY|SMARTLEAD_API_KEY)=' .env.production > /tmp/nb-adv.env
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out --env-file /tmp/nb-adv.env \
  --entrypoint node recruiteros-app /tools/mpc-advisor.mjs >> "$LOG" 2>&1 || true
rm -f /tmp/nb-adv.env

# 3) The audit. Runs on the HOST (not in a container): it compares the docker volume's snapshots
#    against the tool output logs and the repo checkout, all of which live out here.
#    The three values it needs are read out of .env.production and handed over as literal
#    environment variables. They are NEVER sourced as shell: EMAIL_FROM holds an address in
#    angle brackets ("RecruitersOS <no-reply@...>"), which a `.` of the file parses as a
#    redirection and dies on.
envval() { sed -n "s/^$1=//p" .env.production | head -1; }
RESEND_API_KEY="$(envval RESEND_API_KEY)" \
OWNER_EMAIL="$(envval OWNER_EMAIL)" \
EMAIL_FROM="$(envval EMAIL_FROM)" \
  node /opt/recruiteros/tools/numbers-audit.mjs >> "$LOG" 2>&1 || true

# 4) Refresh the health board immediately so the audit's verdict is visible in the portal now,
#    instead of on the next quarter-hour tick.
node /opt/recruiteros/tools/system-health.mjs >> "$LOG" 2>&1 || true

tail -n 20 "$LOG"
