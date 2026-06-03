#!/usr/bin/env bash
#
# RecruiterOS auto-deploy watcher.
# Checks GitHub for new commits on main; if found, pulls and redeploys.
# Designed to run every couple minutes via a systemd timer (see install below).
# Safe to run repeatedly: it does nothing when there is no new commit.
set -euo pipefail

# Resolve the repo dir from this script's own location, so the watcher works no
# matter what the checkout is named (/opt/recruitersos, /opt/recruiteros, …).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/var/log/recruiteros-deploy.log"
BRANCH="main"

cd "$DIR" || { echo "$(date -u) no $DIR" >> "$LOG"; exit 0; }

# One-time: switch ON database persistence (accounts + sessions survive restarts).
# Runs once, guarded by a marker file; safe to leave here forever.
#
# Marker is versioned (-v2): earlier installs initialized the Postgres volume
# with a password that did NOT match the app's (the db got it via Compose
# `${POSTGRES_PASSWORD}` substitution from a nonexistent .env, while the app read
# the real one from .env.production). That mismatch silently broke persistence.
# Bumping the marker forces enable-db.sh to re-run ONCE on those installs, which
# re-initializes the volume so the db and app share one password for good.
if [ ! -f "$DIR/.db-enabled-v2" ] && [ -f "$DIR/enable-db.sh" ]; then
  echo "$(date -u) enabling DB persistence (one-time, v2: fix password mismatch)..." >> "$LOG"
  if bash "$DIR/enable-db.sh" >> "$LOG" 2>&1; then
    touch "$DIR/.db-enabled-v2"
    echo "$(date -u) DB persistence enabled (v2)" >> "$LOG"
  else
    echo "$(date -u) enable-db failed, will retry next cycle" >> "$LOG"
  fi
fi

# Fetch quietly; compare local vs remote.
git fetch origin "$BRANCH" --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0   # already up to date, nothing to do
fi

echo "$(date -u) new commit $REMOTE (was $LOCAL), deploying..." >> "$LOG"
git reset --hard "origin/$BRANCH" >> "$LOG" 2>&1
# Pull/checkout submodules (OS Text / taltxt lives in money-maker-sms). reset
# --hard does NOT touch submodule working trees, so do it explicitly or the
# taltxt build context would be empty and `up --build` would fail.
git submodule sync --recursive >> "$LOG" 2>&1
git submodule update --init --recursive >> "$LOG" 2>&1
docker compose up -d --build >> "$LOG" 2>&1
echo "$(date -u) deploy complete" >> "$LOG"
