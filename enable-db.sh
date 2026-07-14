#!/usr/bin/env bash
#
# DEPRECATED / DISARMED — do not use.
#
# This script used to point the app at Postgres and `docker volume rm pg_data`
# to re-init it with a fresh password. That was the single biggest cause of the
# "logged out / account gone after every deploy" bug: it wiped every account
# (and, since OS Text shares pg_data, OS Text's database too) and forced the app
# onto a fragile pg backend whose password drifted out of sync.
#
# The app now persists to the durable /data file volume (app_data, ROS_DATA_DIR
# =/data) — see integration/lib/db mode(). That survives every redeploy with no
# password to sync and nothing to volume-init. There is nothing to "enable".
#
# This script is kept only so old references don't error; it is now a safe no-op
# and will NEVER delete a volume.
set -euo pipefail

echo "enable-db.sh is deprecated and does nothing: persistence now uses the"
echo "durable /data file volume automatically. No action needed."
exit 0

# --- original destructive body retained below but unreachable (exit 0 above) ---

# Resolve the repo dir from this script's own location (works regardless of the
# checkout name: /opt/recruiteros, /opt/recruitersos, ...).
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
ENV=".env.production"
touch "$ENV"

say() { printf "\n\033[1;35m==> %s\033[0m\n" "$1"; }

# 1. Ensure a Postgres password exists in .env.production (generate once, then keep).
if ! grep -q '^POSTGRES_PASSWORD=' "$ENV"; then
  say "Generating a Postgres password"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> "$ENV"
fi
PW="$(grep '^POSTGRES_PASSWORD=' "$ENV" | head -1 | cut -d= -f2-)"

# 2. Point the app at the db service with that exact password (replace any old line).
say "Setting DATABASE_URL to match"
grep -v '^DATABASE_URL=' "$ENV" > "$ENV.tmp" || true
echo "DATABASE_URL=postgres://recruiteros:${PW}@db:5432/recruiteros" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

# 3. Recreate the Postgres volume so it initializes with this password. The TLS
#    cert volume (caddy_data) is left untouched, so HTTPS is unaffected.
say "Recreating the Postgres volume (no data to preserve)"
docker compose stop db 2>/dev/null || true
docker compose rm -f db 2>/dev/null || true
VOL="$(docker volume ls --format '{{.Name}}' | grep -E 'pg_data$' | head -1 || true)"
if [ -n "$VOL" ]; then docker volume rm "$VOL" 2>/dev/null || true; fi

# 4. Bring everything back up with persistence on.
say "Rebuilding with persistence enabled (a few minutes)"
docker compose up -d --build

cat <<EOF

============================================================
Login persistence is ON.

Sign in once at https://recruitersos.co/login.html — your account,
workspace, prospects, and session now survive every future update.
No more signing up again.
============================================================
EOF
