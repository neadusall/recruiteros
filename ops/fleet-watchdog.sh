#!/usr/bin/env bash
# fleet-watchdog.sh — RecruitersOS scraper/worker FLEET health monitor.
#
# Polls each box's /health endpoint, classifies state, logs to journald, writes a
# status snapshot, and fires an alert ONLY on state transitions (so it's quiet when
# nothing changes). Dependency-free (curl + grep/sed). Read-only: it never touches
# the boxes, it only observes — so it's safe to run anywhere.
#
# Alert delivery (best-effort, in order; all optional):
#   - ALERT_WEBHOOK_URL  : generic JSON POST {"text": "..."} (Slack/Discord/ntfy/phone)
#   - always: journald (journalctl -u fleet-watchdog) + $STATE_DIR/status.json
set -uo pipefail

STATE_DIR=/var/lib/fleet-watchdog
mkdir -p "$STATE_DIR"
STATUS_JSON="$STATE_DIR/status.json"
PREV="$STATE_DIR/prev-state"
CUR="$STATE_DIR/cur-state"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
STUCK_SEC="${STUCK_SEC:-1200}"      # lastCycleSecAgo above this => loop hung
: > "$CUR"

# name | ip | port | health-token (blank = open)
BOXES='Scraper2|178.156.149.237|8787|
Scraper3|178.156.168.200|8787|
Scraper4|178.156.147.163|8787|
worker-2|178.156.177.220|8787|
keeper|127.0.0.1|8788|main-worker-secret'

field() { printf '%s' "$1" | grep -o "\"$2\":[ ]*[0-9]*" | grep -o '[0-9]*$' | head -1; }
strfield() { printf '%s' "$1" | grep -o "\"$2\":[ ]*\"[a-zA-Z0-9._-]*\"" | head -1 | sed -E 's/.*"([a-zA-Z0-9._-]*)"$/\1/'; }

json_boxes=""; alert_lines=""; worst=0
rank() { case "$1" in OK) echo 0;; WARN) echo 1;; UP_LOCKED) echo 1;; STUCK) echo 2;; BAD) echo 2;; DOWN) echo 3;; *) echo 1;; esac; }

while IFS='|' read -r name ip port token; do
  [ -z "$name" ] && continue
  auth=(); [ -n "$token" ] && auth=(-H "authorization: Bearer $token")
  code=$(curl -s -m 8 "${auth[@]}" -o /tmp/fw_body.$$ -w '%{http_code}' "http://$ip:$port/health" 2>/dev/null)
  body=$(cat /tmp/fw_body.$$ 2>/dev/null); rm -f /tmp/fw_body.$$

  if [ -z "$code" ] || [ "$code" = "000" ]; then
    state=DOWN; detail="unreachable (worker process not responding)"
  elif [ "$code" = "401" ]; then
    state=UP_LOCKED; detail="process up; monitor lacks this box's health token"
  else
    st=$(strfield "$body" status); cyc=$(field "$body" lastCycleSecAgo)
    nph=$(field "$body" namedPerHour); trips=$(field "$body" breakerTrips)
    case "$st" in
      healthy) state=OK;; degraded) state=WARN;; unhealthy) state=BAD;; *) state=UNKNOWN;;
    esac
    if [ -n "$cyc" ] && [ "$cyc" -gt "$STUCK_SEC" ] 2>/dev/null; then state=STUCK; fi
    detail="status=${st:-?} lastCycle=${cyc:-?}s named/h=${nph:-?} cc-breaker-trips=${trips:-?}"
  fi

  r=$(rank "$state"); [ "$r" -gt "$worst" ] && worst=$r
  echo "$name=$state" >> "$CUR"
  json_boxes="${json_boxes}{\"name\":\"$name\",\"ip\":\"$ip\",\"state\":\"$state\",\"http\":\"$code\",\"detail\":\"$detail\"},"
  logger -t fleet-watchdog "$name=$state | $detail"

  prev=$(grep -E "^$name=" "$PREV" 2>/dev/null | cut -d= -f2)
  if [ -n "$prev" ] && [ "$prev" != "$state" ]; then
    alert_lines="${alert_lines}• ${name}: ${prev} → ${state} (${detail})\n"
  fi
done <<EOF
$BOXES
EOF

online=$(grep -cvE '=(DOWN)$' "$CUR" 2>/dev/null || echo 0)
total=$(grep -c '=' "$CUR" 2>/dev/null || echo 0)
overall=OK; [ "$worst" -ge 1 ] && overall=DEGRADED; [ "$worst" -ge 2 ] && overall=UNHEALTHY; [ "$worst" -ge 3 ] && overall=CRITICAL
ts=$(date -u +%FT%TZ)

printf '{"ts":"%s","overall":"%s","online":"%s/%s","boxes":[%s]}\n' \
  "$ts" "$overall" "$online" "$total" "${json_boxes%,}" > "$STATUS_JSON"

logger -t fleet-watchdog "FLEET overall=$overall online=$online/$total"

if [ -n "$alert_lines" ]; then
  msg="RecruitersOS fleet change @ $ts (overall=$overall, $online/$total up):\n${alert_lines}"
  logger -t fleet-watchdog "ALERT: $(printf '%b' "$alert_lines" | tr '\n' ' ')"
  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    payload=$(printf '%b' "$msg" | sed ':a;N;$!ba;s/\n/\\n/g; s/"/\\"/g')
    curl -s -m 10 -X POST -H "Content-Type: application/json" \
      -d "{\"text\":\"$payload\",\"content\":\"$payload\",\"message\":\"$payload\"}" \
      "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || logger -t fleet-watchdog "ALERT webhook POST failed"
  fi
fi

cp -f "$CUR" "$PREV"
