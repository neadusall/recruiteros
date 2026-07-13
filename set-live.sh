#!/usr/bin/env bash
#
# Flip production switches on the live server in one shot. Takes any number of
# KEY=VALUE pairs, upserts each into .env.production (gitignored — never
# committed), then rebuilds so the app picks them up. Holds no secrets itself;
# everything is passed as arguments.
#
# Run ON THE SERVER (Hetzner web console or SSH), e.g.:
#   bash /opt/recruiteros/set-live.sh \
#     REOON_API_KEY=xxxxx \
#     INMARKET_AUTOENROLL=1 \
#     INMARKET_AUTOENROLL_WORKSPACE=ws_123 \
#     INMARKET_AUTOENROLL_CAMPAIGN=camp_456
#
# Re-run any time to add or change more. Confirm afterward via the engine_health
# action (this script prints the curl at the end).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 1 ]; then
  cat <<'USAGE'
usage: bash set-live.sh KEY=VALUE [KEY=VALUE ...]

Common bundles:

  # 1) Verify emails (the "valid prospects" lever) — REQUIRED for verified count to climb
  REOON_API_KEY=<your-key>

  # 2) Widen free-source supply via Hetzner IP rotation (buy/attach the IPs first)
  INMARKET_EGRESS_IPS=1.2.3.4,1.2.3.5,1.2.3.6,1.2.3.7,1.2.3.8

  # 3) Auto-fill BD Bulk hands-off (never auto-sends)
  INMARKET_AUTOENROLL=1
  INMARKET_AUTOENROLL_WORKSPACE=<workspaceId>
  INMARKET_AUTOENROLL_CAMPAIGN=<bd-bulk-campaignId>

  # 4) Turn the "with video" pipeline on (also set the storage keys below)
  INMARKET_AUTOCAPTURE=1
  INMARKET_AUTOVIDEO=1
  INMARKET_AUTOVIDEO_WORKSPACE=<workspaceId>
  ROS_S3_ENDPOINT=...  ROS_S3_BUCKET=...  ROS_S3_KEY=...  ROS_S3_SECRET=...
USAGE
  exit 1
fi

ENV=".env.production"
touch "$ENV"
chmod 600 "$ENV"

for pair in "$@"; do
  if [[ "$pair" != *=* ]]; then
    echo "skip (not KEY=VALUE): $pair" >&2
    continue
  fi
  key="${pair%%=*}"
  # Upsert: drop any existing line for this key, then append the new one.
  grep -v -E "^${key}=" "$ENV" > "$ENV.tmp" 2>/dev/null || true
  echo "$pair" >> "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
  echo "set ${key}"
done
chmod 600 "$ENV"

echo ""
echo "Rebuilding so the app picks up the new settings (a few minutes)..."
docker compose up -d --build

echo ""
echo "Done. Verify everything switched on (run on the server or your PC):"
echo "  curl -s -X POST http://localhost:3000/api/in-market \\"
echo "    -H 'content-type: application/json' \\"
echo "    -d '{\"action\":\"engine_health\"}'"
echo ""
echo "Look for: reoon.enabled=true, egress.enabled=true, autoEnroll.enabled=true,"
echo "autoCapture.enabled=true, autoVideo.enabled=true — and the counts climbing."
