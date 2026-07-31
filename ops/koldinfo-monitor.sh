#!/usr/bin/env bash
# KoldInfo UI monitor — runs DAILY (koldinfo-monitor.timer). It logs into app.koldinfo.com
# through the laxis-worker and confirms BOTH doors the enrichment chain drives are still
# reachable: the LinkedIn-URL enrichment page (kind "koldinfo") AND the People DB + Business
# Email DB filter pages the name/city/state lookup depends on (kind "koldinfo-db"). If either
# breaks — KoldInfo redesigned a page, moved a route, renamed a column — the check fails and
# this alerts SAME-DAY (syslog + optional webhook) instead of the breakage being discovered
# when a real enrichment run silently returns nothing.
#
# Recovery ladder (low-risk, automatic):
#   1) selftest both flows.
#   2) if a flow fails AND no job is running, restart the worker once (fixes the common case:
#      an expired KoldInfo login/session cookie) and re-test.
#   3) if still failing, log CRITICAL — that is a structural UI change needing a code
#      recalibration of koldinfo-db-flow.js / koldinfo-flow.js (recon scripts + the runbook
#      docs/runbooks/koldinfo-enrichment.md show how). Never edits code on its own.
#
# Dependency-free (docker + logger + optional curl). Read-only except the single worker
# restart in step 2. Config via env (set in the systemd unit): ALERT_WEBHOOK_URL.
set -u

WORKER="${KOLDINFO_WORKER_CONTAINER:-recruiteros-laxis-worker-1}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
TAG="koldinfo-monitor"

log()  { logger -t "$TAG" "$1"; echo "$(date -u +%FT%TZ) $1"; }
alert() {
  log "ALERT: $1"
  [ -n "$ALERT_WEBHOOK_URL" ] && curl -s -m 8 -H 'content-type: application/json' \
    -d "{\"text\":\"[koldinfo-monitor] $1\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1
}

# Run one flow's selftest inside the worker; prints "ok" or "FAIL:<reason>".
selftest() {
  local kind="$1"
  local mod
  case "$kind" in
    koldinfo)     mod="/app/koldinfo-flow.js" ;;
    koldinfo-db)  mod="/app/koldinfo-db-flow.js" ;;
    *) echo "FAIL:unknown_kind"; return ;;
  esac
  local out
  out=$(docker exec "$WORKER" node -e "
    require('$mod').selfTest({log:()=>{}})
      .then(r => { console.log(r && r.ok ? 'ok' : ('FAIL:'+((r&&r.detail)||'not_reachable'))); })
      .catch(e => { console.log('FAIL:'+(e && e.message ? e.message.slice(0,120) : 'error')); });
  " 2>/dev/null | tail -1)
  [ -z "$out" ] && out="FAIL:no_output"
  echo "$out"
}

job_running() {
  docker exec "$WORKER" sh -c 'wget -qO- http://localhost:3000/health 2>/dev/null' 2>/dev/null | grep -q '"running":true'
}

check_all() {
  local a b
  a=$(selftest koldinfo)
  b=$(selftest koldinfo-db)
  log "enrichment-page=$a  db-lookup=$b"
  [ "$a" = "ok" ] && [ "$b" = "ok" ]
}

# ---- run ----
if check_all; then
  log "ok: both KoldInfo doors reachable"
  exit 0
fi

# A flow failed. Try the cheap recovery (worker restart → fresh login) unless a job is live.
if job_running; then
  alert "a KoldInfo door failed but a job is running; skipping restart, will re-check next run"
  exit 1
fi

alert "a KoldInfo door failed selftest; restarting the worker to refresh the login, then re-checking"
docker restart "$WORKER" >/dev/null 2>&1
sleep 20

if check_all; then
  log "recovered after worker restart (was a stale login/session)"
  exit 0
fi

alert "CRITICAL: a KoldInfo door is STILL failing after a restart — likely a KoldInfo UI/route/column change. Recalibrate koldinfo-db-flow.js / koldinfo-flow.js (see docs/runbooks/koldinfo-enrichment.md; recon scripts fingerprint the new UI). The name/city/state enrichment rung is DOWN until fixed."
exit 2
