#!/usr/bin/env bash
#
# RecruitersOS · Self-hosted VIDEO STORAGE setup (MinIO on your own box)
#
# Turns a spare server (e.g. an idle Hetzner box with a big disk) into the S3-compatible object
# store the video pipeline publishes to and serves from — instead of paying for R2/Hetzner Object
# Storage. One box with ~2 TB of disk comfortably holds the 30-day working set at 3–5K videos/day
# (150–170K live composites ≈ 1.2–1.4 TB), and the retention sweeper keeps it flat forever.
#
# Run ON the storage box (Ubuntu/Debian, as root). No repo checkout needed — this file is
# self-contained; scp it over and run:
#   MINIO_DATA_DIR=/data/minio \
#   FLEET_IPS="1.2.3.4 5.6.7.8" \        # main + every worker box (locks the API to the fleet)
#   bash setup-minio.sh
#
# Optional env:
#   MINIO_DATA_DIR   where objects live (default /data/minio) — put this on the BIG disk
#   BUCKET           bucket name (default ros-pip-assets)
#   RETENTION_DAYS   belt-and-braces bucket lifecycle on videos/ (default 30; the app-level
#                    sweeper INMARKET_RETENTION=1 is the primary mechanism — this is the backstop
#                    that keeps the disk flat even if the app tick is ever off)
#   FLEET_IPS        space-separated IPs allowed to reach port 9000 (ufw). Unset = no firewall
#                    change (do it yourself — do NOT leave 9000 open to the world).
#
# Idempotent: safe to re-run (keeps existing credentials).
set -uo pipefail

DATA_DIR="${MINIO_DATA_DIR:-/data/minio}"
BUCKET="${BUCKET:-ros-pip-assets}"
DAYS="${RETENTION_DAYS:-30}"
ENVF="/etc/recruiteros-minio.env"
BIN=/usr/local/bin

# 0) Disk sanity — the 30-day working set needs room to breathe.
mkdir -p "$DATA_DIR"
FREE_GB=$(df -BG --output=avail "$DATA_DIR" | tail -1 | tr -dc '0-9')
echo "[minio-setup] data dir $DATA_DIR — ${FREE_GB}GB free"
if [ "${FREE_GB:-0}" -lt 1500 ]; then
  echo "[minio-setup] WARNING: <1.5TB free. At 3K videos/day × 30-day retention you need ~1.2–1.4TB."
  echo "               Point MINIO_DATA_DIR at the big disk, or lower INMARKET_RETENTION_DAYS."
fi

# 1) MinIO server + mc client (single static binaries).
if [ ! -x "$BIN/minio" ]; then
  echo "[minio-setup] installing minio..."
  curl -fsSL -o "$BIN/minio" https://dl.min.io/server/minio/release/linux-amd64/minio && chmod +x "$BIN/minio"
fi
if [ ! -x "$BIN/mc" ]; then
  echo "[minio-setup] installing mc..."
  curl -fsSL -o "$BIN/mc" https://dl.min.io/client/mc/release/linux-amd64/mc && chmod +x "$BIN/mc"
fi
[ -x "$BIN/minio" ] && [ -x "$BIN/mc" ] || { echo "ERROR: minio/mc download failed."; exit 1; }

# 2) Credentials — generated once, kept across re-runs (0600).
if [ ! -f "$ENVF" ]; then
  ROOT_USER="ros-admin"
  ROOT_PASS="$(openssl rand -hex 20)"
  APP_USER="ros-video"
  APP_PASS="$(openssl rand -hex 20)"
  cat > "$ENVF" <<EOF
MINIO_ROOT_USER=$ROOT_USER
MINIO_ROOT_PASSWORD=$ROOT_PASS
MINIO_VOLUMES=$DATA_DIR
# Scoped app credentials (what the RecruitersOS main + workers use — NOT the root pair):
APP_ACCESS_KEY=$APP_USER
APP_SECRET_KEY=$APP_PASS
EOF
  chmod 600 "$ENVF"
