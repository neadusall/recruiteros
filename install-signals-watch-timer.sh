#!/usr/bin/env bash
#
# ONE-TIME install: the 15-minute Signal Watchlist poller.
#
# Points a systemd timer at POST /api/signals/watch?tick=1 every 15 minutes. Each tick advances
# every DUE watchlist one poll (job-feed pull -> dedupe -> curate 3 decision-makers -> Clients tab),
# entirely server-side. The tick is single-flight and fire-and-forget, so overlapping hits are
# harmless and a long poll never blocks the timer.
#
# Run once on the app server as root:
#
#   RECRUITEROS_CRON_SECRET=xxxxx bash /opt/recruiteros/install-signals-watch-timer.sh
#
# Optional overrides:
#   WATCH_URL   base URL the timer curls           (default: http://127.0.0.1:3000)
#   EVERY       poll cadence                        (default: 15min)
#
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

WATCH_URL="${WATCH_URL:-http://127.0.0.1:3000}"
EVERY="${EVERY:-15min}"

# The cron secret must match the app's RECRUITEROS_CRON_SECRET. Prefer the env passed to this
# script; otherwise try to read it from the running app container so ops don't have to retype it.
SECRET="${RECRUITEROS_CRON_SECRET:-}"
if [ -z "$SECRET" ]; then
  SECRET="$(docker compose -f "$DIR/docker-compose.yml" exec -T app printenv RECRUITEROS_CRON_SECRET 2>/dev/null | tr -d '\r' || true)"
fi
if [ -z "$SECRET" ]; then
  echo "ERROR: RECRUITEROS_CRON_SECRET is not set and could not be read from the app container." >&2
  echo "       Re-run as:  RECRUITEROS_CRON_SECRET=<secret> bash $0" >&2
  exit 1
fi

# Persist the secret+url in a root-only env file the service reads (keeps it out of the unit file).
ENVFILE=/etc/recruiteros-signals-watch.env
umask 077
cat > "$ENVFILE" <<EOF
WATCH_URL=$WATCH_URL
RECRUITEROS_CRON_SECRET=$SECRET
EOF

cat > /etc/systemd/system/recruiteros-signals-watch.service <<'EOF'
[Unit]
Description=RecruitersOS Signal Watchlists (poll target-job feeds -> Clients tab)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/recruiteros-signals-watch.env
# Fire-and-forget on the server side; the tick's own mutex makes overlapping hits safe. A short
# curl timeout keeps a stuck request from wedging the oneshot; the next timer hit just retries.
ExecStart=/usr/bin/curl -fsS -m 20 -X POST -H "x-cron-secret: ${RECRUITEROS_CRON_SECRET}" "${WATCH_URL}/api/signals/watch?tick=1"
EOF

cat > /etc/systemd/system/recruiteros-signals-watch.timer <<EOF
[Unit]
Description=Run the RecruitersOS Signal Watchlist poll every $EVERY

[Timer]
OnBootSec=2min
OnUnitActiveSec=$EVERY
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-signals-watch.timer

echo "Installed. Signal Watchlists now poll every $EVERY -> ${WATCH_URL}/api/signals/watch"
echo
echo "  Timer status:   systemctl status recruiteros-signals-watch.timer"
echo "  Next runs:      systemctl list-timers recruiteros-signals-watch.timer"
echo "  Poll once now:  systemctl start recruiteros-signals-watch.service"
echo "  Peek state:     curl -s -H \"x-cron-secret: \$RECRUITEROS_CRON_SECRET\" \"$WATCH_URL/api/signals/watch?status=1\" | jq"
echo "  Turn it off:    systemctl disable --now recruiteros-signals-watch.timer"