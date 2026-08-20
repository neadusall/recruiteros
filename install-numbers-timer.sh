#!/usr/bin/env bash
#
# ONE-TIME install: the daily pass that refreshes every portal number and then proves it.
#
# The 20-minute monitor already rewrites most number snapshots. It never checked them. On
# 2026-08-20 the Dashboard on app.lumesp.com showed "0 replies, 0% reply rate" against 2,177
# sends while nine people had actually written back, and it refreshed on schedule the entire
# time: a confident wrong number is indistinguishable from a right one until something
# re-derives it from the ledger underneath. That is what this timer does, once a day.
#
# It also picks up the once-a-day work the weekday-only send rota was doing, so the Advisor
# card no longer ages over a weekend.
#
# Run once on the app server as root:
#
#   bash /opt/recruiteros/install-numbers-timer.sh
#
# Optional override:
#   AT   time of day to run, UTC   (default: 12:30, early enough that a fault found this
#                                   morning is fixable during the working day)
#
# Silence means the numbers agree with their sources. The audit emails the owner only when
# the verdict gets WORSE than the previous run, so a known problem never nags daily, and it
# always writes its findings to Admin > System Health, group "Numbers & tracking".
#
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
AT="${AT:-12:30}"

if [ ! -x "$DIR/tools/numbers-daily.sh" ] && [ ! -f "$DIR/tools/numbers-daily.sh" ]; then
  echo "ERROR: $DIR/tools/numbers-daily.sh is missing. Deploy first, then re-run." >&2
  exit 1
fi
chmod +x "$DIR/tools/numbers-daily.sh" 2>/dev/null || true

cat > /etc/systemd/system/recruiteros-numbers.service <<EOF
[Unit]
Description=RecruitersOS daily numbers pass (rebuild every portal figure, then audit it against its source)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
# Minutes, not seconds: the pass rebuilds the stats snapshot from the whole send ledger and
# makes one Haiku call for the Advisor card. The timeout is a backstop against a wedged
# container, not a normal bound.
ExecStart=/usr/bin/env bash $DIR/tools/numbers-daily.sh
TimeoutStartSec=1800
EOF

cat > /etc/systemd/system/recruiteros-numbers.timer <<EOF
[Unit]
Description=Audit the RecruitersOS portal numbers daily at $AT UTC

[Timer]
OnCalendar=*-*-* $AT:00
# Jitter so a deploy recreating the app at the same minute every day cannot shadow this
# tick forever.
RandomizedDelaySec=600
# A box that was down at $AT still runs the pass when it comes back. The whole value of this
# job is that a day never goes unchecked.
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-numbers.timer
echo "installed. next run:"
systemctl list-timers recruiteros-numbers.timer --no-pager | head -3
echo
echo "run it now:"
echo "  systemctl start recruiteros-numbers.service && journalctl -u recruiteros-numbers -n 40 --no-pager"
