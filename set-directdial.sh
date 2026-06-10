#!/usr/bin/env bash
#
# Enable verified direct-dial reveal (person-direct landline/VoIP) on the server. Stores the
# Apify token + People Data Labs key in .env.production (gitignored — never committed) and
# rebuilds. Both are passed as arguments, so this script holds no secrets.
#
# Get the keys (free tiers):
#   APIFY_TOKEN  — apify.com → Settings → Integrations → API token
#   PDL_API_KEY  — peopledatalabs.com → free trial = 500 lookups / 30 days
#
# Run on the server:
#     bash /opt/recruiteros/set-directdial.sh <apify_token> <pdl_api_key>
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 2 ]; then
  echo "usage: bash set-directdial.sh <apify_token> <pdl_api_key>"
  exit 1
fi

ENV=".env.production"
touch "$ENV"

grep -v -E '^(APIFY_TOKEN|PDL_API_KEY)=' "$ENV" > "$ENV.tmp" 2>/dev/null || true
{
  echo "APIFY_TOKEN=$1"
  echo "PDL_API_KEY=$2"
} >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo "Direct-dial keys saved to .env.production. Rebuilding (a few minutes)..."
docker compose up -d --build

echo ""
echo "Direct-dial reveal is live. In Hire Signals, tick 'Find verified direct dials' on a"
echo "push to resolve each contact's person-direct landline/VoIP (\$0.10/number found, no-find free)."
