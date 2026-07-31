#!/usr/bin/env bash
# Laxis worker monitor (laxis-monitor.timer, every 6h). Companion to koldinfo-monitor.sh.
#
# Confirms the laxis-worker can still log into app.laxis.tech and locate the
# "Enrich Prospects" entry point (selfTest heals renamed labels on its own, spends no
# credit). If it fails, this alerts SAME-DAY (syslog + optional webhook) instead of the
# breakage surfacing as lists quietly stuck on the other sources: the enrichment chain
# now degrades gracefully when Laxis is down (waterfall-only batches, marked for redo),
# but a human still needs to know the rung is dark.
#
# Recovery ladder (low-risk, automatic):
#   1) selftest the laxis flow.
#   2) if it fails AND no job is running, restart the worker once (fixes a stale
#      session cookie) and re-test.
#   3) if still failing, log CRITICAL: likely a Laxis UI/flow change needing a code
#      recalibration of laxis-flow.js (run `node probe.js` in the worker to fingerprint).
#
# Dependency-free (docker + logger + optional curl). Config via env: ALERT_WEBHOOK_URL.
set -u

WORKER="${LAXIS_WORKER_CONTAINER:-recruiteros-laxis-worker-1}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
TAG="laxis-monitor"

log()  { logger -t "$TAG" "$1"; echo "$(date -u +%FT%TZ) $1"; }
alert() {
  log "ALERT: $1"
  [ -n "$ALERT_WEBHOOK_URL" ] && curl -s -m 8 -H 'content-type: application/json' \
    -d "{\"text\":\"[laxis-monitor] $1\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1
}

selftest() {
  local out
  out=$(docker exec "$WORKER" node -e "
    require('/app/laxis-flow').selfTest({log:()=>{}})
      .then(r => { console.log(r && r.ok ? 'ok' : ('FAIL:'+(r && r.resolvedTo ? r.resolvedTo : 'entry_point_not_found'))); })
      .catch(e => { console.log('FAIL:'+(e && e.message ? e.message.slice(0,140) : 'error')); });
  " 2>/dev/null | tail -1)
  [ -z "$out" ] && out="FAIL:no_output"
  echo "$out"
}

job_running() {
  docker exec "$WORKER" sh -c 'wget -qO- http://localhost:3000/health 2>/dev/null' 2>/dev/null | grep -q '"running":true'
}

# ---- run ----
if job_running; then
  log "a job is running; skipping the selftest this pass (one browser session at a time)"
  exit 0
fi

R=$(selftest)
log "laxis selftest=$R"
if [ "$R" = "ok" ]; then
  log "ok: Laxis login + enrich entry point reachable"
  exit 0
fi

if job_running; then
  alert "Laxis selftest failed but a job just started; will re-check next run"
  exit 1
fi

alert "Laxis selftest failed ($R); restarting the worker to refresh the session, then re-checking"
docker restart "$WORKER" >/dev/null 2>&1
sleep 25

R=$(selftest)
log "laxis selftest after restart=$R"
if [ "$R" = "ok" ]; then
  log "recovered after worker restart (was a stale login/session)"
  exit 0
fi

alert "CRITICAL: Laxis is STILL failing after a restart ($R). Likely a Laxis login/UI change: run \`docker compose exec laxis-worker node probe.js\` and recalibrate laxis-flow.js. Until fixed, enrichment runs waterfall-only batches and marks them for redo (lists show 'batches to redo')."
exit 2
