#!/usr/bin/env bash
#
# RecruitersOS · IPv6 /64 egress rotation setup (free Hire Signals scraping at scale)
#
# Hetzner routes a free IPv6 /64 to every box. This makes the WHOLE /64 locally bindable so the
# engine can rotate outbound free-source requests (DuckDuckGo/Bing naming, team pages, news) across
# dozens of source IPs — which is what keeps the scraping sustainable (never rate-limited) while we
# run it hard. Idempotent + self-detecting: safe to run repeatedly. Persists across reboots via a
# systemd unit + a sysctl drop-in, writes the INMARKET_EGRESS_IPV6_* env, and recreates the app.
#
# Run on the server (or auto-run by auto-deploy.sh):  bash /opt/recruiteros/setup-egress.sh [COUNT]
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNT="${1:-64}"                                   # source IPs to rotate across (egress caps at 256)
IP_BIN="$(command -v ip || echo /usr/sbin/ip)"
SYSCTL_BIN="$(command -v sysctl || echo /usr/sbin/sysctl)"

# 1) Detect the global IPv6 /64 prefix (first global, non-link-local address on the box).
ADDR="$("$IP_BIN" -6 -o addr show scope global 2>/dev/null | awk '{print $4}' | grep -v '^fe80' | head -1)"
if [ -z "$ADDR" ]; then
  echo "No global IPv6 found — egress rotation needs the free Hetzner IPv6 /64. Skipping (the engine still runs on the default route)."
  exit 0
fi
IPADDR="${ADDR%/*}"
PREFIX="$(echo "$IPADDR" | awk -F: '{print $1":"$2":"$3":"$4}')"   # first 4 hextets = the /64
BASE="${PREFIX}::"
echo "Detected IPv6 /64: ${PREFIX}::/64  → rotating ${COUNT} source IPs"

# 2) Apply NOW: route the whole /64 to loopback (all addresses bindable) + allow non-local bind.
"$IP_BIN" route replace local "${PREFIX}::/64" dev lo 2>/dev/null || true
"$SYSCTL_BIN" -w net.ipv6.ip_nonlocal_bind=1 >/dev/null 2>&1 || true

# 3) Persist across reboots — a sysctl drop-in + a oneshot systemd unit that re-applies the route.
echo "net.ipv6.ip_nonlocal_bind=1" > /etc/sysctl.d/99-recruiteros-egress.conf 2>/dev/null || true
cat > /etc/systemd/system/recruiteros-egress.service <<EOF
[Unit]
Description=RecruitersOS egress IPv6 /64 bind (Hire Signals scraper rotation)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$IP_BIN route replace local ${PREFIX}::/64 dev lo
ExecStart=$SYSCTL_BIN -w net.ipv6.ip_nonlocal_bind=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload 2>/dev/null || true
systemctl enable --now recruiteros-egress.service >/dev/null 2>&1 || true

# 4) Write the env the app reads (idempotent — never duplicates lines).
ENVF="$DIR/.env.production"
touch "$ENVF"
grep -q '^INMARKET_EGRESS_IPV6_BASE='  "$ENVF" || echo "INMARKET_EGRESS_IPV6_BASE=${BASE}"   >> "$ENVF"
grep -q '^INMARKET_EGRESS_IPV6_COUNT=' "$ENVF" || echo "INMARKET_EGRESS_IPV6_COUNT=${COUNT}" >> "$ENVF"
chmod 600 "$ENVF" 2>/dev/null || true

# 5) Recreate the app so it picks up the env and starts rotating.
( cd "$DIR" && docker compose up -d --force-recreate app >/dev/null 2>&1 ) || true

echo "Egress rotation ACTIVE: ${COUNT} IPv6 sources from ${PREFIX}::/64 — survives reboots, scraping runs hard + safe."
