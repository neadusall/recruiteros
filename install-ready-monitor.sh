#!/usr/bin/env bash
# install-ready-monitor.sh — teach ros-sentinel to watch tool readiness.
#
# The monitoring half of the readiness safeguard. The app now knows, per
# account, which tools cannot work because a connection is missing
# (/api/ready/audit). This adds that question to the 5-minute watchdog, so the
# answer reaches the owner by email instead of waiting for a recruiter to
# notice their search came back empty.
#
# Idempotent: re-running replaces the block rather than stacking copies.
# Run on the ros box as root:  bash install-ready-monitor.sh
set -euo pipefail

SENTINEL=/usr/local/bin/ros-sentinel.sh
BACKUP=/var/lib/ros-sentinel/backup
ENVFILE=/opt/recruiteros/.env.production
[ -f "$SENTINEL" ] || { echo "no $SENTINEL — is this the ros box?"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required to patch the sentinel"; exit 1; }

SECRET=$(grep -m1 '^RECRUITEROS_CRON_SECRET=' "$ENVFILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -n "$SECRET" ] || { echo "RECRUITEROS_CRON_SECRET is not set in $ENVFILE"; exit 1; }

# The endpoint has to exist before we start watching it, or the first tick
# alerts on our own not-yet-deployed code.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -k --resolve recruitersos.co:443:127.0.0.1 \
  "https://recruitersos.co/api/ready/audit?secret=$SECRET" || echo 000)
if [ "$CODE" != "200" ]; then
  echo "readiness audit answered $CODE, not 200 — deploy the app first, then re-run this."
  exit 1
fi

cp -a "$SENTINEL" "$SENTINEL.bak.$(date -u +%Y%m%d%H%M%S)"

python3 - "$SENTINEL" <<'PY'
import re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

BLOCK = r'''
# 12. Tool readiness: any account with a tool that CANNOT work because its
#     connection is missing. This is the quiet failure mode — no error, no
#     crash, just a search that returns nobody — so the watchdog is what
#     notices it.  [ready-monitor]
READY_SECRET="$(envval RECRUITEROS_CRON_SECRET)"
if [ -n "$READY_SECRET" ]; then
  READY_JSON=$(curl -s -m 20 -k --resolve recruitersos.co:443:127.0.0.1 \
    "https://recruitersos.co/api/ready/audit?secret=$READY_SECRET" || true)
  if ! printf '%s' "$READY_JSON" | jq -e '.blocked' >/dev/null 2>&1; then
    fail "READY-AUDIT-UNREACHABLE" "the tool-readiness audit did not answer (portal up but /api/ready/audit returned nothing usable)"
  else
    READY_N=$(printf '%s' "$READY_JSON" | jq -r '.blocked | length')
    if [ "${READY_N:-0}" -gt 0 ]; then
      READY_LIST=$(printf '%s' "$READY_JSON" | jq -r '[.blocked[] | "\(.workspaceName): \(.toolLabel) needs \(.missing | join(" + "))"] | unique | join("; ")')
      fail "TOOL-NOT-CONNECTED" "$READY_N tool/account combination(s) cannot work: $READY_LIST"
    fi
  fi
fi

'''

EXPLAIN = '''    TOOL-NOT-CONNECTED) NAME="Tool with a missing connection"; SEV="WARNING"
      MEANING="A tool is switched on for an account, but the account it runs through was never connected (or its key was removed)."
      IMPACT="That tool cannot do its work. It does not error - a search finds nobody, a campaign sends nothing - so the person using it believes there was nothing to find and tries again. The detail line says which account and which connection.";;
    READY-AUDIT-UNREACHABLE) NAME="Tool readiness monitoring"; SEV="WARNING"
      MEANING="The portal is up but the readiness audit did not answer, so nothing is currently checking whether tools have what they need."
      IMPACT="Tools could be silently unable to work and nobody would be told. The platform itself is fine.";;
'''

MARK = "# ---- notify on change ----"

# Remove any previous install (block + its explain entries) so this is a replace.
src = re.sub(r"\n# 12\. Tool readiness:.*?\n(?=" + re.escape(MARK) + ")", "\n", src, flags=re.S)
src = re.sub(r"    TOOL-NOT-CONNECTED\).*?;;\n", "", src, flags=re.S)
src = re.sub(r"    READY-AUDIT-UNREACHABLE\).*?;;\n", "", src, flags=re.S)

if MARK not in src:
    sys.exit("sentinel layout changed: no notify-on-change marker")
src = src.replace(MARK, BLOCK.lstrip("\n") + MARK, 1)

marker = '  case "$code" in\n'
i = src.find("explain() {")
j = src.find(marker, i)
if i < 0 or j < 0:
    sys.exit("sentinel layout changed: no explain() case block")
src = src[: j + len(marker)] + EXPLAIN + src[j + len(marker) :]

open(path, "w", encoding="utf-8", newline="\n").write(src)
print("patched")
PY

if ! bash -n "$SENTINEL"; then
  echo "syntax check failed — restoring the backup"
  cp -a "$(ls -t "$SENTINEL".bak.* | head -1)" "$SENTINEL"
  exit 1
fi

# The converge guardian restores from this copy every 10 minutes, so leaving it
# stale would silently resurrect the old sentinel.
mkdir -p "$BACKUP"
cp -a "$SENTINEL" "$BACKUP/ros-sentinel.sh"

echo "--- dry run (no mail, no state change) ---"
ROS_SENTINEL_DRYRUN=1 ROS_SENTINEL_STATE=/tmp/ready-mon ROS_SENTINEL_LOG=/tmp/ready-mon.log "$SENTINEL" 2>&1 | head -45 || true
echo
echo "installed. Force a real tick with: systemctl start ros-sentinel.service"
