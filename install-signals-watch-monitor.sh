#!/usr/bin/env bash
#
# ONE-TIME install: a watchdog for the Signal Watchlist poller.
#
# The poller stamps a heartbeat every tick (lastTickAt / consecutiveErrors), exposed at
# GET /api/signals/watch?status=1. This watchdog reads it every 15 min and complains to the system
# journal when the tick has gone SILENT (timer dead / app down) or is FAILING (feed or enrichment
# outage), so a broken pipeline surfaces instead of quietly doing nothing.
#
# Run once on the app server as root, AFTER install-signals-watch-timer.sh (it reuses that env file):
#
#   bash /opt/recruiteros/install-signals-watch-monitor.sh
#
# Tuning (optional): STALE_MIN (default 45) minutes without a tick before alerting.
#
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ENVFILE=/etc/recruiteros-signals-watch.env
STALE_MIN="${STALE_MIN:-45}"

if [ ! -f "$ENVFILE" ]; then
  echo "ERROR: $ENVFILE not found. Run install-signals-watch-timer.sh first." >&2
  exit 1
fi

# The check script: pull ?status=1, evaluate the heartbeat, log a warning to the journal on trouble.
install -d /opt/recruiteros/bin
cat > /opt/recruiteros/bin/signals-watch-check.sh <<'CHECK'
#!/usr/bin/env bash
set -euo pipefail
source /etc/recruiteros-signals-watch.env
STALE_MIN="${STALE_MIN:-45}"
TAG="signals-watch-monitor"

body="$(curl -fsS -m 20 -H "x-cron-secret: ${RECRUITEROS_CRON_SECRET}" "${WATCH_URL}/api/signals/watch?status=1" 2>/dev/null || true)"
if [ -z "$body" ]; then
  logger -t "$TAG" -p user.err "UNREACHABLE: ${WATCH_URL}/api/signals/watch?status=1 returned nothing (app down or secret wrong)"
  exit 0
fi

# Parse + judge with node (present in the app image); never let a parse error kill the timer.
echo "$body" | STALE_MIN="$STALE_MIN" node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    let j; try{ j=JSON.parse(d); }catch{ console.log("PARSE_FAIL"); process.exit(0); }
    const h=j.health||{}, staleMin=Number(process.env.STALE_MIN)||45;
    const active=j.activeWatchlists||0;
    const budget=(j.budget&&j.budget.remaining);
    const out=[];
    if(active>0){
      if(!h.lastTickAt){ out.push("NO_TICK_YET (active lists but the poller has never ticked)"); }
      else {
        const ageMin=(Date.now()-new Date(h.lastTickAt).getTime())/60000;
        if(ageMin>staleMin) out.push("STALE: last tick "+Math.round(ageMin)+"m ago (>"+staleMin+"m) - timer dead or app down");
      }
    }
    if((h.consecutiveErrors||0)>=3) out.push("FAILING: "+h.consecutiveErrors+" ticks in a row errored ("+(h.lastError||"")+")");
    if(budget===0) out.push("BUDGET_EXHAUSTED: no feed pulls left today (raise SIGNALS_WATCH_DAILY_FETCH_CAP or lower cadence)");
    console.log(out.length? "ALERT "+out.join(" | ") : "OK active="+active+" lastTick="+(h.lastTickAt||"never")+" errs="+(h.consecutiveErrors||0)+" budgetLeft="+budget);
  });
' | while IFS= read -r line; do
  case "$line" in
    ALERT*) logger -t "$TAG" -p user.warning "$line" ;;
    *)      logger -t "$TAG" -p user.info "$line" ;;
  esac
done
CHECK
chmod +x /opt/recruiteros/bin/signals-watch-check.sh

cat > /etc/systemd/system/recruiteros-signals-watch-monitor.service <<EOF
[Unit]
Description=RecruitersOS Signal Watchlist watchdog (heartbeat + error check)
After=network-online.target

[Service]
Type=oneshot
Environment=STALE_MIN=$STALE_MIN
ExecStart=/usr/bin/env bash /opt/recruiteros/bin/signals-watch-check.sh
EOF

cat > /etc/systemd/system/recruiteros-signals-watch-monitor.timer <<EOF
[Unit]
Description=Run the Signal Watchlist watchdog every 15 min

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
AccuracySec=1min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-signals-watch-monitor.timer

echo "Installed. Watchdog checks the poller heartbeat every 15 min (stale threshold ${STALE_MIN}m)."
echo
echo "  See its verdicts:  journalctl -t signals-watch-monitor -n 20 --no-pager"
echo "  Run a check now:   systemctl start recruiteros-signals-watch-monitor.service"
echo "  Turn it off:       systemctl disable --now recruiteros-signals-watch-monitor.timer"