#!/usr/bin/env bash
#
# RecruitersOS video worker AUTO-UPDATE
#
# Installs a systemd timer that keeps /opt/recruiteros on origin/main, the same
# way the main app box self-deploys. Added after the Aug 2026 incident where the
# render fleet ran a fix branch while main lagged behind it, and boxes only ever
# updated when a person SSHed into each one.
#
# Behavior every 5 minutes (staggered per box):
#   - fetch origin/main; if HEAD already matches, do nothing
#   - hard-reset the repo to origin/main (branch checkouts are deliberately
#     reverted: prod == origin/main, fleet included)
#   - npm install only when integration/package*.json changed
#   - restart the worker ONLY when worker-relevant files changed, so unrelated
#     pushes to main never kill an in-flight composite
#   - touch /etc/recruiteros-video-worker.hold to pause updates on a box while
#     testing; remove the file to resume
#
# Idempotent: safe to re-run. Run as root on the worker box.
set -uo pipefail

cat > /usr/local/bin/recruiteros-video-worker-update.sh <<'EOF'
#!/usr/bin/env bash
# Keep the video worker checkout on origin/main. Installed by setup-video-worker-autoupdate.sh.
set -uo pipefail
exec 9>/var/lock/recruiteros-video-worker-update.lock
flock -n 9 || exit 0
REPO=/opt/recruiteros
HOLD=/etc/recruiteros-video-worker.hold
log() { echo "[worker-update] $*"; }
if [ -f "$HOLD" ]; then log "hold file present ($HOLD), skipping update"; exit 0; fi
cd "$REPO" || { log "repo missing at $REPO"; exit 1; }
git fetch origin main -q || { log "git fetch failed, will retry next tick"; exit 0; }
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

DEPS=0
git diff --name-only "$LOCAL" "$REMOTE" -- integration/package.json integration/package-lock.json 2>/dev/null | grep -q . && DEPS=1
RESTART=0
git diff --name-only "$LOCAL" "$REMOTE" -- integration/scripts/video-worker.ts integration/lib integration/package.json integration/package-lock.json 2>/dev/null | grep -q . && RESTART=1

git checkout -q main 2>/dev/null || git checkout -qb main "$REMOTE"
git reset --hard -q "$REMOTE" || { log "reset failed"; exit 1; }

if [ "$DEPS" = "1" ]; then
  log "package files changed, running npm install"
  ( cd integration && npm install --no-audit --no-fund >/dev/null 2>&1 ) || log "WARNING: npm install failed, worker may fail until dependencies are fixed"
fi

if [ "$RESTART" = "1" ]; then
  systemctl restart recruiteros-video-worker
  log "updated ${LOCAL:0:8} -> ${REMOTE:0:8}, worker restarted (worker files changed)"
else
  log "updated ${LOCAL:0:8} -> ${REMOTE:0:8}, no worker restart needed"
fi
EOF
chmod 755 /usr/local/bin/recruiteros-video-worker-update.sh

cat > /etc/systemd/system/recruiteros-video-worker-update.service <<'EOF'
[Unit]
Description=RecruitersOS video worker auto-update (track origin/main)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/recruiteros-video-worker-update.sh
EOF

cat > /etc/systemd/system/recruiteros-video-worker-update.timer <<'EOF'
[Unit]
Description=Run the video worker auto-update every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=90
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-video-worker-update.timer
echo "[autoupdate-setup] installed. Timer state: $(systemctl is-active recruiteros-video-worker-update.timer)"
echo "[autoupdate-setup] pause updates on this box with: touch /etc/recruiteros-video-worker.hold"
