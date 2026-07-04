#!/usr/bin/env bash
#
# LEAN ENRICHMENT MODEL — KoldInfo + Reoon + pattern cache, and NOTHING else.
#
# Turns ON exactly three things:
#   - Reoon          (REOON_API_KEY)         — confirms every mailbox
#   - Pattern cache  (INMARKET_PATTERN_CACHE)— learn one domain, construct the rest
#   - KoldInfo       (no key needed)         — the operator CSV round-trip in the Engine panel
#
# And BLANKS every paid rung so none can switch on: Icypeas, the Findymail finder-of-record,
# RapidAPI web-search / naming, and SMTP finding. Empty value => the code's gate reads OFF.
#
# Holds no secrets itself — pass your Reoon key as the only argument.
# Run ON THE SERVER (Hetzner console or SSH):
#   bash /opt/recruiteros/set-live-lean.sh <YOUR_REOON_API_KEY>
#
set -euo pipefail

if [ "$#" -lt 1 ] || [ -z "$1" ]; then
  echo "usage: bash set-live-lean.sh <REOON_API_KEY>" >&2
  exit 1
fi
REOON_KEY="$1"

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
ENV=".env.production"
touch "$ENV"
chmod 600 "$ENV"

# ON: the lean model.  OFF (blank): everything paid/experimental.
PAIRS=(
  "REOON_API_KEY=${REOON_KEY}"      # ON  — mailbox confirmation
  "INMARKET_PATTERN_CACHE=1"        # ON  — learn-once-construct-many
  "REOON_ACCEPT_CATCHALL=1"         # catch-all kept as its own tier (default)
  # --- explicitly OFF so nothing else can switch on ---
  "ICYPEAS_API_KEY="
  "ICYPEAS_API_SECRET="
  "INMARKET_FINDER_URL="
  "INMARKET_FINDER_TOKEN="
  "RAPID_WEBSEARCH_KEY="
  "RAPID_NAMING_KEY="
  "INMARKET_SMTP_VERIFY="
  "INMARKET_EMAIL_FINDER="
)

for pair in "${PAIRS[@]}"; do
  key="${pair%%=*}"
  grep -v -E "^${key}=" "$ENV" > "$ENV.tmp" 2>/dev/null || true
  echo "$pair" >> "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
done
chmod 600 "$ENV"

echo "Lean model written to $ENV:"
echo "  ON : REOON_API_KEY, INMARKET_PATTERN_CACHE=1  (+ KoldInfo, no key)"
echo "  OFF: Icypeas, Findymail finder, RapidAPI web-search/naming, SMTP finder"
echo ""
echo "Rebuilding the app so it picks up the change..."
if command -v docker >/dev/null 2>&1; then
  docker compose up -d --build app
else
  echo "  (docker not found — rebuild the app service manually)"
fi

echo ""
echo "Verify: open the Engine / Throughput panel — Reoon should read 'live', and the"
echo "KoldInfo Export/Import controls sit under the funnel. Nothing else is armed."
