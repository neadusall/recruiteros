#!/usr/bin/env bash
#
# JD Sourcing overnight-queue watchdog (standalone layer, installed 2026-07-20).
#
# WHY THIS EXISTS: the overnight queue is driven by recruiteros-nightqueue.timer
# hitting /api/sourcing/night every 45s. Container-level guards (autoheal, the
# deploy watcher's converge, ostext-watchdog) only see a DEAD or UNHEALTHY app.
# The queue can also stall with the app perfectly healthy: an in-process wedge
# (a vendor call that never resolves) makes every tick a silent no-op while
# queued searches sit untouched all night. The queue snapshot on the app volume
# records per-item updatedAt on every real step, so "active items exist but
# nothing has progressed in 45 minutes" is a truthful stall signal readable from
# the HOST even when the container is gone. This copy lives at /usr/local/bin,
# outside the git checkout, on its own systemd timer: no push can take it down.
#
# Behavior:
#   Layer A (liveness): if the app compose service has no running container,
#     clear stuck "Created" duplicates and revive from the EXISTING image.
#   Layer B (progress): if active queue items exist and the newest active
#     updatedAt is older than 45 min, restart the app container (the snapshot is
#     durable; a fresh process re-polls and resumes the chain). Skipped while
#     the container is younger than 45 min, which also rate-limits restarts.
# Skips entirely while a deploy is actively running so it never fights compose.
set -u

DIR=/opt/recruiteros
LOG=/var/log/nightqueue-watchdog.log
SNAP=/var/lib/docker/volumes/recruiteros_app_data/_data/snap_sourcing_night_queue_v1.json
STALL_MIN=45
ALERT_STATE=/var/lib/nightqueue-watchdog.last-alert
ALERT_MIN_GAP_S=$((6 * 3600))
ALERT_CELL="${NIGHTQUEUE_ALERT_CELL:-+19153737987}"
cd "$DIR" || exit 0

# Text the ops cell when this watchdog has to intervene, using the OS Text
# engine's Telnyx creds and live campaign from-numbers read from the engine DB
# at send time. Two sharp edges found by live-fire testing: the messaging
# profile has NO number pool (profile-only sends are rejected, Telnyx 40321),
# and a STOP reply blocks a specific from->to PAIR (40300), so we rotate
# through every distinct from-number until one delivers. Rate-limited to one
# text per 6h so a flapping box cannot spam a phone; every intervention still
# lands in $LOG regardless. Send failure never blocks heals.
alert() {
  local now last from ok
  now=$(date -u +%s)
  last=$(cat "$ALERT_STATE" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$ALERT_MIN_GAP_S" ] && return 0
  echo "$now" > "$ALERT_STATE"
  ok=0
  for from in $(docker exec recruiteros-db-1 psql -U recruiteros -d taltxt -t -A -c \
    "SELECT DISTINCT from_number FROM campaigns WHERE from_number IS NOT NULL AND from_number <> '' LIMIT 8" 2>/dev/null); do
    if docker exec -e MSG="$1" -e TO="$ALERT_CELL" -e FROM="$from" recruiteros-taltxt-1 node -e '
      fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + process.env.TELNYX_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ to: process.env.TO, from: process.env.FROM, text: process.env.MSG, messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID }),
      }).then(r => r.json()).then(d => {
        if (d.data && d.data.id) { console.log("alert sms sent from " + process.env.FROM + ": " + d.data.id); process.exit(0); }
        console.log("alert sms from " + process.env.FROM + " refused: " + JSON.stringify(d).slice(0, 200)); process.exit(1);
      }).catch(e => { console.log("alert sms failed: " + e.message); process.exit(1); });
    ' >> "$LOG" 2>&1; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || echo "$(date -u) alert could not be delivered from any engine number (see lines above)" >> "$LOG"
}

# Never act mid-deploy (same two guards as ostext-watchdog: shared deploy lock
# taken non-blocking + the deploy unit's state).
exec 9>/var/lock/recruiteros-deploy.lock
flock -n 9 || exit 0
DEPLOY_STATE=$(systemctl is-active recruiteros-deploy.service 2>/dev/null || true)
case "$DEPLOY_STATE" in active|activating|deactivating) exit 0;; esac

# ---- Layer A: the app service must have a running container ------------------
RUNNING=$(docker ps -q --filter "name=recruiteros-app-1" --filter status=running)
if [ -z "$RUNNING" ]; then
  echo "$(date -u) app container not running: reviving..." >> "$LOG"
  docker ps -aq --filter "name=recruiteros-app-1" --filter status=created | xargs -r docker rm -f >> "$LOG" 2>&1
  docker compose up -d --no-build --no-deps app >> "$LOG" 2>&1
  alert "RecruitersOS: the main app was down and has been restarted automatically. Overnight sourcing resumes on its own; if JD Sourcing still looks stuck in an hour, reply here or check the server."
  exit 0
fi

# ---- Layer B: active queue items must be making progress ---------------------
[ -r "$SNAP" ] || exit 0

STALL_STATE=$(python3 - "$SNAP" "$STALL_MIN" <<'PY'
import json, sys, datetime
try:
    items = json.load(open(sys.argv[1]))
except Exception:
    print("unreadable"); sys.exit()
active = [i for i in items if i.get("stage") not in ("done", "error")]
if not active:
    print("idle"); sys.exit()
newest = max(i.get("updatedAt") or i.get("createdAt") or "1970-01-01T00:00:00Z" for i in active)
try:
    ts = datetime.datetime.fromisoformat(newest.replace("Z", "+00:00"))
except ValueError:
    print("unreadable"); sys.exit()
age_min = (datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds() / 60
print(f"stalled {age_min:.0f}" if age_min > float(sys.argv[2]) else "ok")
PY
)

case "$STALL_STATE" in
  stalled*) ;;
  *) exit 0;;
esac

# Rate limit: only restart a container that has been up longer than the stall
# window (a fresh container deserves time to resume the chain on its own).
STARTED=$(docker inspect -f '{{.State.StartedAt}}' recruiteros-app-1 2>/dev/null || echo "")
if [ -n "$STARTED" ]; then
  UP_MIN=$(( ( $(date -u +%s) - $(date -u -d "$STARTED" +%s) ) / 60 ))
  [ "$UP_MIN" -lt "$STALL_MIN" ] && exit 0
fi

echo "$(date -u) queue $STALL_STATE min with active items and app up ${UP_MIN:-?} min: restarting app to clear the wedge..." >> "$LOG"
docker compose restart app >> "$LOG" 2>&1
echo "$(date -u) app restarted; next nightqueue tick resumes from the snapshot" >> "$LOG"
alert "RecruitersOS: overnight sourcing stalled mid-run and was restarted automatically. Queued searches resume where they left off. If the queue card still shows no progress in an hour, something deeper needs a look."
