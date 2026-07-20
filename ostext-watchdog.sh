#!/usr/bin/env bash
#
# OS Text never-down watchdog (standalone layer, installed 2026-07-20).
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
# Behavior: probe the real recruiter-facing path (/ostext-app/ through Caddy).
# Any app-level answer (2xx/3xx/401/403) means alive: exit silently. Otherwise
# clear stuck Created duplicates and revive the engine from its EXISTING image
# (--no-build: the old version up always beats a broken build keeping it down);
# if it still will not serve, restart the engine and force-recreate Caddy.
# Skips entirely while a deploy is actively running so it never fights compose.
set -u

DIR=/opt/recruiteros
LOG=/var/log/ostext-watchdog.log
cd "$DIR" || exit 0

# Never act mid-deploy: a recreate in progress looks "down" for a few seconds.
# Check the systemd unit that actually runs the deploy, NOT pgrep: any stray
# shell that merely mentions the script name in its command line would fool a
# pgrep match forever and neuter this watchdog.
DEPLOY_STATE=$(systemctl is-active recruiteros-deploy.service 2>/dev/null || true)
case "$DEPLOY_STATE" in active|activating|deactivating) exit 0;; esac

probe() {
  curl -s -o /dev/null -w '%{http_code}' -m 10 -k \
    --resolve recruitersos.co:443:127.0.0.1 https://recruitersos.co/ostext-app/ || echo 000
}

alive() { case "$1" in 2*|3*|401|403) return 0;; *) return 1;; esac; }

CODE=$(probe)
alive "$CODE" && exit 0

echo "$(date -u) probe=$CODE, OS Text is dark: reviving..." >> "$LOG"
# Clear docker's failed-recreate artifacts (stopped "Created" duplicates).
docker ps -aq --filter "name=taltxt" --filter status=created | xargs -r docker rm -f >> "$LOG" 2>&1
docker compose up -d --no-build --no-deps taltxt >> "$LOG" 2>&1
sleep 15

CODE=$(probe)
if alive "$CODE"; then
  echo "$(date -u) recovered (probe=$CODE) after revive from existing image" >> "$LOG"
  exit 0
fi

echo "$(date -u) still dark (probe=$CODE): restarting engine + recreating caddy..." >> "$LOG"
docker compose restart taltxt >> "$LOG" 2>&1
docker compose up -d --force-recreate caddy >> "$LOG" 2>&1
sleep 15
CODE=$(probe)
if alive "$CODE"; then
  echo "$(date -u) recovered (probe=$CODE) after engine restart + caddy recreate" >> "$LOG"
else
  echo "$(date -u) STILL DARK (probe=$CODE) after full recovery attempt, will retry next tick" >> "$LOG"
fi
