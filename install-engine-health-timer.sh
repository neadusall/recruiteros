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

# Self-recovery layer, shared by every tick unit on the box: when a oneshot tick
# fails, systemd's OnFailure= starts this template, which waits out the transient
# (deploy swap, docker hiccup) and re-runs the tick. Capped at 2 recoveries per
# 6h window so real breakage still ends in a FAILED unit the sentinel emails
# about. The recovered unit clears its own counter on success (ExecStartPost).
cat > /usr/local/bin/recruiteros-tick-recover.sh <<'EOF'
#!/usr/bin/env bash
# tick-recover-v1  (invoked via OnFailure=recruiteros-tick-recover@%n.service)
set -uo pipefail
UNIT="$1"
SAFE=$(printf "%s" "$UNIT" | tr -c "A-Za-z0-9._-" "_")
COUNT_FILE="/run/tick-recover-${SAFE}.count"
NOW=$(date -u +%s)
N=0; TS=$NOW
if [ -f "$COUNT_FILE" ]; then
  read -r N TS < "$COUNT_FILE" || { N=0; TS=$NOW; }
  case "$N$TS" in *[!0-9]*) N=0; TS=$NOW;; esac
  [ $((NOW - TS)) -gt 21600 ] && { N=0; TS=$NOW; }
fi
if [ "$N" -ge 2 ]; then
  echo "tick-recover: $UNIT failed again after $N recoveries in this 6h window; staying failed so the sentinel goes loud"
  exit 0
fi
echo "$((N + 1)) $TS" > "$COUNT_FILE"
echo "tick-recover: $UNIT failed; re-running it in 120s (attempt $((N + 1))/2 this window)"
sleep 120
exec systemctl start "$UNIT"
EOF
chmod +x /usr/local/bin/recruiteros-tick-recover.sh

cat > /etc/systemd/system/recruiteros-tick-recover@.service <<'EOF'
[Unit]
Description=Self-recovery for %i after a failed run

[Service]
Type=oneshot
ExecStart=/usr/local/bin/recruiteros-tick-recover.sh %i
EOF

cat > "$RUNNER" <<'EOF'
#!/usr/bin/env bash
# engine-health-runner-v3
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

# DEPLOY-SWAP GATE. auto-deploy.sh holds /var/lock/recruiteros-app-swap.lock
# exclusively around every app-container recreate; ticks hold it SHARED so a
# swap can never SIGKILL a docker exec in flight (the 2026-08-05 sending-health
# 137). Fail open after 15 min WITH a log line; the retries below still cover.
exec 8>/var/lock/recruiteros-app-swap.lock
flock -s -w 900 8 || echo "swap-gate: exclusive holder still there after 15 min; proceeding on retries" >&2

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
OnFailure=recruiteros-tick-recover@%n.service

[Service]
Type=oneshot
ExecStart=$RUNNER
ExecStartPost=-/bin/rm -f /run/tick-recover-%n.count
# Must comfortably exceed the swap-gate wait (900s) plus the retry ladder,
# or systemd itself would SIGKILL a tick that is politely waiting out a deploy.
TimeoutStartSec=1800
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
