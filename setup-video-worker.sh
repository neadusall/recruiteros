#!/usr/bin/env bash
#
# RecruitersOS · Distributed VIDEO worker setup
#
# Turns a box into a video worker: it claims "make a video" jobs from the main, captures the job
# posting (Chromium) + composites your clip over it (ffmpeg), uploads the finished video to shared
# object storage (S3), and reports the key back. N workers ≈ N× the video throughput → the path to
# 5K videos/day.
#
# Run on the worker box, FROM the checked-out repo root, with the S3 + worker env set:
#   WORKER_MAIN_URL=https://recruitersos.co \
#   WORKER_TOKEN=<same as INMARKET_WORKER_TOKEN on the main> \
#   ROS_S3_BUCKET=... ROS_S3_ENDPOINT=... ROS_S3_ACCESS_KEY_ID=... ROS_S3_SECRET_ACCESS_KEY=... \
#   bash setup-video-worker.sh
#
# (The SAME ROS_S3_* the main uses — so the clip downloads and the composite is servable by the main.)
# Idempotent: safe to re-run.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_URL="${WORKER_MAIN_URL:-}"
TOKEN="${WORKER_TOKEN:-}"
BATCH="${VIDEO_WORKER_BATCH:-8}"
CONCURRENCY="${VIDEO_WORKER_CONCURRENCY:-1}"   # composites at once — raise toward the box's vCPU count
ENVF="/etc/recruiteros-video-worker.env"

if [ -z "$MAIN_URL" ] || [ -z "$TOKEN" ]; then
  echo "ERROR: set WORKER_MAIN_URL and WORKER_TOKEN."; exit 1
fi
if [ -z "${ROS_S3_BUCKET:-}" ] || [ -z "${ROS_S3_ENDPOINT:-}" ] || [ -z "${ROS_S3_ACCESS_KEY_ID:-}" ] || [ -z "${ROS_S3_SECRET_ACCESS_KEY:-}" ]; then
  echo "ERROR: video workers require shared object storage. Set ROS_S3_BUCKET / ROS_S3_ENDPOINT / ROS_S3_ACCESS_KEY_ID / ROS_S3_SECRET_ACCESS_KEY (the same the main uses)."; exit 1
fi

# 1) Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[video-worker-setup] installing Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - >/dev/null 2>&1 || true
  apt-get install -y nodejs >/dev/null 2>&1 || true
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js install failed — install Node 18+ and re-run."; exit 1; }
echo "[video-worker-setup] node $(node -v)"

# 2) ffmpeg (the composite step) — REQUIRED.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[video-worker-setup] installing ffmpeg..."
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y ffmpeg >/dev/null 2>&1 || true
fi
command -v ffmpeg >/dev/null 2>&1 || { echo "ERROR: ffmpeg install failed — apt-get install ffmpeg and re-run."; exit 1; }

# 3) Dependencies + Chromium (the capture step).
echo "[video-worker-setup] installing dependencies (integration/)..."
( cd "$DIR/integration" && npm install --no-audit --no-fund >/dev/null 2>&1 ) || { echo "ERROR: npm install failed in integration/"; exit 1; }
echo "[video-worker-setup] installing Chromium for capture..."
( cd "$DIR/integration" && npx playwright install --with-deps chromium >/dev/null 2>&1 ) || echo "[video-worker-setup] (playwright install had warnings — capture may still work if Chromium is present)"

# 4) Env file (0600 — holds the token + S3 secret).
cat > "$ENVF" <<EOF
WORKER_MAIN_URL=$MAIN_URL
WORKER_TOKEN=$TOKEN
VIDEO_WORKER_BATCH=$BATCH
VIDEO_WORKER_CONCURRENCY=$CONCURRENCY
NODE_ENV=production
ROS_S3_BUCKET=$ROS_S3_BUCKET
ROS_S3_ENDPOINT=$ROS_S3_ENDPOINT
ROS_S3_ACCESS_KEY_ID=$ROS_S3_ACCESS_KEY_ID
ROS_S3_SECRET_ACCESS_KEY=$ROS_S3_SECRET_ACCESS_KEY
ROS_S3_REGION=${ROS_S3_REGION:-auto}
ROS_S3_FORCE_PATH_STYLE=${ROS_S3_FORCE_PATH_STYLE:-}
EOF
chmod 600 "$ENVF"

# 5) systemd service.
cat > /etc/systemd/system/recruiteros-video-worker.service <<EOF
[Unit]
Description=RecruitersOS distributed video worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR/integration
EnvironmentFile=$ENVF
ExecStart=$(command -v npx) tsx scripts/video-worker.ts
Restart=always
RestartSec=10
MemoryMax=3000M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-video-worker.service >/dev/null 2>&1 || true
sleep 2
echo "[video-worker-setup] DONE. Worker is live and composing video from $MAIN_URL"
echo "[video-worker-setup] follow it with:  journalctl -u recruiteros-video-worker -f"
systemctl --no-pager status recruiteros-video-worker.service 2>/dev/null | head -6 || true
