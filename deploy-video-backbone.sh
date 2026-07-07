#!/usr/bin/env bash
#
# RecruitersOS · ONE-SHOT rollout of the 3K/day video backbone
#
# Orchestrates the whole DEPLOY-VIDEO.md runbook over SSH from wherever you run it (your laptop,
# or the main box): provisions the MinIO storage box, wires ROS_S3_* + retention into the main's
# env, restarts the app, and turns every worker box into a video worker. Run AFTER PR #41 is
# merged (the main must be deployed with retention + poster code first).
#
#   STORAGE_IP=<unused-hetzner-ip> \
#   WORKER_IPS="<mini1-ip> <mini2-ip> ..." \
#   bash deploy-video-backbone.sh
#
# Optional env:
#   MAIN_IP        main app server (default 178.156.170.244)
#   MAIN_DIR       app dir on the main (default /opt/recruitersos)
#   SSH_USER       default root
#   REPO_URL       cloned onto workers (default https://github.com/neadusall/recruiteros.git)
#   WORKSPACE_ID   INMARKET_AUTOVIDEO_WORKSPACE — required only if not already in the main's env
#
# NEVER point STORAGE_IP or WORKER_IPS at the Claimie VPS.
# Idempotent: safe to re-run; existing credentials/env lines are kept, not duplicated.
set -euo pipefail

MAIN_IP="${MAIN_IP:-178.156.170.244}"
MAIN_DIR="${MAIN_DIR:-/opt/recruitersos}"
SSH_USER="${SSH_USER:-root}"
REPO_URL="${REPO_URL:-https://github.com/neadusall/recruiteros.git}"
STORAGE_IP="${STORAGE_IP:-}"
WORKER_IPS="${WORKER_IPS:-}"

[ -n "$STORAGE_IP" ] || { echo "ERROR: set STORAGE_IP (the unused Hetzner box that becomes the video store — NOT Claimie's)."; exit 1; }
[ -n "$WORKER_IPS" ] || { echo "ERROR: set WORKER_IPS (space-separated worker box IPs — NOT Claimie's)."; exit 1; }
SSH() { ssh -o StrictHostKeyChecking=accept-new "$SSH_USER@$1" "${@:2}"; }

echo "== plan =="
echo "  storage : $STORAGE_IP (MinIO, bucket ros-pip-assets, 30d lifecycle backstop)"
echo "  main    : $MAIN_IP:$MAIN_DIR (env + restart)"
echo "  workers : $WORKER_IPS"
read -r -p "Proceed? [y/N] " yn; [ "$yn" = "y" ] || exit 1

# ── 1) Storage box ────────────────────────────────────────────────────────────
echo "== [1/4] provisioning MinIO on $STORAGE_IP =="
scp -o StrictHostKeyChecking=accept-new setup-minio.sh "$SSH_USER@$STORAGE_IP:/root/setup-minio.sh"
SSH "$STORAGE_IP" "MINIO_DATA_DIR=/data/minio FLEET_IPS='$MAIN_IP $WORKER_IPS' bash /root/setup-minio.sh"

# Pull the app credentials the setup script generated (kept in its 0600 env file).
APP_KEY=$(SSH "$STORAGE_IP" "grep '^APP_ACCESS_KEY=' /etc/recruiteros-minio.env | cut -d= -f2")
APP_SECRET=$(SSH "$STORAGE_IP" "grep '^APP_SECRET_KEY=' /etc/recruiteros-minio.env | cut -d= -f2")
[ -n "$APP_KEY" ] && [ -n "$APP_SECRET" ] || { echo "ERROR: couldn't read app credentials off $STORAGE_IP."; exit 1; }

S3_BLOCK="ROS_S3_BUCKET=ros-pip-assets
ROS_S3_ENDPOINT=http://$STORAGE_IP:9000
ROS_S3_ACCESS_KEY_ID=$APP_KEY
ROS_S3_SECRET_ACCESS_KEY=$APP_SECRET
ROS_S3_FORCE_PATH_STYLE=1"

