#!/usr/bin/env bash
# JD Sourcing -> OS Text parity monitor (sourcing-parity-monitor.timer, daily).
# Companion to koldinfo-monitor.sh / laxis-monitor.sh.
#
# THE PARITY GUARANTEE (2026-07-20): every recruiting list saved in JD Sourcing
# flows on to Candidates + OS Text by itself (lib/sourcing/autoflow.ts: the
# fresh-window sweeper + the 6h parity backfill lane). This monitor is the
# independent auditor of that guarantee: it reads the saved-run snapshot straight
# off the data volume and alarms when any recruiting list has sat OUT of parity
# for more than a day, which means BOTH sweeper lanes failed and a human needs
# to look. It also alarms if the nightqueue timer (the sweeper's clock) is dead.
#
# Out of parity = any of:
#   - never sent to Candidates/OS Text at all
#   - holds more phone numbers than OS Text was ever given (missed top-up)
#   - parked on a send error (incl. ostext_not_connected: OS Text needs keys)
# each with a full day of no progress (fresh chains legitimately run for hours).
#
# Dependency-free (docker + logger + optional curl). Config: ALERT_WEBHOOK_URL.
set -u

COMPOSE="${RECRUITEROS_COMPOSE:-/opt/recruiteros/docker-compose.yml}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
TAG="sourcing-parity-monitor"

log()  { logger -t "$TAG" "$1"; echo "$(date -u +%FT%TZ) $1"; }
alert() {
  log "ALERT: $1"
  [ -n "$ALERT_WEBHOOK_URL" ] && curl -s -m 8 -H 'content-type: application/json' \
    -d "{\"text\":\"[sourcing-parity] $1\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1
}

# The sweeper only runs when the nightqueue timer ticks GET /api/sourcing/night.
if ! systemctl is-active --quiet recruiteros-nightqueue.timer; then
  alert "CRITICAL: recruiteros-nightqueue.timer is not active - the autoflow sweeper has no clock; saved lists will stop flowing to Candidates/OS Text"
fi

OUT=$(docker compose -f "$COMPOSE" exec -T app node 2>/dev/null <<'NODE'
const fs = require("fs");
const p = "/data/snap_sourcing_runs_v1.json";
if (!fs.existsSync(p)) { console.log("OK no saved lists yet"); process.exit(0); }
const runs = JSON.parse(fs.readFileSync(p, "utf8"));
const now = Date.now(), DAY = 86400000;
const bad = [];
for (const r of runs) {
  if (r.motion === "bd") continue; // BD lists ride the email belt, not OS Text
  if (!Array.isArray(r.candidates) || !r.candidates.length) continue;
  const phones = r.candidates.filter((c) => c.phone).length;
  const af = r.autoflow || {};
  const touched = Date.parse(r.updatedAt) || 0;
  if (now - touched < DAY) continue; // in-flight chains get a full day of grace
  const idleH = Math.round((now - touched) / 3600000);
  if (!af.sentAt) {
    bad.push(`"${r.name}": never sent (${r.candidates.length} candidates, ${phones} phones, idle ${idleH}h)`);
  } else if (phones > (af.phonesAtSend || 0)) {
    bad.push(`"${r.name}": ${phones - (af.phonesAtSend || 0)} phone(s) OS Text never got (idle ${idleH}h)`);
  } else if (af.error) {
    bad.push(`"${r.name}": parked on error "${String(af.error).slice(0, 90)}" (idle ${idleH}h)`);
  }
}
if (bad.length) {
  console.log(`PARITY-FAIL ${bad.length} list(s) stranded out of OS Text:`);
  for (const b of bad) console.log("  - " + b);
  process.exit(0); // verdict rides stdout; the shell decides the exit code
}
console.log(`OK all ${runs.length} saved list(s) in OS Text parity`);
NODE
)
[ -z "$OUT" ] && OUT="FAIL: could not read the saved-run snapshot (app container down?)"

echo "$OUT" | while IFS= read -r line; do log "$line"; done

case "$OUT" in
  OK*) exit 0 ;;
  PARITY-FAIL*)
    alert "CRITICAL: $(echo "$OUT" | head -1) - both sweeper lanes failed for over a day; check 'docker compose logs app | grep sourcing-autoflow' on ros"
    exit 2 ;;
  *)
    alert "CRITICAL: parity audit could not run: $(echo "$OUT" | head -1)"
    exit 2 ;;
esac
