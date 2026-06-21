#!/usr/bin/env bash
#
# RecruitersOS · Distributed RESEARCH WORKER setup
#
# Turns a fresh cheap box (Hetzner CX/CPX, ~$5-40/mo) into a research worker: it scrapes decision-
# makers with ITS OWN IP / free IPv6 /64 (its own Common-Crawl / news / team-page quota) and pushes
# results to your main server. N workers ≈ N× the free throughput → the path to 5K/day.
#
# Run on the worker box, FROM the checked-out repo root:
#   WORKER_MAIN_URL=https://recruitersos.co WORKER_TOKEN=<token> bash setup-worker.sh
#
# (WORKER_TOKEN must equal INMARKET_WORKER_TOKEN on the main server.) Idempotent: safe to re-run.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_URL="${WORKER_MAIN_URL:-}"
TOKEN="${WORKER_TOKEN:-}"
BATCH="${WORKER_BATCH:-120}"
CONCURRENCY="${WORKER_CONCURRENCY:-6}"   # sustainable default (~85% headroom; raise on bigger boxes)
HEALTH_PORT="${WORKER_HEALTH_PORT:-8787}"   # local /health endpoint ON by default so the box is observable
HEALTH_TOKEN="${WORKER_HEALTH_TOKEN:-}"     # set one if :$HEALTH_PORT is reachable from outside the box
DATA_DIR="/var/lib/recruiteros-worker"
ENVF="/etc/recruiteros-worker.env"

if [ -z "$MAIN_URL" ] || [ -z "$TOKEN" ]; then
  echo "ERROR: set WORKER_MAIN_URL and WORKER_TOKEN. e.g.:"
  echo "  WORKER_MAIN_URL=https://recruitersos.co WORKER_TOKEN=xxxx bash setup-worker.sh"
  exit 1
fi

# 1) Node.js (install LTS via NodeSource if missing).
if ! command -v node >/dev/null 2>&1; then
  echo "[worker-setup] installing Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - >/dev/null 2>&1 || true
  apt-get install -y nodejs >/dev/null 2>&1 || true
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js install failed — install Node 18+ manually and re-run."; exit 1; }
echo "[worker-setup] node $(node -v)"

# 2) Dependencies (the worker runs via tsx from the integration/ workspace).
echo "[worker-setup] installing dependencies (integration/)..."
( cd "$DIR/integration" && npm install --no-audit --no-fund >/dev/null 2>&1 ) || { echo "ERROR: npm install failed in integration/"; exit 1; }

# 3) Free IPv6 /64 egress rotation for THIS box (its own prefix = its own quota).
if [ -f "$DIR/setup-egress.sh" ]; then
  echo "[worker-setup] configuring this box's IPv6 /64 egress rotation..."
  bash "$DIR/setup-egress.sh" 256 >/dev/null 2>&1 || echo "[worker-setup] (egress setup skipped/failed — worker still runs on the default route)"
fi

# 4) Env file the service reads (0600 — holds the shared token).
mkdir -p "$DATA_DIR"
cat > "$ENVF" <<EOF
WORKER_MAIN_URL=$MAIN_URL
WORKER_TOKEN=$TOKEN
WORKER_BATCH=$BATCH
WORKER_CONCURRENCY=$CONCURRENCY
WORKER_HEALTH_PORT=$HEALTH_PORT
WORKER_HEALTH_TOKEN=$HEALTH_TOKEN
ROS_DATA_DIR=$DATA_DIR
NODE_ENV=production
EOF
# carry the egress env (written by setup-egress.sh into .env.production) into the worker env too.
if [ -f "$DIR/.env.production" ]; then
  grep -E '^INMARKET_EGRESS_IPV6_(BASE|COUNT)=' "$DIR/.env.production" >> "$ENVF" 2>/dev/null || true
fi
# pass through the Common Crawl index-governor knobs if you've tuned them in the environment.
for v in CC_INDEX_CONCURRENCY CC_INDEX_MIN_INTERVAL_MS CC_INDEX_MAX_INTERVAL_MS; do
  if [ -n "${!v:-}" ]; then echo "$v=${!v}" >> "$ENVF"; fi
done
chmod 600 "$ENVF"

# 5) systemd service — auto-restart, survives reboot, logs to journald.
cat > /etc/systemd/system/recruiteros-worker.service <<EOF
[Unit]
Description=RecruitersOS distributed research worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR/integration
EnvironmentFile=$ENVF
ExecStart=$(command -v npx) tsx scripts/research-worker.ts
Restart=always
RestartSec=10
# bounded resources so a worker box stays responsive
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now recruiteros-worker.service >/dev/null 2>&1 || true
sleep 2
echo "[worker-setup] DONE. Worker is live and pulling from $MAIN_URL"
echo "[worker-setup] follow it with:  journalctl -u recruiteros-worker -f"
echo "[worker-setup] health:          curl -s http://127.0.0.1:$HEALTH_PORT/health | head -40"
systemctl --no-pager status recruiteros-worker.service 2>/dev/null | head -6 || true
