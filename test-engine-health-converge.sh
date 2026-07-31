#!/usr/bin/env bash
# Prove the engine-health converge decision table before it goes near prod.
# Mirrors the logic in auto-deploy.sh exactly; only the side effects are stubbed.
set -uo pipefail

TMP=$(mktemp -d)
ENGINE_STAMP="$TMP/last"
ENGINE_KICK="$TMP/kick"
ENGINE_RUNNER="$TMP/runner.sh"
ENGINE_RUNNER_VERSION="engine-health-runner-v2"

stamp_age() {
  local v; v=$(cat "$1" 2>/dev/null || echo 0)
  case "$v" in (*[!0-9]*|"") v=0 ;; esac
  echo $(( $(date -u +%s) - v ))
}

NOW=$(date -u +%s)
UNIT_OK=1   # stubs for systemctl is-enabled/is-active
decide() {
  if [ "$UNIT_OK" != "1" ] || ! grep -q "$ENGINE_RUNNER_VERSION" "$ENGINE_RUNNER" 2>/dev/null; then
    echo "REINSTALL"
  elif [ "$(stamp_age "$ENGINE_STAMP")" -gt 10800 ] && [ "$(stamp_age "$ENGINE_KICK")" -gt 3600 ]; then
    echo "KICK"
  else
    echo "NOOP"
  fi
}

pass=0; fail=0
check() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1 -> $3"; pass=$((pass+1));
  else echo "  FAIL $1 -> got $3, want $2"; fail=$((fail+1)); fi
}

echo "engine-health converge decision table:"

# 1. unit down
UNIT_OK=0; echo "$ENGINE_RUNNER_VERSION" > "$ENGINE_RUNNER"; echo "$NOW" > "$ENGINE_STAMP"
check "unit inactive" "REINSTALL" "$(decide)"

# 2. old runner (the upgrade case that would otherwise kick-storm)
UNIT_OK=1; echo "engine-health-runner-v1" > "$ENGINE_RUNNER"; rm -f "$ENGINE_STAMP"
check "outdated runner, no stamp" "REINSTALL" "$(decide)"

# 3. healthy + fresh stamp
echo "$ENGINE_RUNNER_VERSION" > "$ENGINE_RUNNER"; echo "$NOW" > "$ENGINE_STAMP"; rm -f "$ENGINE_KICK"
check "fresh stamp" "NOOP" "$(decide)"

# 4. one missed hourly run is tolerated
echo $((NOW - 7200)) > "$ENGINE_STAMP"
check "stamp 2h old (1 missed run)" "NOOP" "$(decide)"

# 5. genuinely stalled, never kicked
echo $((NOW - 14400)) > "$ENGINE_STAMP"; rm -f "$ENGINE_KICK"
check "stamp 4h old, no prior kick" "KICK" "$(decide)"

# 6. stalled but kicked recently -> rate limit holds (no credit burn)
echo $((NOW - 14400)) > "$ENGINE_STAMP"; echo $((NOW - 600)) > "$ENGINE_KICK"
check "stalled, kicked 10m ago" "NOOP" "$(decide)"

# 7. stalled, last kick over an hour ago -> allowed again
echo $((NOW - 14400)) > "$ENGINE_STAMP"; echo $((NOW - 4000)) > "$ENGINE_KICK"
check "stalled, kicked 67m ago" "KICK" "$(decide)"

# 8. corrupt stamp must not crash or silently read as "fresh"
echo "garbage" > "$ENGINE_STAMP"; rm -f "$ENGINE_KICK"
check "corrupt stamp" "KICK" "$(decide)"

rm -rf "$TMP"
echo ""
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