# ── 2) Main env ───────────────────────────────────────────────────────────────
echo "== [2/4] wiring env on the main ($MAIN_IP) =="
# Ensure a worker token exists (reuse if present).
TOKEN=$(SSH "$MAIN_IP" "grep '^INMARKET_WORKER_TOKEN=' $MAIN_DIR/.env.production 2>/dev/null | cut -d= -f2" || true)
if [ -z "$TOKEN" ]; then TOKEN=$(openssl rand -hex 24); fi

SSH "$MAIN_IP" "bash -s" <<EOF
set -e
cd $MAIN_DIR
touch .env.production
# drop any previous values of the keys we manage, then append the fresh block
grep -vE '^(ROS_S3_BUCKET|ROS_S3_ENDPOINT|ROS_S3_ACCESS_KEY_ID|ROS_S3_SECRET_ACCESS_KEY|ROS_S3_FORCE_PATH_STYLE|INMARKET_RETENTION|INMARKET_RETENTION_DAYS|RECRUITEROS_SHARE_TTL_DAYS|INMARKET_WORKER_TOKEN|INMARKET_AUTOCAPTURE|INMARKET_AUTOCAPTURE_CONCURRENCY|INMARKET_AUTOVIDEO|INMARKET_AUTOVIDEO_SECONDS|INMARKET_AUTOVIDEO_CONCURRENCY)=' .env.production > .env.production.new || true
mv .env.production.new .env.production
cat >> .env.production <<ENV
$S3_BLOCK
INMARKET_WORKER_TOKEN=$TOKEN
INMARKET_AUTOCAPTURE=1
INMARKET_AUTOCAPTURE_CONCURRENCY=3
INMARKET_AUTOVIDEO=1
INMARKET_AUTOVIDEO_SECONDS=42
INMARKET_AUTOVIDEO_CONCURRENCY=2
INMARKET_RETENTION=1
INMARKET_RETENTION_DAYS=30
RECRUITEROS_SHARE_TTL_DAYS=30
ENV
${WORKSPACE_ID:+grep -q '^INMARKET_AUTOVIDEO_WORKSPACE=' .env.production || echo INMARKET_AUTOVIDEO_WORKSPACE=$WORKSPACE_ID >> .env.production}
docker compose up -d
EOF
if ! SSH "$MAIN_IP" "grep -q '^INMARKET_AUTOVIDEO_WORKSPACE=.\+' $MAIN_DIR/.env.production"; then
  echo "WARNING: INMARKET_AUTOVIDEO_WORKSPACE is not set on the main — the compositor won't find"
  echo "         your clip. Re-run with WORKSPACE_ID=<your workspace id>, or set it manually."
fi

# ── 3) Workers ────────────────────────────────────────────────────────────────
echo "== [3/4] provisioning workers =="
for W in $WORKER_IPS; do
  echo "-- worker $W --"
  SSH "$W" "bash -s" <<EOF
set -e
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }
if [ -d /opt/recruiteros/.git ]; then cd /opt/recruiteros && git pull --ff-only; else git clone $REPO_URL /opt/recruiteros && cd /opt/recruiteros; fi
export WORKER_MAIN_URL=https://recruitersos.co
export WORKER_TOKEN=$TOKEN
export VIDEO_WORKER_CONCURRENCY=2
export ROS_S3_BUCKET=ros-pip-assets
export ROS_S3_ENDPOINT=http://$STORAGE_IP:9000
export ROS_S3_ACCESS_KEY_ID=$APP_KEY
export ROS_S3_SECRET_ACCESS_KEY=$APP_SECRET
export ROS_S3_FORCE_PATH_STYLE=1
bash setup-video-worker.sh
EOF
done

# ── 4) Verify ────────────────────────────────────────────────────────────────
echo "== [4/4] verifying =="
SSH "$STORAGE_IP" "systemctl is-active recruiteros-minio && curl -fsS http://127.0.0.1:9000/minio/health/ready >/dev/null && echo 'minio: healthy'"
for W in $WORKER_IPS; do SSH "$W" "systemctl is-active recruiteros-video-worker >/dev/null && echo 'worker $W: active'"; done
echo "fleet roll-up:  curl -s 'https://recruitersos.co/api/in-market/worker?token=$TOKEN' | head -c 400"
echo
echo "DONE. Record a clip in /pip-studio if you haven't; videos start flowing within ~5 minutes."
echo "Watch progress in the portal (engine_health) — retention shows there too."
