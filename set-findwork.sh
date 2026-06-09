#!/usr/bin/env bash
#
# Store a Findwork.dev API key on the server and rebuild so the Findwork source goes
# live. The key is written to .env.production (gitignored — never committed) and is
# passed as an argument, so this script holds no secrets.
#
# Get a free key at https://findwork.dev/developers/ , then run on the server:
#     bash /opt/recruiteros/set-findwork.sh <api_key>
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 1 ]; then
  echo "usage: bash set-findwork.sh <api_key>"
  exit 1
fi

ENV=".env.production"
touch "$ENV"

grep -v -E '^FINDWORK_API_KEY=' "$ENV" > "$ENV.tmp" 2>/dev/null || true
echo "FINDWORK_API_KEY=$1" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo "Findwork key saved to .env.production. Rebuilding (a few minutes)..."
docker compose up -d --build

echo ""
echo "Findwork is live. Hire Signals now pulls from the Findwork.dev feed."
