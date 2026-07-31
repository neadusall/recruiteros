#!/usr/bin/env bash
#
# ONE-TIME install: the nightly receipt sweep behind Owner Console -> Spend master.
#
# Each run re-reads the billing mailboxes over IMAP for anything new, and pulls the
# vendors that expose a real billing API (Telnyx today) for any month they have closed
# since the last run. Both halves are idempotent: the mailbox sweep is read-only and
# de-duplicates on the message, and a closed month already on file is never re-summed.
# So a receipt that arrives late is picked up by the next night rather than being lost,
# which is the whole point of running it on a timer instead of a button.
#
# Run once on the app server as root:
#
#   RECRUITEROS_CRON_SECRET=xxxxx bash /opt/recruiteros/install-receipts-timer.sh
#
# Optional overrides:
#   RECEIPTS_URL   base URL the timer curls   (default: http://127.0.0.1:3000)
#   AT             time of day to run         (default: 06:15)
#   MONTHS_BACK    trailing window to re-read (default: 2)
#
# MONTHS_BACK of 2 is deliberate: vendors routinely send a receipt days into the next
# month, and a two-month window means the previous month keeps filling in after it ends.
#
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

RECEIPTS_URL="${RECEIPTS_URL:-http://127.0.0.1:3000}"
AT="${AT:-06:15}"
MONTHS_BACK="${MONTHS_BACK:-2}"

# The cron secret must match the app's RECRUITEROS_CRON_SECRET. Prefer the env passed to
# this script; otherwise read it from the running app container so ops don't retype it.
SECRET="${RECRUITEROS_CRON_SECRET:-}"
if [ -z "$SECRET" ]; then
  SECRET="$(docker compose -f "$DIR/docker-compose.yml" exec -T app printenv RECRUITEROS_CRON_SECRET 2>/dev/null | tr -d '\r' || true)"
fi
if [ -z "$SECRET" ]; then
  echo "ERROR: RECRUITEROS_CRON_SECRET is not set and could not be read from the app container." >&2
  echo "       Re-run as:  RECRUITEROS_CRON_SECRET=<secret> bash $0" >&2
  exit 1
fi

# THE APP IS NOT PUBLISHED ON THE HOST, SO THE DEFAULT URL HERE REACHES NOTHING.
#
# This is a second installer for the SAME unit name as install-receipt-sweep-timer.sh, which
# drives the sweep with `docker exec` instead of curl. Running this one after that one
# replaced a working unit with `curl http://127.0.0.1:3000`, and nothing binds host port 3000
# on this box: every nightly tick died with "Failed to connect", which looks in Spend master
# exactly like a quiet month with no receipts. Found 2026-07-31, hours after install.
#
# So prove the URL answers BEFORE overwriting anything. A loud refusal is recoverable; a
# timer that fires nightly into a closed port is not, because nobody looks at it.
if ! curl -fsS -m 10 -o /dev/null "$RECEIPTS_URL/api/health" 2>/dev/null \
  && ! curl -fsS -m 10 -o /dev/null "$RECEIPTS_URL/" 2>/dev/null; then
  echo "ERROR: nothing answers at $RECEIPTS_URL, so the nightly sweep would fail silently." >&2
  echo "       On this box the app container publishes no host port. Either:" >&2
  echo "         bash $DIR/install-receipt-sweep-timer.sh      # talks to the container directly" >&2
  echo "       or re-run with a URL that answers, e.g.:" >&2
  echo "         RECEIPTS_URL=https://recruitersos.co bash $0" >&2
  exit 1
fi

ENVFILE=/etc/recruiteros-receipts.env
umask 077
cat > "$ENVFILE" <<EOF
RECEIPTS_URL=$RECEIPTS_URL
MONTHS_BACK=$MONTHS_BACK
RECRUITEROS_CRON_SECRET=$SECRET
EOF

cat > /etc/systemd/system/recruiteros-receipts.service <<'EOF'
[Unit]
Description=RecruitersOS receipt sweep (billing mailboxes + vendor billing APIs -> Spend master)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/recruiteros-receipts.env
# wait=0 returns as soon as the mailbox sweep is handed off, so the unit does not sit open
# while every receipt is rendered to an image. The vendor pull runs before the response and
# is quick once the first backfill is done, hence the generous but bounded timeout.
ExecStart=/usr/bin/curl -fsS -m 600 -X POST -H "x-cron-secret: ${RECRUITEROS_CRON_SECRET}" "${RECEIPTS_URL}/api/owner/receipts/cron?monthsBack=${MONTHS_BACK}&wait=0&vendors=1"
TimeoutStartSec=900
EOF

cat > /etc/systemd/system/recruiteros-receipts.timer <<EOF
[Unit]
Description=Run the RecruitersOS receipt sweep nightly at $AT

[Timer]
OnCalendar=*-*-* $AT:00
AccuracySec=1min
# Catch up after a reboot or an outage: a missed night still gets its sweep.
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-receipts.timer

echo "Installed. Receipts are swept nightly at $AT over a ${MONTHS_BACK}-month window."
echo
echo "  Timer status:   systemctl status recruiteros-receipts.timer"
echo "  Next run:       systemctl list-timers recruiteros-receipts.timer"
echo "  Sweep now:      systemctl start recruiteros-receipts.service"
echo "  Turn it off:    systemctl disable --now recruiteros-receipts.timer"
echo
echo "Nothing is swept until a billing mailbox is configured:"
echo "  bash $DIR/set-billing-inbox.sh <email> <app-password> [imap-host]"