fi
# shellcheck disable=SC1090
. "$ENVF"

# 3) Dedicated user + systemd unit.
id -u minio-user >/dev/null 2>&1 || useradd -r -s /sbin/nologin minio-user
chown -R minio-user:minio-user "$DATA_DIR"
cat > /etc/systemd/system/recruiteros-minio.service <<EOF
[Unit]
Description=RecruitersOS MinIO object storage (video pipeline)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=minio-user
Group=minio-user
EnvironmentFile=$ENVF
ExecStart=$BIN/minio server $DATA_DIR --address :9000 --console-address :9001
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now recruiteros-minio.service

# 4) Wait until the API answers, then create the bucket + a least-privilege app user.
echo "[minio-setup] waiting for MinIO to come up..."
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:9000/minio/health/ready >/dev/null 2>&1 && break; sleep 1; done
"$BIN/mc" alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
"$BIN/mc" mb --ignore-existing "local/$BUCKET" >/dev/null

cat > /tmp/ros-video-policy.json <<EOF
{ "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::$BUCKET/*"] },
    { "Effect": "Allow",
      "Action": ["s3:ListBucket","s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::$BUCKET"] }
  ] }
EOF
"$BIN/mc" admin policy create local ros-video-rw /tmp/ros-video-policy.json >/dev/null 2>&1 || true
"$BIN/mc" admin user add local "$APP_ACCESS_KEY" "$APP_SECRET_KEY" >/dev/null 2>&1 || true
"$BIN/mc" admin policy attach local ros-video-rw --user "$APP_ACCESS_KEY" >/dev/null 2>&1 || true
rm -f /tmp/ros-video-policy.json

# 5) Belt-and-braces lifecycle: expire videos/ after $DAYS days even if the app sweeper is off.
#    (clips/ — the operator's few source recordings — is deliberately NOT expired.)
"$BIN/mc" ilm rule add "local/$BUCKET" --expire-days "$DAYS" --prefix "videos/" >/dev/null 2>&1 \
  || "$BIN/mc" ilm add --expiry-days "$DAYS" --prefix "videos/" "local/$BUCKET" >/dev/null 2>&1 \
  || echo "[minio-setup] (couldn't add the lifecycle rule — the app-level sweeper still handles retention)"

# 6) Lock the API to the fleet when FLEET_IPS is given.
if [ -n "${FLEET_IPS:-}" ] && command -v ufw >/dev/null 2>&1; then
  for ip in $FLEET_IPS; do ufw allow from "$ip" to any port 9000 proto tcp >/dev/null; done
  ufw deny 9000/tcp >/dev/null 2>&1 || true
  ufw deny 9001/tcp >/dev/null 2>&1 || true
  echo "[minio-setup] ufw: port 9000 restricted to: $FLEET_IPS (console 9001 blocked — tunnel in to use it)"
else
  echo "[minio-setup] NOTE: no FLEET_IPS given — firewall NOT changed. Restrict port 9000 to the"
  echo "              main + worker IPs yourself; never leave it open to the internet."
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "[minio-setup] DONE. Paste this ROS_S3_* block into the MAIN's env AND every worker's env"
echo "              (setup-video-worker.sh reads the same variables):"
echo
echo "  ROS_S3_BUCKET=$BUCKET"
echo "  ROS_S3_ENDPOINT=http://$IP:9000"
echo "  ROS_S3_ACCESS_KEY_ID=$APP_ACCESS_KEY"
echo "  ROS_S3_SECRET_ACCESS_KEY=$APP_SECRET_KEY"
echo "  ROS_S3_FORCE_PATH_STYLE=1"
echo
echo "[minio-setup] credentials live in $ENVF (0600). Console: ssh -L 9001:127.0.0.1:9001 → http://localhost:9001"
