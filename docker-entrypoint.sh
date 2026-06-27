#!/bin/sh
# RecruitersOS · container entrypoint
#
# FREE egress IP spread for the Hire Signals people-finder. Assigns a block of
# addresses from our routed IPv6 /64 to this container, so the free-source
# scrapers/namers (lib/net/egress.ts) round-robin their OUTBOUND requests across
# many source IPs instead of all sharing the single Docker-NAT IP — which is what
# rate-limited the finder down to a trickle. Each address is a REAL owned address
# on eth0 (not AnyIP), so replies route back normally.
#
# Completely no-op unless EGRESS_V6_BASE is set, so normal boots are unaffected.
if [ -n "$EGRESS_V6_BASE" ]; then
  n=${EGRESS_V6_COUNT:-64}
  i=1
  while [ "$i" -le "$n" ]; do
    ip -6 addr add "${EGRESS_V6_BASE}$(printf '%x' "$i")/80" dev eth0 nodad 2>/dev/null || true
    i=$((i + 1))
  done
fi

exec "$@"
