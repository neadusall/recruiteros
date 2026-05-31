#!/usr/bin/env bash
#
# ONE-TIME install: sets up automatic deployment on this server.
# After you run this once, every change pushed to GitHub main goes live within
# ~2 minutes, with zero manual steps. Run it on the server as root:
#
#   bash /opt/recruiteros/install-auto-deploy.sh
#
set -euo pipefail
DIR="/opt/recruiteros"

chmod +x "$DIR/auto-deploy.sh"

# systemd service: runs the watcher once.
cat > /etc/systemd/system/recruiteros-deploy.service <<EOF
[Unit]
Description=RecruiterOS auto-deploy (pull + redeploy on new commit)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=/usr/bin/env bash $DIR/auto-deploy.sh
EOF

# systemd timer: fires the service every 2 minutes.
cat > /etc/systemd/system/recruiteros-deploy.timer <<EOF
[Unit]
Description=Run RecruiterOS auto-deploy every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
Unit=recruiteros-deploy.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-deploy.timer

echo ""
echo "============================================================"
echo "Auto-deploy is ON. Every push to GitHub main goes live in ~2 min."
echo ""
echo "  Watch deploys:   tail -f /var/log/recruiteros-deploy.log"
echo "  Timer status:    systemctl status recruiteros-deploy.timer"
echo "  Force a deploy:  systemctl start recruiteros-deploy.service"
echo "  Turn it off:     systemctl disable --now recruiteros-deploy.timer"
echo "============================================================"
