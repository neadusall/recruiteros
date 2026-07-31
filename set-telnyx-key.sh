#!/usr/bin/env bash
#
# Give the Spend master a Telnyx account to read.
#
# THIS BUSINESS RUNS MORE THAN ONE TELNYX ACCOUNT. The house account carries the
# RecruitersOS numbers, the BD Phone and the cell check; Lume's white-label account
# carries its per-recruiter 929 lines and everything its recruiters send, on its own
# invoices and its own balance. One API key reads exactly ONE account, so until the
# second key is here the tenant's spend is not small on the console — it is ABSENT,
# and the row honestly reads "not being read at all".
#
#   Run on the server:
#     bash /opt/recruiteros/set-telnyx-key.sh house '<KEY_...>'
#     bash /opt/recruiteros/set-telnyx-key.sh lume  '<KEY_...>'
#
# Where to get the key: portal.telnyx.com, sign in to THAT account, then
#   Account Settings -> Keys & Credentials -> API Keys -> Create API Key.
# A read-only key is enough: the puller only ever calls GET /v2/invoices,
# /v2/usage_reports and /v2/balance. It never sends, buys or changes anything.
#
# The key is passed as an argument and written to .env.production (gitignored,
# never committed), so this script holds no secret of its own. Quote it: Telnyx
# keys can contain characters the shell would otherwise eat.
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 2 ]; then
  cat <<'USAGE'
usage: bash set-telnyx-key.sh <house|lume> '<api-key>'

  house   the RecruitersOS account  -> TELNYX_API_KEY
  lume    Lume's white-label account -> TELNYX_API_KEY_LUME

Quote the key.
USAGE
  exit 1
fi

case "$1" in
  house) VAR="TELNYX_API_KEY";      WHO="the house account" ;;
  lume)  VAR="TELNYX_API_KEY_LUME"; WHO="Lume's white-label account" ;;
  *) echo "First argument must be 'house' or 'lume', not '$1'."; exit 1 ;;
esac
KEY="$2"

# Prove the key works, and say WHOSE account it opens, BEFORE writing it. A key
# pasted into the wrong slot would quietly file one account's money against the
# other's line, which is worse than no key at all.
echo "Checking the key against Telnyx..."
BAL="$(curl -sS -m 20 -H "authorization: Bearer $KEY" https://api.telnyx.com/v2/balance || true)"
if ! printf '%s' "$BAL" | grep -q '"balance"'; then
  echo "Telnyx refused that key. It answered:"
  printf '%s\n' "$BAL" | head -c 400
  echo
  echo "Nothing was saved. Check you copied the whole key, from the right account."
  exit 1
fi

NUMS="$(curl -sS -m 20 -H "authorization: Bearer $KEY" \
  'https://api.telnyx.com/v2/phone_numbers?page[size]=5&page[number]=1' || true)"

echo
echo "That key opens an account with:"
printf '%s' "$BAL"  | sed -E 's/.*"balance":"([^"]*)".*/  balance $\1/'
printf '%s' "$NUMS" | grep -oE '"phone_number":"[^"]*"' | sed -E 's/.*:"(.*)"/  number \1/' | head -5
echo
read -r -p "Is that $WHO? [y/N] " ANSWER
case "$ANSWER" in
  y|Y|yes|YES) ;;
  *) echo "Nothing was saved."; exit 1 ;;
esac

ENV=".env.production"
touch "$ENV"
chmod 600 "$ENV"
grep -v -E "^${VAR}=" "$ENV" > "$ENV.tmp" 2>/dev/null || true
echo "${VAR}=${KEY}" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"
echo "Saved as ${VAR}."

# env_file is only re-read when the container is RECREATED. `up -d app` alone leaves
# the old environment in place and the key looks installed while nothing can see it.
echo
echo "Recreating the app so it picks the key up..."
docker compose up -d --force-recreate app

cat <<'DONE'

Done. To pull that account's months now instead of waiting for tonight:

  docker exec recruiteros-app-1 node -e "fetch('http://localhost:3000/api/owner/receipts/cron?monthsBack=6',{method:'POST',headers:{'x-cron-secret':process.env.RECRUITEROS_CRON_SECRET}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.pulls,null,1)))"

Then open https://recruitersos.co/owner-console#burn — each Telnyx account has its
own line under "Month by month", and neither can pick up the other's figure.
DONE
