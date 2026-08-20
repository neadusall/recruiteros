#!/usr/bin/env bash
# Install the MPC reads/refreshes timer (mpc-replies), split out of mpc-monitor 2026-08-20.
#
# WHY THIS EXISTS. mpc-monitor.sh is the continuous cold SENDER. The 900-mailbox reply sweep
# used to run in the same tick, after the send steps, so every minute the sweep spent grinding
# against the rate-limited Mailbox API pushed the NEXT tick's sends back with it. Measured that
# day, the send lane fired roughly hourly against a 20-minute timer while the fleet sat on
# 700+/day of unused headroom. Reads and writes are independent, so they get independent clocks.
#
# Idempotent: safe to re-run. Run on the box as root.
set -euo pipefail
UNIT=/etc/systemd/system

cat > "$UNIT/mpc-replies.service" <<'UNITEOF'
[Unit]
Description=RecruitersOS MPC reads + refreshes (reply sweep, stats, deliverability, visitors)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/recruiteros
ExecStart=/usr/bin/env bash /opt/recruiteros/tools/mpc-replies.sh
UNITEOF

cat > "$UNIT/mpc-replies.timer" <<'UNITEOF'
[Unit]
Description=Run the MPC reply sweep + cockpit refreshes every 20 minutes

[Timer]
OnBootSec=6min
OnUnitActiveSec=20min
# The sweep regularly runs long. Never let a slow pass stack a second one; the
# script's own container-name guard is the second line of defence.
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
UNITEOF

# mpc-monitor is now the SENDER only; its description said "reply monitor", which is exactly
# the confusion that hid this coupling for a week.
cat > "$UNIT/mpc-monitor.timer" <<'UNITEOF'
[Unit]
Description=Run the MPC cold sender (fuse, batch, follow-ups, capacity) every 20 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=20min
Persistent=true

[Install]
WantedBy=timers.target
UNITEOF

systemctl daemon-reload
systemctl enable --now mpc-replies.timer
systemctl restart mpc-monitor.timer
echo "installed: mpc-replies.timer (reads) + mpc-monitor.timer (sends) now run on separate clocks"
systemctl list-timers 'mpc-*' --all --no-pager | head -6
