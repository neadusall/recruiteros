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
# Volume pacing — defaults tuned for the JSearch ULTRA plan (50K req/mo → ~500K
# jobs/mo): 50 jobs/category × 14 categories/hour × 24h × 30d ≈ 504K jobs.
#   PRO ($25):  PAGES_PER_CYCLE=3   MEGA ($150):  PAGES_PER_CYCLE=55
PAGE="${5:-50}"
PAGES_PER_CYCLE="${6:-14}"

ENV=".env.production"
touch "$ENV"

# Drop any prior RAPID_JOBS_* lines, then write the fresh set.
grep -v -E '^RAPID_JOBS_(KEY|HOST|PROVIDER|DATE|PAGE|PAGES_PER_CYCLE)=' "$ENV" > "$ENV.tmp" 2>/dev/null || true
{
  echo "RAPID_JOBS_KEY=$KEY"
  echo "RAPID_JOBS_HOST=$HOST"
  echo "RAPID_JOBS_PROVIDER=$PROVIDER"
  echo "RAPID_JOBS_DATE=$DATE"
  echo "RAPID_JOBS_PAGE=$PAGE"
  echo "RAPID_JOBS_PAGES_PER_CYCLE=$PAGES_PER_CYCLE"
} >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

EST_JOBS=$(( PAGE * PAGES_PER_CYCLE * 24 * 30 ))
echo "RapidAPI job feed saved to .env.production ($PROVIDER @ $HOST)."
echo "Pacing: $PAGE jobs/category x $PAGES_PER_CYCLE categories/hour x 24h x 30d = ~$EST_JOBS jobs/month."
echo "Rebuilding (a few minutes)..."
docker compose up -d --build

echo ""
echo "Job feed is live. Hire Signals now pulls real US postings from $PROVIDER;"
echo "each lead's posting link feeds the roleShot screen-capture for video emails."
echo "Watch usage on the RapidAPI dashboard for 48h; if you near the request cap,"
echo "re-run with a lower last arg, e.g.: bash set-rapidjobs.sh <key> '' '' '' 50 13"
