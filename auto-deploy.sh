#!/usr/bin/env bash
#
# RecruiterOS auto-deploy watcher.
# Checks GitHub for new commits on main; if found, pulls and redeploys.
# Designed to run every couple minutes via a systemd timer (see install below).
# Safe to run repeatedly: it does nothing when there is no new commit.
set -euo pipefail

DIR="/opt/recruiteros"
LOG="/var/log/recruiteros-deploy.log"
BRANCH="main"

cd "$DIR" || { echo "$(date -u) no $DIR" >> "$LOG"; exit 0; }

# Fetch quietly; compare local vs remote.
git fetch origin "$BRANCH" --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0   # already up to date, nothing to do
fi

echo "$(date -u) new commit $REMOTE (was $LOCAL), deploying..." >> "$LOG"
git reset --hard "origin/$BRANCH" >> "$LOG" 2>&1
docker compose up -d --build >> "$LOG" 2>&1
echo "$(date -u) deploy complete" >> "$LOG"
