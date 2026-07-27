#!/usr/bin/env bash
#
# OS Text never-down watchdog (standalone layer; v1 2026-07-20, v2 2026-07-27).
#
# WHY THIS EXISTS: on 2026-07-20 a deploy was killed mid-recreate and left the
# OS Text engine (the `taltxt` compose service) as a stopped "Created" duplicate
# with no running container. Autoheal could not see it (it only restarts
# running-but-unhealthy containers) and the deploy watcher early-exited with no
# new commit, so OS Text stayed dark until the next push. The deploy watcher now
# carries its own in-script fail-safe, but if a future commit ever breaks that
# script the fail-safe dies with it. THIS copy lives at /usr/local/bin, outside
# the git checkout, on its own systemd timer (every 3 min): no push can take it
# down.
#
# v2 (2026-07-27 outage): the engine can be "up" yet serving the WRONG BUILD.
# The money-maker-sms submodule checkout silently froze 43 commits behind (a
# dirty tracked file made every `git submodule update` fail), so the image was
# built without the /ostext-app basePath while Caddy served the new same-origin
# scheme: every request 307-looped to /login and v1's probe counted that 307 as
# alive, so NOTHING recovered it. v2 probes the engine's own health contract
# (/ostext-app/api/health must answer 200; only the right build can) and knows
# two distinct failure modes:
#   DOWN          -> revive ladder (clear Created dupes, up from existing image,
#                    then engine restart + caddy force-recreate). Old version up
#                    always beats down.
#   WRONG-SERVING -> converge the submodule to the superproject's recorded
#                    commit (stashing any stray dirt so it stays recoverable),
#                    rebuild the engine, re-check. Cooldown-guarded so a build
#                    that cannot be fixed does not rebuild-flap the box.
# Either action texts the owner cell (fail-open, 60-min cooldown): self-healing
# should be silent only when nothing had to happen.
set -u

DIR=/opt/recruiteros
LOG=/var/log/ostext-watchdog.log
ENV_FILE="$DIR/money-maker-sms/.env.production"
cd "$DIR" || exit 0

# Never act mid-deploy: a recreate in progress looks "down" for a few seconds.
# Two guards, both cheap:
# 1. The shared deploy lock (auto-deploy.sh holds it for its whole run, however
#    it was invoked: systemd tick or a manual run). Taking it non-blocking means
#    we skip while a deploy runs, and holding it for the rest of THIS script
#    means a deploy starting mid-recovery waits for us instead of racing compose.
# 2. The systemd unit state, as a belt-and-suspenders check. NOT pgrep: any
#    stray shell that merely mentions the script name in its command line would
#    fool a pgrep match forever and neuter this watchdog.
exec 9>/var/lock/recruiteros-deploy.lock
flock -n 9 || exit 0
DEPLOY_STATE=$(systemctl is-active recruiteros-deploy.service 2>/dev/null || true)
case "$DEPLOY_STATE" in active|activating|deactivating) exit 0;; esac

log() { echo "$(date -u) $*" >> "$LOG"; }

# Ops SMS to the owner cell when the watchdog had to act. Fail-open: alerting
# must never block or break recovery. 60-min cooldown so a bad night sends one
# text, not twenty. Recipient = OSTEXT_ALERT_ALWAYS_CELL (engine env; "off"
# disables), defaulting to the owner cell the reply-alert system uses.
sms_alert() {
  local MSG="$1" STAMP=/var/tmp/ostext-watchdog-sms.stamp KEY FROM TO
  if [ -n "$(find "$STAMP" -mmin -60 2>/dev/null)" ]; then return 0; fi
  KEY=$(grep -E '^TELNYX_API_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  FROM=$(grep -E '^TELNYX_FROM_NUMBER=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  TO=$(grep -E '^OSTEXT_ALERT_ALWAYS_CELL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  TO=${TO:-+19153737987}
  if [ "$TO" = "off" ] || [ -z "$KEY" ] || [ -z "$FROM" ]; then return 0; fi
  if curl -s -m 10 -X POST https://api.telnyx.com/v2/messages \
       -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
       -d "{\"from\":\"$FROM\",\"to\":\"$TO\",\"text\":\"$MSG\"}" >/dev/null 2>&1; then
    touch "$STAMP"
  fi
}

# Deep probe: the engine's own health contract. ONLY the correct build serving
# through the current Caddy answers 200 here; a stale no-basePath build 404s or
# 307-loops, a dead engine 502s or times out. This is the line between healthy,
# WRONG-SERVING, and DOWN.
deep_probe() {
  curl -s -o /dev/null -w '%{http_code}' -m 10 -k \
    --resolve recruitersos.co:443:127.0.0.1 https://recruitersos.co/ostext-app/api/health || echo 000
}

# Shallow probe: any app-level answer at all on the serving path. Distinguishes
# "something is serving, just the wrong thing" from "nothing is serving".
shallow_probe() {
  curl -s -o /dev/null -w '%{http_code}' -m 10 -k \
    --resolve recruitersos.co:443:127.0.0.1 https://recruitersos.co/ostext-app/ || echo 000
}

shallow_alive() { case "$1" in 2*|3*|401|403) return 0;; *) return 1;; esac; }

