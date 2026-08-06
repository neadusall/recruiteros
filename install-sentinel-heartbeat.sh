#!/usr/bin/env bash
# install-sentinel-heartbeat.sh — make "did the watchdog actually run?" answerable.
#
# Why this exists: ros-sentinel skips its whole run while a deploy holds the
# shared lock, which is correct (half-recreated containers look broken). But the
# skip is silent and leaves no trace, so a stretch of skipped ticks is
# indistinguishable from a watchdog that has quietly stopped working. Working
# that out on 2026-08-06 took a systemd trace on a live box.
#
# Two changes, both small:
#   1. Every exit path stamps /var/lib/ros-sentinel/lastrun.{epoch,reason}, so
#      the last tick and WHY it ended are readable at a glance.
#   2. The lock is waited on for 90s instead of skipped instantly, so a routine
#      2-second deploy poll delays a tick rather than dropping it. A real build
#      still holds it longer and still skips, as intended.
#
# Idempotent. Run on the ros box as root:  bash install-sentinel-heartbeat.sh
set -euo pipefail

SENTINEL=/usr/local/bin/ros-sentinel.sh
BACKUP=/var/lib/ros-sentinel/backup
[ -f "$SENTINEL" ] || { echo "no $SENTINEL — is this the ros box?"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required to patch the sentinel"; exit 1; }

cp -a "$SENTINEL" "$SENTINEL.bak.$(date -u +%Y%m%d%H%M%S)"

python3 - "$SENTINEL" <<'PY'
import re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

if "[heartbeat]" in src:
    # Strip the previous install so this is a replace, not a stack.
    src = re.sub(r"\n# \[heartbeat\].*?\n# \[/heartbeat\]\n", "\n", src, flags=re.S)
    src = src.replace('  flock -w 90 9 || { stamp skipped-deploy-lock; exit 0; }',
                      '  flock -n 9 || exit 0')
    src = src.replace('    active|activating|deactivating) stamp skipped-deploying; exit 0;;',
                      '    active|activating|deactivating) exit 0;;')

HEART = '''
# [heartbeat] Every exit path leaves a mark, so a run that was skipped is never
# mistaken for a watchdog that stopped. Read with:
#   date -u -d @$(cat /var/lib/ros-sentinel/lastrun.epoch); cat /var/lib/ros-sentinel/lastrun.reason
RUN_REASON=""
stamp() {
  RUN_REASON="$1"
  date -u +%s > "$STATE/lastrun.epoch" 2>/dev/null || true
  printf '%s\\n' "$1" > "$STATE/lastrun.reason" 2>/dev/null || true
}
# The skip paths stamp their own reason first, so the trap must not overwrite it
# on the way out: an unrecorded skip is the exact blindness this closes.
trap '[ -n "$RUN_REASON" ] || stamp completed' EXIT
# [/heartbeat]
'''

# The stamp helper has to exist before the lock guard can use it, and after
# $STATE is defined.
anchor = "# Never inspect the stack mid-deploy"
if anchor not in src:
    sys.exit("sentinel layout changed: no deploy-lock comment to anchor on")
src = src.replace(anchor, HEART.lstrip("\n") + "\n" + anchor, 1)

# A routine deploy poll takes ~2s: wait for it instead of dropping the tick.
if "flock -n 9 || exit 0" not in src:
    sys.exit("sentinel layout changed: no flock guard")
src = src.replace("flock -n 9 || exit 0",
                  "flock -w 90 9 || { stamp skipped-deploy-lock; exit 0; }", 1)
src = src.replace("    active|activating|deactivating) exit 0;;",
                  "    active|activating|deactivating) stamp skipped-deploying; exit 0;;", 1)

open(path, "w", encoding="utf-8", newline="\n").write(src)
print("patched")
PY

if ! bash -n "$SENTINEL"; then
  echo "syntax check failed — restoring the backup"
  cp -a "$(ls -t "$SENTINEL".bak.* | head -1)" "$SENTINEL"
  exit 1
fi

# The converge guardian restores from this copy every 10 minutes.
mkdir -p "$BACKUP"
cp -a "$SENTINEL" "$BACKUP/ros-sentinel.sh"

# TimeoutStartSec must exceed the new lock wait plus a full run.
if ! grep -q "TimeoutStartSec=450" /etc/systemd/system/ros-sentinel.service; then
  sed -i 's/^TimeoutStartSec=.*/TimeoutStartSec=450/' /etc/systemd/system/ros-sentinel.service
  systemctl daemon-reload
fi

echo "--- proving it stamps ---"
systemctl start ros-sentinel.service
sleep 1
echo "last run: $(date -u -d @"$(cat /var/lib/ros-sentinel/lastrun.epoch)") · $(cat /var/lib/ros-sentinel/lastrun.reason)"
