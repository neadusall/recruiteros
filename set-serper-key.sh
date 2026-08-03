#!/usr/bin/env bash
#
# Wire up Serper.dev, the cheap Google-results path the sourcing engine was built around.
#
# WHY THIS MATTERS MORE THAN IT LOOKS. lib/sourcing/discovery.ts puts Serper AFTER the free
# passes and BEFORE the marketplace listing, deliberately, "so the cheap key absorbs volume
# the expensive listing would otherwise carry". Without the key that middle rung does not
# exist: every X-ray run falls through to the free HTML scrapers, which is why the scraper
# fleet is rate-limited and red while a paid Google feed sits unused.
#
# $50 of Serper credit was bought on 2026-07-30 (50,000 searches) and has never been
# called. At roughly $0.30 to $1.00 per 1,000 searches, that is the whole sourcing engine's
# search budget for months.
#
#   Run on the server:
#     bash /opt/recruiteros/set-serper-key.sh '<your-serper-key>'
#
# Where to get it: serper.dev, sign in, Dashboard -> API Key. It is a single long string.
# Quote it, so the shell cannot eat anything in it.
#
# THE KEY IS PROVED BEFORE IT IS WRITTEN. A key that does not work, or a plan with no
# credits left, is indistinguishable afterwards from a key that was never set: both leave
# the engine quietly falling through to the free scrapers. So this runs a real search
# first, prints what came back and how much credit is left, and writes nothing unless that
# worked.
#
# The key is passed as an argument and written to .env.production (gitignored, never
# committed), so this script holds no secret of its own.
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 1 ]; then
  echo "usage: bash set-serper-key.sh '<serper-api-key>'"
  echo "get one at: https://serper.dev  ->  Dashboard  ->  API Key"
  exit 1
fi

KEY="$1"
ENV=".env.production"

if [ "${#KEY}" -lt 20 ]; then
  echo "That does not look like a Serper key (too short). Nothing has been written." >&2
  exit 1
fi

echo "Testing the key against Serper before writing it..."
# One real search. Serper answers 200 with JSON on success, 401/403 on a bad key, and
# 429 when the credit is gone - and those three need to read differently here, because
# only the first means "safe to write".
HTTP="$(curl -s -o /tmp/serper-probe.json -w '%{http_code}' \
  -X POST 'https://google.serper.dev/search' \
  -H "X-API-KEY: ${KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"q":"site:linkedin.com/in recruiter","num":1}' || echo 000)"

case "$HTTP" in
  200)
    ORGANIC="$(grep -o '"organic"' /tmp/serper-probe.json | wc -l | tr -d ' ')"
    CREDITS="$(grep -oE '"credits"[[:space:]]*:[[:space:]]*[0-9]+' /tmp/serper-probe.json | grep -oE '[0-9]+$' || true)"
    echo "  OK: Serper answered, ${ORGANIC:-0} organic block(s) returned."
    [ -n "$CREDITS" ] && echo "  Credits used by this probe: $CREDITS"
    ;;
  401|403)
    echo "  REFUSED: Serper rejected that key (HTTP $HTTP). Check you copied the whole thing." >&2
    rm -f /tmp/serper-probe.json
    exit 1
    ;;
  429)
    echo "  OUT OF CREDIT: the key is valid but the plan has nothing left (HTTP 429)." >&2
    echo "  Top up at serper.dev first, then run this again." >&2
    rm -f /tmp/serper-probe.json
    exit 1
    ;;
  000)
    echo "  Could not reach google.serper.dev from this server. Nothing has been written." >&2
    exit 1
    ;;
  *)
    echo "  Serper answered HTTP $HTTP, which is not a success. Nothing has been written." >&2
    head -c 300 /tmp/serper-probe.json >&2 || true
    rm -f /tmp/serper-probe.json
    exit 1
    ;;
esac
rm -f /tmp/serper-probe.json

touch "$ENV"
chmod 600 "$ENV"
grep -v -E '^SERPER_API_KEY=' "$ENV" > "$ENV.tmp" 2>/dev/null || true
echo "SERPER_API_KEY=$KEY" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo ""
echo "Saved. Restarting the app so it picks the key up..."
# env_file is only re-read when the container is RECREATED, so a restart would leave the
# app running without the key while the file on disk looked correct.
docker compose up -d app

cat <<'DONE'

Done. What changes because of this:

  - X-ray sourcing now has its cheap paid rung. Runs stop falling through to the free
    HTML scrapers for everything, which is what has been getting the scraper fleet
    rate-limited.
  - Serper runs AFTER the free passes and BEFORE any marketplace listing, so it only
    spends where the free path came up short.
  - SERPER_MAX_QUERIES caps how many searches one run may spend, if you want a ceiling.

Check it is really being used: run a JD Sourcing search and look at Owner Console ->
Spend master; the Serper line should start showing usage against the $50 already paid.
DONE
