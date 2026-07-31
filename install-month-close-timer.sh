#!/usr/bin/env bash
#
# ONE-TIME install: the job that closes each month's books on its own.
#
# The nightly sweep next door COLLECTS receipts. This one JUDGES, and that is the
# difference between a system that gathers paperwork and a system nobody has to remember.
# Every morning it asks two questions and emails the owner only when the answer needs a
# person:
#
#   1. Is the last closed month fully proven, and if not, is anything even collecting it?
#   2. Has collection stopped RIGHT NOW? A browser session that lapsed on the 2nd costs
#      four weeks of paperwork if the first anyone hears of it is the month-end report.
#
# Silence means the books are proven. That is the contract.
#
# Daily on purpose, even though it closes a month: the job itself decides what is worth
# saying (grace window before a month is judged, never the same picture twice, at most
# weekly while nothing changes), so the schedule does not have to be clever. A month that
# is still short on the 12th gets chased on the 12th, not forgotten until next year.
#
# Run once on the app server as root:
#
#   RECRUITEROS_CRON_SECRET=xxxxx bash /opt/recruiteros/install-month-close-timer.sh
#
# Optional overrides:
#   CLOSE_URL   base URL the timer curls   (default: http://127.0.0.1:3000)
#   AT          time of day to run         (default: 07:10, after the 06:15 sweep)
#
# Requires RESEND_API_KEY and EMAIL_FROM in the app environment, and OWNER_EMAIL for the
# recipient. Without a key the job still runs and still records its verdict; it just says
# so in the response instead of sending. Check with:
#
#   curl -s -H "x-cron-secret: $SECRET" "http://127.0.0.1:3000/api/owner/receipts/close?notify=0" | head -c 400
#
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

CLOSE_URL="${CLOSE_URL:-http://127.0.0.1:3000}"
AT="${AT:-07:10}"

SECRET="${RECRUITEROS_CRON_SECRET:-}"
if [ -z "$SECRET" ]; then
  SECRET="$(docker compose -f "$DIR/docker-compose.yml" exec -T app printenv RECRUITEROS_CRON_SECRET 2>/dev/null | tr -d '\r' || true)"
fi
if [ -z "$SECRET" ]; then
  echo "ERROR: RECRUITEROS_CRON_SECRET is not set and could not be read from the app container." >&2
  echo "       Re-run as:  RECRUITEROS_CRON_SECRET=<secret> bash $0" >&2
  exit 1
fi

ENVFILE=/etc/recruiteros-month-close.env
umask 077
cat > "$ENVFILE" <<EOF
CLOSE_URL=$CLOSE_URL
RECRUITEROS_CRON_SECRET=$SECRET
EOF

cat > /etc/systemd/system/recruiteros-month-close.service <<'EOF'
[Unit]
Description=RecruitersOS month close (is every charge proven, and is anything still collecting)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/recruiteros-month-close.env
# Waits for the verdict: this one is seconds, not minutes, because it reads the books
# rather than sweeping a mailbox. The log line is the audit trail of what it decided.
ExecStart=/usr/bin/curl -fsS -m 180 -X POST -H "x-cron-secret: ${RECRUITEROS_CRON_SECRET}" "${CLOSE_URL}/api/owner/receipts/close"
TimeoutStartSec=300
EOF

cat > /etc/systemd/system/recruiteros-month-close.timer <<EOF
[Unit]
Description=Close the RecruitersOS books daily at $AT

[Timer]
OnCalendar=*-*-* $AT:00
# Up to 10 minutes of jitter so a deploy restarting the app at the same moment every day
# cannot land on the tick forever.
RandomizedDelaySec=600
# A box that was off at $AT still closes the month when it comes back. This is the whole
# point of a job that must not be missed.
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-month-close.timer
echo "installed. next run:"
systemctl list-timers recruiteros-month-close.timer --no-pager | head -3
echo
echo "fire it now without sending anything:"
echo "  curl -s -H 'x-cron-secret: <secret>' '$CLOSE_URL/api/owner/receipts/close?notify=0'"
