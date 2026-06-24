#!/usr/bin/env bash
#
# Store the RapidAPI JOB-FEED key on the server and rebuild so the paid job feed goes
# live. The provider we standardized on is JSearch (jsearch.p.rapidapi.com); Active Jobs
# DB is a drop-in fallback. Keys are written to .env.production (gitignored — never
# committed) and passed as arguments, so this script holds no secrets.
#
# Once live, Hire Signals pulls real US job postings (~10/request, per-request billing).
# Each record carries the company domain + posting link → lead.sourceUrl, which feeds the
# roleShot screen-capture (the video-email background). No extra screenshot key needed —
# roleShot captures locally.
#
# 1) Subscribe to JSearch on RapidAPI:  https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
# 2) Copy your X-RapidAPI-Key, then run on the server:
#       bash /opt/recruiteros/set-rapidjobs.sh <rapidapi_key>
#    Optional overrides (defaults shown):
#       bash /opt/recruiteros/set-rapidjobs.sh <key> jsearch.p.rapidapi.com jsearch week
#       bash /opt/recruiteros/set-rapidjobs.sh <key> active-jobs-db.p.rapidapi.com active-jobs-db
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 1 ]; then
  echo "usage: bash set-rapidjobs.sh <rapidapi_key> [host] [provider] [date_window]"
  echo "  defaults: host=jsearch.p.rapidapi.com provider=jsearch date_window=week"
  exit 1
fi

KEY="$1"
HOST="${2:-jsearch.p.rapidapi.com}"
PROVIDER="${3:-jsearch}"
DATE="${4:-week}"

ENV=".env.production"
touch "$ENV"

# Drop any prior RAPID_JOBS_* lines, then write the fresh set.
grep -v -E '^RAPID_JOBS_(KEY|HOST|PROVIDER|DATE)=' "$ENV" > "$ENV.tmp" 2>/dev/null || true
{
  echo "RAPID_JOBS_KEY=$KEY"
  echo "RAPID_JOBS_HOST=$HOST"
  echo "RAPID_JOBS_PROVIDER=$PROVIDER"
  echo "RAPID_JOBS_DATE=$DATE"
} >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo "RapidAPI job feed saved to .env.production ($PROVIDER @ $HOST). Rebuilding (a few minutes)..."
docker compose up -d --build

echo ""
echo "Job feed is live. Hire Signals now pulls real US postings from $PROVIDER;"
echo "each lead's posting link feeds the roleShot screen-capture for video emails."
