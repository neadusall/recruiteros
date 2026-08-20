#!/usr/bin/env bash
# Publish the outbound send schedule for the portal UI.
#
# The PiP performance header shows the operator WHEN the machine sends next and
# when it last sent, so a batch can be monitored the moment it goes out. The
# times come from systemd itself (the timers that actually fire the sends),
# never from a hardcoded copy of the schedule that could drift:
#   - mpc-monitor.timer  = the continuous drain (batch.mjs + followup.mjs each
#     tick, to the daily cap). OnUnitActiveSec timers report no NextElapse while
#     their service is running, so the next tick is last-trigger + the cadence.
#   - mpc-daily.timer    = the once-a-day supply run (search seeding + full send).
#
# Runs on the HOST (it needs systemctl) at the end of every mpc-monitor tick,
# so the snapshot is at most one tick stale. This file IS the deployed copy:
# /opt/recruiteros/tools/ is what systemd runs, and a git pull updates it in
# place. There is no second copy to keep in sync -- that arrangement is what
# silently unshipped the Dashboard motion split on 2026-08-18.
#
# Output: /data snapshot `mpc_schedule_v1`, read by GET /api/in-market/track
# (the `sending` block). The app only ever READS this key, so a host write
# cannot be clobbered by the running app.
set -euo pipefail

SNAP=/var/lib/docker/volumes/recruiteros_app_data/_data/snap_mpc_schedule_v1.json
DRAIN_MIN="${MPC_DRAIN_EVERY_MIN:-20}"

iso() {
  local v="${1:-}"
  case "$v" in ""|n/a|infinity) echo ""; return;; esac
  date -u -d "$v" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo ""
}

prop() { systemctl show "$1" --property="$2" --value 2>/dev/null || true; }

LAST_DRAIN="$(iso "$(prop mpc-monitor.timer LastTriggerUSec)")"
NEXT_DRAIN="$(iso "$(prop mpc-monitor.timer NextElapseUSecRealtime)")"
if [ -z "$NEXT_DRAIN" ] && [ -n "$LAST_DRAIN" ]; then
  NEXT_DRAIN="$(date -u -d "$LAST_DRAIN + $DRAIN_MIN minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")"
fi
NEXT_DAILY="$(iso "$(prop mpc-daily.timer NextElapseUSecRealtime)")"
LAST_DAILY="$(iso "$(prop mpc-daily.timer LastTriggerUSec)")"

cat > "${SNAP}.tmp" <<JSON
{
  "nextDrainAt": "${NEXT_DRAIN}",
  "lastDrainAt": "${LAST_DRAIN}",
  "drainEveryMin": ${DRAIN_MIN},
  "nextDailyAt": "${NEXT_DAILY}",
  "lastDailyAt": "${LAST_DAILY}",
  "dailyCap": ${MPC_DAILY_CAP:-1500},
  "perRun": ${MPC_SEND_PER_RUN:-150},
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
mv "${SNAP}.tmp" "$SNAP"
