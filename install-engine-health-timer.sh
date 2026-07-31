#!/usr/bin/env bash
#
# Install the hourly JD Sourcing engine-health watch on `ros`.
#
# WHY: on 2026-07-30 the Serper key hit zero credits and nothing noticed. Serper
# had produced 61.8% of every candidate JD Sourcing ever sourced, so searches
# quietly collapsed and the first signal was recruiters saying it "didn't work",
# hours later, after the symptom had already been misdiagnosed once. This turns a
# silent hard outage into an in-app alert to the workspace owner.
#
# Run once on the box:  sudo bash install-engine-health-timer.sh
set -euo pipefail

UNIT=/etc/systemd/system/recruiteros-engine-health.service
TIMER=/etc/systemd/system/recruiteros-engine-health.timer
RUNNER=/usr/local/bin/recruiteros-engine-health.sh

install -d -m 755 /var/lib/recruiteros

cat > "$RUNNER" <<'EOF'
#!/usr/bin/env bash
# engine-health-runner-v2
# Hourly JD Sourcing discovery-engine check (Serper live canary + RapidAPI quota),
# via /api/sourcing/engine-health inside the app container. Alerts the workspace
# owner in-app on any transition to low/down.
#
# RETRIES on purpose. The single most common reason an hourly check silently does
# nothing is that it fired while the app container was mid-restart, and this box
# redeploys often. One missed tick is a missed hour of coverage, so try 3 times
# over ~40s before giving up.
#
# STAMP on purpose. On success we write /var/lib/recruiteros/engine-health.last.
# auto-deploy.sh (which runs every ~2 min and is the most reliable process on the
# box) converges on that stamp: if it goes stale, it reinstalls/kicks this watch.
# A monitor nobody monitors is how the thing it was meant to catch comes back.
set -uo pipefail

STAMP=/var/lib/recruiteros/engine-health.last
ATTEMPTS=3

run_once() {
  docker exec recruiteros-app-1 node -e "
fetch('http://localhost:3000/api/sourcing/engine-health', {
  headers: { 'x-cron-secret': process.env.RECRUITEROS_CRON_SECRET || '' },
})
  .then(async (r) => {
    const t = await r.text();
    console.log(r.status, t.slice(0, 2000));
    if (!r.ok) process.exit(1);
  })
  .catch((e) => { console.error(String(e)); process.exit(1); });
"
}

for i in $(seq 1 "$ATTEMPTS"); do
  if run_once; then
    date -u +%s > "$STAMP"
    exit 0
  fi
  echo "engine-health attempt $i/$ATTEMPTS failed" >&2
  [ "$i" -lt "$ATTEMPTS" ] && sleep 20
done
echo "engine-health FAILED after $ATTEMPTS attempts - engines are UNMONITORED this hour" >&2
exit 1
EOF
chmod +x "$RUNNER"

cat > "$UNIT" <<EOF
[Unit]
Description=RecruitersOS JD Sourcing discovery-engine health check
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$RUNNER
EOF

cat > "$TIMER" <<EOF
[Unit]
Description=Run the RecruitersOS engine-health check hourly

[Timer]
# Randomized delay so this never lands exactly on a deploy tick.
OnBootSec=10min
OnUnitActiveSec=1h
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-engine-health.timer
echo "installed. next run:"
systemctl list-timers recruiteros-engine-health.timer --no-pager | head -3
echo
echo "run it once now with:  systemctl start recruiteros-engine-health.service && journalctl -u recruiteros-engine-health -n 30 --no-pager"
