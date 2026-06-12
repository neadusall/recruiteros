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

# One-time: MIGRATE persistence off Postgres onto the durable /data file volume.
# The app now snapshots accounts/sessions to /data (the app_data named volume),
# which survives every redeploy with no password to sync — see lib/db mode().
# Older installs still carry a `DATABASE_URL=...@db:5432/recruiteros` line in
# .env.production that used to force the fragile pg backend (and enable-db.sh
# even did `docker volume rm pg_data`, wiping every account on deploy). Strip
# that line ONCE so the app can never be flipped back onto Postgres. taltxt's own
# DATABASE_URL lives in money-maker-sms/.env.production and is left untouched.
if [ ! -f "$DIR/.file-persistence-v1" ]; then
  echo "$(date -u) one-time: migrating to /data file persistence (strip stale DATABASE_URL)..." >> "$LOG"
  if [ -f "$DIR/.env.production" ] && grep -q '^DATABASE_URL=' "$DIR/.env.production"; then
    grep -v '^DATABASE_URL=' "$DIR/.env.production" > "$DIR/.env.production.tmp" \
      && mv "$DIR/.env.production.tmp" "$DIR/.env.production" \
      && chmod 600 "$DIR/.env.production"
    echo "$(date -u) removed stale DATABASE_URL from .env.production" >> "$LOG"
    docker compose up -d --force-recreate app >> "$LOG" 2>&1 || true
  fi
  touch "$DIR/.file-persistence-v1"
  echo "$(date -u) file persistence active" >> "$LOG"
fi

# One-time: force-recreate the app + caddy so they pick up the CURRENT compose
# config that a plain `up -d --build` can miss on a long-lived container — the
# app's `environment:` block (ROS_DATA_DIR=/data + the app_data volume mount,
# WHITE_LABEL_CNAME_TARGET, OWNER_EMAIL, RESEND_API_KEY, …) AND Caddy's
# bind-mounted Caddyfile (the white-label on-demand-TLS catch-all). Without this,
# accounts kept getting wiped on deploy and custom domains never got a cert.
# Marker-guarded (runs exactly once), same pattern as the DB step above, and
# placed before the up-to-date early-exit so it runs even with no new commit.
if [ ! -f "$DIR/.edge-recreate-v1" ]; then
  echo "$(date -u) one-time: force-recreate app+caddy (load compose env + Caddyfile)..." >> "$LOG"
  if docker compose up -d --force-recreate app caddy >> "$LOG" 2>&1; then
    touch "$DIR/.edge-recreate-v1"
    echo "$(date -u) app+caddy force-recreated" >> "$LOG"
  else
    echo "$(date -u) edge recreate failed, will retry next cycle" >> "$LOG"
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
# --hard does NOT touch submodule working trees. TOLERATE failure (e.g. a private
# submodule the server can't clone) — it must NEVER block the main app deploy.
git submodule sync --recursive >> "$LOG" 2>&1 || true
git submodule update --init --recursive >> "$LOG" 2>&1 || echo "$(date -u) submodule update failed — taltxt may be skipped" >> "$LOG"
# Deploy. Try the full stack; if any service (e.g. taltxt) fails to build, fall
# back to (re)building just the core app + db + caddy so app updates ALWAYS ship.
if docker compose up -d --build >> "$LOG" 2>&1; then
  echo "$(date -u) deploy complete (full stack)" >> "$LOG"
else
  echo "$(date -u) full build failed — deploying core only (skipping taltxt)" >> "$LOG"
  docker compose up -d --build --no-deps app >> "$LOG" 2>&1 || true
  docker compose up -d --no-deps db caddy >> "$LOG" 2>&1 || true
  echo "$(date -u) deploy complete (core only)" >> "$LOG"
fi
