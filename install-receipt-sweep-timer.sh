#!/usr/bin/env bash
#
# Install the nightly receipt sweep on `ros`.
#
# WHY: Spend master can only prove a month that has a receipt behind it, and the pull
# was a button someone had to remember to press. A month that nobody presses the button
# for is a month that quietly passes unaccounted for, which is the one thing the receipt
# vault exists to prevent. This runs it every night instead.
#
# Each tick does two things (POST /api/owner/receipts/cron):
#   1. Pulls the vendors that expose a real billing API. Telnyx is the only one so far,
#      and an API cannot be filtered into spam or deleted, so those months report
#      themselves even when no mail arrives. Closed months already on file are never
#      re-summed.
#   2. Re-reads the billing mailboxes over the trailing 3 months and imports anything
#      new. The sweep is READ-ONLY and de-duplicates on the message itself, so running
#      it nightly is free of consequence and self-healing when a receipt arrives late.
#
# Run once on the box:  sudo bash install-receipt-sweep-timer.sh
set -euo pipefail

UNIT=/etc/systemd/system/recruiteros-receipts.service
TIMER=/etc/systemd/system/recruiteros-receipts.timer
RUNNER=/usr/local/bin/recruiteros-receipts.sh

install -d -m 755 /var/lib/recruiteros

cat > "$RUNNER" <<'EOF'
#!/usr/bin/env bash
# receipt-sweep-runner-v2
#
# RETRIES on purpose: this box redeploys often, and the single most common reason a
# scheduled tick silently does nothing is that it fired while the app container was
# mid-restart. A missed tick here is a night of receipts not filed.
#
# The secret is read from the container's own environment and never printed. Rendering
# an image per receipt takes minutes on a full backfill, so the timeout is generous.
set -uo pipefail

# DEPLOY-SWAP GATE. auto-deploy.sh holds /var/lock/recruiteros-app-swap.lock
# exclusively around every app-container recreate; ticks hold it SHARED so a
# swap can never SIGKILL a docker exec in flight (the 2026-08-05 sending-health
# 137). Fail open after 15 min WITH a log line; the retries below still cover.
exec 8>/var/lock/recruiteros-app-swap.lock
flock -s -w 900 8 || echo "swap-gate: exclusive holder still there after 15 min; proceeding on retries" >&2

STAMP=/var/lib/recruiteros/receipts.last
ATTEMPTS=3

run_once() {
  docker exec recruiteros-app-1 node -e "
fetch('http://localhost:3000/api/owner/receipts/cron?monthsBack=3&wait=1', {
  method: 'POST',
  headers: { 'x-cron-secret': process.env.RECRUITEROS_CRON_SECRET || '' },
})
  .then(async (r) => {
    const j = await r.json().catch(() => ({}));
    const pulls = (j.pulls || []).map((p) => p.vendor + ': ' + (p.ok ? 'ok' : 'FAILED ' + (p.error || ''))).join(' | ');
    const mail = (j.reports || []).map((x) => x.mailbox + ': ' + (x.ok ? x.imported + ' imported of ' + x.scanned + ' scanned' : 'FAILED ' + (x.error || '').slice(0, 160))).join(' | ');
    console.log(r.status, 'vendor APIs [' + pulls + '] mailboxes [' + mail + ']');
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
  echo "receipt sweep attempt $i/$ATTEMPTS failed" >&2
  [ "$i" -lt "$ATTEMPTS" ] && sleep 30
done
echo "receipt sweep FAILED after $ATTEMPTS attempts - no receipt was filed tonight" >&2
exit 1
EOF
chmod +x "$RUNNER"

cat > "$UNIT" <<EOF
[Unit]
Description=RecruitersOS nightly receipt sweep (vendor billing APIs + billing mailboxes)
After=docker.service
Requires=docker.service
OnFailure=recruiteros-tick-recover@%n.service

[Service]
Type=oneshot
# Swap-gate wait (900s) + retry ladder + minutes of receipt rendering.
TimeoutStartSec=2700
ExecStart=$RUNNER
ExecStartPost=-/bin/rm -f /run/tick-recover-%n.count
EOF

cat > "$TIMER" <<EOF
[Unit]
Description=Run the RecruitersOS receipt sweep nightly

[Timer]
# Just after 05:00 UTC: vendors have finished their overnight billing runs and the box
# is quiet. Persistent so a night the box was down is caught up on the next boot.
OnCalendar=*-*-* 05:10:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-receipts.timer
echo "installed. next run:"
systemctl list-timers recruiteros-receipts.timer --no-pager | head -3
echo
echo "run it once now with:  systemctl start recruiteros-receipts.service && journalctl -u recruiteros-receipts -n 30 --no-pager"