DEEP=$(deep_probe)
[ "$DEEP" = "200" ] && exit 0

SHALLOW=$(shallow_probe)

if shallow_alive "$SHALLOW"; then
  # WRONG-SERVING: the box answers but not with the right build's health 200.
  # Root cause on 2026-07-27: submodule checkout drifted from the superproject
  # pointer, image built from stale code. Converge + rebuild, cooldown-guarded.
  STAMP="$DIR/.ostext-wrongbuild-fix"
  if [ -n "$(find "$STAMP" -mmin -30 2>/dev/null)" ]; then
    log "wrong-serving (health=$DEEP shallow=$SHALLOW) but rebuild cooldown active, waiting"
    exit 0
  fi
  touch "$STAMP"
  log "WRONG-SERVING: health=$DEEP shallow=$SHALLOW, converging submodule + rebuilding engine..."
  WANT=$(git ls-tree HEAD money-maker-sms 2>/dev/null | awk '{print $3}')
  HAVE=$(git -C money-maker-sms rev-parse HEAD 2>/dev/null || echo none)
  if [ -n "$WANT" ] && [ "$WANT" != "$HAVE" ]; then
    log "submodule drift: checkout $HAVE, superproject wants $WANT (stashing dirt, forcing sync)"
    git -C money-maker-sms stash push --include-untracked -m "watchdog-converge $(date -u +%Y%m%dT%H%M%S)" >> "$LOG" 2>&1 || true
    git submodule sync -- money-maker-sms >> "$LOG" 2>&1 || true
    git submodule update --init --force money-maker-sms >> "$LOG" 2>&1 || log "submodule update FAILED"
  fi
  if docker compose build taltxt >> "$LOG" 2>&1 && docker compose up -d --no-deps taltxt >> "$LOG" 2>&1; then
    sleep 20
    DEEP=$(deep_probe)
    if [ "$DEEP" = "200" ]; then
      log "recovered (health=200) after converge + rebuild"
      sms_alert "OS Text watchdog: engine was serving a stale build and was auto-rebuilt. It is healthy again, no action needed."
      exit 0
    fi
    # Right build, still not 200 through the edge: the Caddyfile single-file
    # bind mount may be stale (inode trap). Force-recreate the edge once.
    log "still wrong (health=$DEEP) after rebuild, force-recreating caddy..."
    docker compose up -d --force-recreate caddy >> "$LOG" 2>&1 || true
    sleep 15
    DEEP=$(deep_probe)
    if [ "$DEEP" = "200" ]; then
      log "recovered (health=200) after caddy recreate"
      sms_alert "OS Text watchdog: engine build and edge were auto-repaired. It is healthy again, no action needed."
    else
      log "STILL WRONG (health=$DEEP) after rebuild + caddy recreate, will retry after cooldown"
      sms_alert "OS Text watchdog: engine is serving wrong and auto-repair did not fix it. Needs attention."
    fi
  else
    log "engine rebuild FAILED, previous image keeps serving; will retry after cooldown"
    sms_alert "OS Text watchdog: engine rebuild failed, the previous version is still serving. Needs attention."
  fi
  exit 0
fi

# DOWN: nothing app-level is answering. Revive ladder, old version beats down.
log "probe=$SHALLOW (health=$DEEP), OS Text is dark: reviving..."
# Clear docker's failed-recreate artifacts (stopped "Created" duplicates).
docker ps -aq --filter "name=taltxt" --filter status=created | xargs -r docker rm -f >> "$LOG" 2>&1
docker compose up -d --no-build --no-deps taltxt >> "$LOG" 2>&1
sleep 15

SHALLOW=$(shallow_probe)
if shallow_alive "$SHALLOW"; then
  log "recovered (probe=$SHALLOW) after revive from existing image"
  sms_alert "OS Text watchdog: engine was down and was auto-revived. It is serving again, no action needed."
  exit 0
fi

log "still dark (probe=$SHALLOW): restarting engine + recreating caddy..."
docker compose restart taltxt >> "$LOG" 2>&1
docker compose up -d --force-recreate caddy >> "$LOG" 2>&1
sleep 15
SHALLOW=$(shallow_probe)
if shallow_alive "$SHALLOW"; then
  log "recovered (probe=$SHALLOW) after engine restart + caddy recreate"
  sms_alert "OS Text watchdog: engine was down and was auto-revived after a full restart. It is serving again, no action needed."
else
  log "STILL DARK (probe=$SHALLOW) after full recovery attempt, will retry next tick"
  sms_alert "OS Text watchdog: engine is down and auto-recovery failed. Needs attention now."
fi
