#!/usr/bin/env bash
#
# RecruiterOS, one-time: switch ON database persistence so accounts, workspaces,
# and login sessions survive every redeploy. Without this the app runs in-memory
# and forgets everyone each time the container restarts (i.e. on every update),
# which is why you keep having to sign up again.
#
# Safe to run: the app already resets on each deploy, so there is no data to lose.
# This wires the app to the Postgres service that is already running, recreating
# its volume so it initializes with a known password.
#
#   Run once on the server:   bash /opt/recruiteros/enable-db.sh
#
set -euo pipefail

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
