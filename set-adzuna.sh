#!/usr/bin/env bash
#
# Store Adzuna API credentials on the server and rebuild so the Adzuna source goes
# live. Keys are written to .env.production (gitignored — never committed) and are
# passed as arguments, so this script holds no secrets.
#
#   Run on the server:
#     bash /opt/recruiteros/set-adzuna.sh <app_id> <app_key>
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 2 ]; then
  echo "usage: bash set-adzuna.sh <app_id> <app_key>"
  exit 1
fi

ENV=".env.production"
touch "$ENV"

# Replace any existing Adzuna lines, then append the new ones.
grep -v -E '^ADZUNA_APP_(ID|KEY)=' "$ENV" > "$ENV.tmp" 2>/dev/null || true
{
  echo "ADZUNA_APP_ID=$1"
  echo "ADZUNA_APP_KEY=$2"
} >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo "Adzuna keys saved to .env.production. Rebuilding (a few minutes)..."
docker compose up -d --build

echo ""
echo "Adzuna is live. Hire Signals now pulls from Adzuna's full aggregator feed."
