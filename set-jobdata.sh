#!/usr/bin/env bash
#
# Store a JobDataAPI (jobdataapi.com) key on the server and rebuild so the Jobdata source
# goes live. The key is written to .env.production (gitignored — never committed) and is
# passed as an argument, so this script holds no secrets.
#
# Get a free key at https://jobdataapi.com/ , then run on the server:
#     bash /opt/recruiteros/set-jobdata.sh <api_key>
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 1 ]; then
  echo "usage: bash set-jobdata.sh <api_key>"
  exit 1
fi

ENV=".env.production"
touch "$ENV"

grep -v -E '^JOBDATA_API_KEY=' "$ENV" > "$ENV.tmp" 2>/dev/null || true
echo "JOBDATA_API_KEY=$1" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo "Jobdata key saved to .env.production. Rebuilding (a few minutes)..."
docker compose up -d --build

echo ""
echo "Jobdata is live. Hire Signals now pulls from the JobDataAPI feed."
