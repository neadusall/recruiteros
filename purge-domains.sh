#!/usr/bin/env bash
#
# One-shot: evict the 921 wrong-company verdicts from the domain-resolver cache, then restart the
# app so it rehydrates from the purged file.
#
# WHY A SCRIPT: the two steps must happen together. The running app holds the cache in memory and
# re-saves it (CLAUDE.md hydration trap), so writing the file without a restart is a no-op within
# minutes. Both steps run under the SAME app-swap lock auto-deploy.sh uses, so this can never race
# a deploy's container swap (the 2026-07-20 outage).
set -euo pipefail
cd /opt/recruiteros

SWAP_LOCK=/var/lock/recruiteros-app-swap.lock
TOOL=/opt/recruiteros/tools/purge-bad-domains.mjs

[ -f "$TOOL" ] || { echo "FATAL: $TOOL is missing (a git reset wiped it). Re-copy it and retry."; exit 1; }

echo "==> taking the app-swap lock"
flock -x -w 300 "$SWAP_LOCK" bash -s <<'INNER'
set -euo pipefail
cd /opt/recruiteros

echo "==> purging poisoned domain verdicts"
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  --entrypoint node recruiteros-app /tools/purge-bad-domains.mjs --write | tail -5

# MUST be `restart`, NOT `up -d` (bug hit 2026-08-21). `docker compose up -d` is a NO-OP when the
# container spec is unchanged: it prints "Container recruiteros-app-1 Running" and leaves the
# process alone. The app therefore kept its OLD in-memory cache and would have written all 921 bad
# verdicts straight back over the purged file on its next save. `restart` actually cycles the
# process, which is the whole point of this step. Verify with .State.StartedAt AFTER the purge time,
# never by trusting the compose output.
echo "==> restarting app so it rehydrates the purged cache"
docker compose restart app 2>&1 | tail -3
INNER

# Health probe goes through the edge, NOT http://localhost:3000: port 3000 is not published on the
# host (the app is only reachable on the docker network, behind Caddy), so a localhost probe answers
# 000 forever and reads like an outage when nothing is wrong.
echo "==> waiting for health"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://app.lumesp.com/api/health || true)
  if [ "$code" = "200" ]; then echo "health OK after ${i} checks"; break; fi
  [ "$i" = "30" ] && echo "WARNING: still ${code} after 90s — check 'docker ps -a --filter name=recruiteros-app'"
  sleep 3
done

echo "==> verifying the purge stuck"
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  --entrypoint node recruiteros-app /tools/purge-bad-domains.mjs | head -3

echo "==> done"
