#!/usr/bin/env bash
#
# Regression suite for the deploy gate in auto-deploy.sh (2026-07-31).
# Run: bash scripts/test-deploy-hold.sh     (from integration/)
#
# The gate holds a container swap while a candidate search is running, because a
# search is the one job a recreate destroys outright (enrichment resumes; a search
# killed halfway has to be paid for again). It must also NEVER be able to block a
# deploy: every unclear answer fails open, and the wait is bounded.
#
# The block under test is lifted verbatim out of auto-deploy.sh between its
# `>>> deploy-hold` / `<<< deploy-hold` markers and run against a stub docker, so
# this pins the real shipped code rather than a copy of it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SH="$HERE/../../auto-deploy.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failed=0
check() { # name, condition-result
  if [ "$2" = "0" ]; then echo "ok  $1"; else echo "FAIL $1"; failed=$((failed + 1)); fi
}

sed -n '/# >>> deploy-hold/,/# <<< deploy-hold/p' "$DEPLOY_SH" > "$WORK/hold.sh"
[ -s "$WORK/hold.sh" ] && check "the gate block is still marked in auto-deploy.sh" 0 \
  || { echo "FAIL the gate block is still marked in auto-deploy.sh"; exit 1; }

# A stub docker that answers with the contents of $WORK/answers, one line per call,
# repeating the last line forever. An empty line means "no readable answer".
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
CALLS="$WORK/calls"
echo x >> "$CALLS"
n=$(wc -l < "$CALLS" | tr -d ' ')
total=$(wc -l < "$WORK/answers" | tr -d ' ')
[ "$n" -gt "$total" ] && n="$total"
sed -n "${n}p" "$WORK/answers"
STUB
chmod +x "$WORK/bin/docker"

run_gate() { # answers..., writes log to $WORK/log, echoes elapsed seconds
  : > "$WORK/calls"
  printf '%s\n' "$@" > "$WORK/answers"
  : > "$WORK/log"
  local start=$SECONDS
  (
    export WORK PATH="$WORK/bin:$PATH"
    export LOG="$WORK/log" DEPLOY_HOLD_MAX_SEC="${MAX:-6}" DEPLOY_HOLD_STEP_SEC=1
    # shellcheck disable=SC1091
    . "$WORK/hold.sh"
  ) >/dev/null 2>&1
  echo $((SECONDS - start))
}

# 1. A quiet box is not held at all.
took=$(run_gate '{"ok":true,"busy":false,"live":0,"queued":0}')
check "a quiet box deploys immediately" "$([ "$took" -le 1 ] && echo 0 || echo 1)"
check "and says nothing about holding" "$(grep -q "holding the container swap" "$WORK/log" && echo 1 || echo 0)"

# 2. A running search holds the swap, then releases when the search finishes.
took=$(run_gate '{"ok":true,"busy":true,"live":1,"queued":0}' \
                '{"ok":true,"busy":true,"live":1,"queued":0}' \
                '{"ok":true,"busy":false,"live":0,"queued":0}')
check "a running search holds the swap" "$(grep -q "holding the container swap" "$WORK/log" && echo 0 || echo 1)"
check "the hold actually waited" "$([ "$took" -ge 2 ] && echo 0 || echo 1)"
check "it swaps as soon as the search finishes" "$(grep -q "searches finished after" "$WORK/log" && echo 0 || echo 1)"
check "it does not claim the hold expired" "$(grep -q "hold expired" "$WORK/log" && echo 1 || echo 0)"

# 3. A search that never ends cannot block the deploy forever.
MAX=3 took=$(MAX=3 run_gate '{"ok":true,"busy":true,"live":1,"queued":0}')
check "an endless search stops holding at the bound" "$(grep -q "hold expired" "$WORK/log" && echo 0 || echo 1)"
check "and the deploy goes ahead promptly after it" "$([ "$took" -le 6 ] && echo 0 || echo 1)"

# 4. An unreadable probe (app down, secret unset, older endpoint) fails OPEN, loudly.
took=$(run_gate '')
check "an unreadable probe never blocks the deploy" "$([ "$took" -le 1 ] && echo 0 || echo 1)"
check "and it is logged rather than silently skipped" \
  "$(grep -q "no readable in-flight answer" "$WORK/log" && echo 0 || echo 1)"

# 5. A garbage answer is treated as unreadable, not as "quiet".
took=$(run_gate '<html>502 Bad Gateway</html>')
check "a non-JSON answer fails open and is logged" \
  "$(grep -q "no readable in-flight answer" "$WORK/log" && echo 0 || echo 1)"

if [ "$failed" -gt 0 ]; then echo; echo "$failed FAILED"; exit 1; fi
echo; echo "all checks passed"
