#!/usr/bin/env bash
#
# RecruitersOS auto-deploy watcher.
# Checks GitHub for new commits on main; if found, pulls and redeploys.
# Designed to run every couple minutes via a systemd timer (see install below).
# Safe to run repeatedly: it does nothing when there is no new commit.
set -euo pipefail

# Resolve the repo dir from this script's own location, so the watcher works no
# matter what the checkout is named (/opt/recruitersos, /opt/recruiteros, …).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/var/log/recruiteros-deploy.log"
BRANCH="main"

cd "$DIR" || { echo "$(date -u) no $DIR" >> "$LOG"; exit 0; }

# SERIALIZE every run of this script (systemd tick, manual invocation, anything)
# behind one lock. Root cause of the 2026-07-20 OS Text outage: rapid-fire
# pushes caused overlapping `docker compose up` recreates, and a recreate that
# loses that race strands the service as a stopped "Created" duplicate with no
# running container. The OS Text watchdog takes this same lock, so recovery and
# deploy can never fight over compose either. Wait up to 5 min for the previous
# run, then yield to the next timer tick.
exec 9>/var/lock/recruiteros-deploy.lock
flock -w 300 9 || { echo "$(date -u) another deploy still running after 5 min wait, yielding" >> "$LOG"; exit 0; }

# One-time: MIGRATE persistence off Postgres onto the durable /data file volume.
# The app now snapshots accounts/sessions to /data (the app_data named volume),
# which survives every redeploy with no password to sync — see lib/db mode().
# Older installs still carry a `DATABASE_URL=...@db:5432/recruiteros` line in
# .env.production that used to force the fragile pg backend (and enable-db.sh
# even did `docker volume rm pg_data`, wiping every account on deploy). Strip
# that line ONCE so the app can never be flipped back onto Postgres. OS Text's own
# DATABASE_URL lives in money-maker-sms/.env.production and is left untouched.
if [ ! -f "$DIR/.file-persistence-v1" ]; then
  echo "$(date -u) one-time: migrating to /data file persistence (strip stale DATABASE_URL)..." >> "$LOG"
  if [ -f "$DIR/.env.production" ] && grep -q '^DATABASE_URL=' "$DIR/.env.production"; then
    grep -v '^DATABASE_URL=' "$DIR/.env.production" > "$DIR/.env.production.tmp" \
      && mv "$DIR/.env.production.tmp" "$DIR/.env.production" \
      && chmod 600 "$DIR/.env.production"
    echo "$(date -u) removed stale DATABASE_URL from .env.production" >> "$LOG"
    docker compose up -d --force-recreate app >> "$LOG" 2>&1 || true
  fi
  touch "$DIR/.file-persistence-v1"
  echo "$(date -u) file persistence active" >> "$LOG"
fi

# One-time: force-recreate the app + caddy so they pick up the CURRENT compose
# config that a plain `up -d --build` can miss on a long-lived container — the
# app's `environment:` block (ROS_DATA_DIR=/data + the app_data volume mount,
# WHITE_LABEL_CNAME_TARGET, OWNER_EMAIL, RESEND_API_KEY, …) AND Caddy's
# bind-mounted Caddyfile (the white-label on-demand-TLS catch-all). Without this,
# accounts kept getting wiped on deploy and custom domains never got a cert.
# Marker-guarded (runs exactly once), same pattern as the DB step above, and
# placed before the up-to-date early-exit so it runs even with no new commit.
#
# v2: the v1 marker fired on an OLDER compose that predated the app_data:/data
# volume mount, so the running container still writes /data to EPHEMERAL container
# storage (wiped every redeploy — /api/health showed dataDirMounted:false). Bumping
# the marker re-applies the CURRENT compose so /data becomes the durable app_data
# volume and the Hire Signals pool (+ accounts/sessions) finally persist + compound.
if [ ! -f "$DIR/.edge-recreate-v2" ]; then
  echo "$(date -u) one-time(v2): force-recreate app+caddy to mount durable /data volume..." >> "$LOG"
  if docker compose up -d --force-recreate app caddy >> "$LOG" 2>&1; then
    touch "$DIR/.edge-recreate-v2"
    echo "$(date -u) app+caddy recreated with app_data:/data — persistence now durable" >> "$LOG"
  else
    echo "$(date -u) edge recreate(v2) failed, will retry next cycle" >> "$LOG"
  fi
fi

# One-time: set up the free IPv6 /64 egress rotation so the Hire Signals scraper (DuckDuckGo/Bing
# naming, team pages, news) can spread across dozens of source IPs and run hard WITHOUT getting
# rate-limited. Self-detecting + idempotent (see setup-egress.sh); persists via its own systemd
# unit. Marker-guarded so it runs exactly once. Bump the marker to re-run after changing COUNT.
if [ ! -f "$DIR/.egress-setup-v1" ] && [ -f "$DIR/setup-egress.sh" ]; then
  echo "$(date -u) one-time: configuring IPv6 /64 egress rotation for the scraper..." >> "$LOG"
  if bash "$DIR/setup-egress.sh" 64 >> "$LOG" 2>&1; then
    touch "$DIR/.egress-setup-v1"
    echo "$(date -u) egress rotation configured" >> "$LOG"
  else
    echo "$(date -u) egress setup failed, will retry next cycle" >> "$LOG"
  fi
fi

# v2: WIDEN the rotation to the free max (256 source IPs from the same /64). The search-naming
# scraper now retries throttled queries on a fresh IP (see searchEngines), so a bigger pool means
# fewer dead-ends under the thousands-of-queries/day load. Free — same /64, all addresses already
# bindable via the local route. Marker-guarded; bump the marker to re-tune.
if [ ! -f "$DIR/.egress-setup-v2" ] && [ -f "$DIR/setup-egress.sh" ]; then
  echo "$(date -u) one-time(v2): widening egress rotation to 256 IPs..." >> "$LOG"
  if bash "$DIR/setup-egress.sh" 256 >> "$LOG" 2>&1; then
    touch "$DIR/.egress-setup-v2"
    echo "$(date -u) egress rotation widened to 256 source IPs" >> "$LOG"
  else
    echo "$(date -u) egress widen(v2) failed, will retry next cycle" >> "$LOG"
  fi
fi

# One-time: hard-restart Caddy so the current Caddyfile definitely loads (the
# graceful `caddy reload` path proved unreliable on this box; a restart is
# ~1s and deterministic). Marker-guarded; runs even with no new commit.
if [ ! -f "$DIR/.caddy-restart-v1" ]; then
  echo "$(date -u) one-time: hard caddy restart to load current Caddyfile..." >> "$LOG"
  if docker compose restart caddy >> "$LOG" 2>&1; then
    touch "$DIR/.caddy-restart-v1"
    echo "$(date -u) caddy restarted with current config" >> "$LOG"
  else
    echo "$(date -u) caddy restart failed, will retry next cycle" >> "$LOG"
  fi
fi

# One-time: wire the OS Text single sign-on token into the portal env.
# deploy.sh section 4c does this, but this watcher never runs deploy.sh, so a
# box deployed before the token wiring never got RECRUITEROS_OSTEXT_TOKEN and
# the OS Text panel showed the engine's own email login instead of signing the
# user straight in. Copies the engine's ACCESS_TOKEN and recreates the app so
# the env change takes effect. Marker-guarded.
if [ ! -f "$DIR/.ostext-token-sync-v1" ] && [ -f "$DIR/money-maker-sms/.env.production" ]; then
  TX_TOKEN="$(grep -E '^ACCESS_TOKEN=' "$DIR/money-maker-sms/.env.production" | head -1 | cut -d= -f2- || true)"
  if [ -n "${TX_TOKEN:-}" ]; then
    echo "$(date -u) one-time: syncing OS Text SSO token into .env.production..." >> "$LOG"
    if grep -q '^RECRUITEROS_OSTEXT_TOKEN=' "$DIR/.env.production"; then
      sed -i "s|^RECRUITEROS_OSTEXT_TOKEN=.*|RECRUITEROS_OSTEXT_TOKEN=${TX_TOKEN}|" "$DIR/.env.production"
    else
      echo "RECRUITEROS_OSTEXT_TOKEN=${TX_TOKEN}" >> "$DIR/.env.production"
    fi
    if docker compose up -d --force-recreate app >> "$LOG" 2>&1; then
      touch "$DIR/.ostext-token-sync-v1"
      echo "$(date -u) OS Text SSO token synced; app recreated" >> "$LOG"
    else
      echo "$(date -u) app recreate failed after token sync, will retry next cycle" >> "$LOG"
    fi
  else
    echo "$(date -u) token sync waiting: engine ACCESS_TOKEN not found yet" >> "$LOG"
  fi
fi

# ------------------------------------------------------------------------------
# NEVER-DOWN FAIL-SAFE (2026-07-20: "OS Text is not showing"). A deploy killed
# mid-recreate leaves a service as a stopped "Created" duplicate with NO running
# container (docker's failed-recreate artifact; lume-jobs died 137 the same way).
# Autoheal cannot see that state (it only restarts running-but-unhealthy), and
# this watcher used to early-exit when there was no new commit, so the OS Text
# engine stayed dark until the NEXT push. This block runs on EVERY 2-minute tick,
# BEFORE the up-to-date early-exit: any core service with no running container
# is revived from its EXISTING image (--no-build: the old version up always beats
# a broken build keeping it down), clearing stuck Created duplicates first.
# Never fatal.
for SVC in taltxt lume-jobs app db caddy searxng; do
  if [ -z "$(docker compose ps -q --status running "$SVC" 2>/dev/null)" ]; then
    echo "$(date -u) FAIL-SAFE: $SVC has no running container, reviving from existing image..." >> "$LOG"
    docker ps -aq --filter "name=${SVC}" --filter status=created | xargs -r docker rm -f >> "$LOG" 2>&1 || true
    if docker compose up -d --no-build --no-deps "$SVC" >> "$LOG" 2>&1; then
      echo "$(date -u) FAIL-SAFE: $SVC revived" >> "$LOG"
    else
      echo "$(date -u) FAIL-SAFE: $SVC revive failed, will retry next tick" >> "$LOG"
    fi
  fi
done

# Deeper OS Text probe: the engine can be "running" yet unreachable through the
# edge (stale Caddy config mount, wedged process the healthcheck misses). Probe
# the REAL serving path recruiters use; any app-level answer (2xx/3xx/401/403)
# counts as alive. On failure restart the engine then force-recreate Caddy, but
# at most once per 10 minutes so a genuinely broken engine cannot restart-flap.
OSTEXT_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -k \
  --resolve recruitersos.co:443:127.0.0.1 https://recruitersos.co/ostext-app/ || echo 000)
case "$OSTEXT_CODE" in
  2*|3*|401|403) : ;;
  *)
    STAMP="$DIR/.ostext-probe-restart"
    if [ -z "$(find "$STAMP" -mmin -10 2>/dev/null)" ]; then
      touch "$STAMP"
      echo "$(date -u) FAIL-SAFE: /ostext-app probe got $OSTEXT_CODE, restarting engine + caddy..." >> "$LOG"
      docker compose restart taltxt >> "$LOG" 2>&1 || true
      docker compose up -d --force-recreate caddy >> "$LOG" 2>&1 || true
    else
      echo "$(date -u) FAIL-SAFE: /ostext-app probe got $OSTEXT_CODE (restart cooldown active)" >> "$LOG"
    fi
    ;;
esac

# One-time: install the standalone OS Text watchdog (systemd timer, every 3 min).
# Second, independent layer: if a future commit ever breaks THIS script (syntax
# error, bad merge), the deploy timer dies silently and the in-script fail-safe
# above dies with it. The watchdog lives OUTSIDE the git checkout
# (/usr/local/bin) so no push can take it down. Marker-guarded.
if [ ! -f "$DIR/.ostext-watchdog-v1" ] && [ -f "$DIR/ostext-watchdog.sh" ]; then
  echo "$(date -u) one-time: installing standalone OS Text watchdog..." >> "$LOG"
  if install -m 755 "$DIR/ostext-watchdog.sh" /usr/local/bin/ostext-watchdog.sh \
     && printf '%s\n' '[Unit]' 'Description=OS Text never-down watchdog' \
          '[Service]' 'Type=oneshot' 'ExecStart=/usr/local/bin/ostext-watchdog.sh' \
          > /etc/systemd/system/ostext-watchdog.service \
     && printf '%s\n' '[Unit]' 'Description=Run OS Text watchdog every 3 minutes' \
          '[Timer]' 'OnBootSec=2min' 'OnUnitActiveSec=3min' '[Install]' 'WantedBy=timers.target' \
          > /etc/systemd/system/ostext-watchdog.timer \
     && systemctl daemon-reload && systemctl enable --now ostext-watchdog.timer >> "$LOG" 2>&1; then
    touch "$DIR/.ostext-watchdog-v1"
    echo "$(date -u) OS Text watchdog installed and armed" >> "$LOG"
  else
    echo "$(date -u) OS Text watchdog install failed, will retry next cycle" >> "$LOG"
  fi
fi

# Fetch quietly; compare local vs remote.
git fetch origin "$BRANCH" --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

# Up to date AND the one-time OS Text cutover (below) already ran -> nothing to
# do. With the cutover marker missing we fall through even on no new commit, so
# the cutover can run on a box whose checkout is already current.
if [ "$LOCAL" = "$REMOTE" ] && [ -f "$DIR/.ostext-cutover-v1" ]; then
  exit 0
fi

echo "$(date -u) new commit $REMOTE (was $LOCAL), deploying..." >> "$LOG"
git reset --hard "origin/$BRANCH" >> "$LOG" 2>&1
# Pull/checkout submodules (OS Text lives in money-maker-sms). reset
# --hard does NOT touch submodule working trees. TOLERATE failure (e.g. a private
# submodule the server can't clone) — it must NEVER block the main app deploy.
git submodule sync --recursive >> "$LOG" 2>&1 || true
git submodule update --init --recursive >> "$LOG" 2>&1 || echo "$(date -u) submodule update failed — OS Text may be skipped" >> "$LOG"
# Deploy. Try the full stack; if any service (e.g. the `taltxt` OS Text service) fails to build, fall
# back to (re)building just the core app + db + caddy so app updates ALWAYS ship.
if docker compose up -d --build >> "$LOG" 2>&1; then
  echo "$(date -u) deploy complete (full stack)" >> "$LOG"
else
  echo "$(date -u) full build failed — deploying core only (skipping the OS Text service)" >> "$LOG"
  docker compose up -d --build --no-deps app >> "$LOG" 2>&1 || true
  docker compose up -d --no-deps db caddy >> "$LOG" 2>&1 || true
  # A failed full build must NEVER leave OS Text (or lume-jobs) dark: bring both
  # back up on their existing images (no build) so the old version keeps serving.
  docker compose up -d --no-build --no-deps taltxt lume-jobs >> "$LOG" 2>&1 || true
  echo "$(date -u) deploy complete (core only, side services on previous images)" >> "$LOG"
fi

# Apply Caddy's bind-mounted config after every deploy. TRAP (bit us 2026-07-16,
# the deploy-resilience Caddyfile change silently never loaded): the Caddyfile is
# a SINGLE-FILE bind mount, and `git reset --hard` replaces the file with a NEW
# inode, so the running container keeps reading the OLD blob forever — a graceful
# `caddy reload` inside the container just re-reads the stale mount and reports
# success. So compare the container's view of the file with the repo's: if they
# differ the mount is stale and only a force-recreate re-binds it (~1s of edge
# downtime); if they match, a zero-downtime graceful reload is enough. Never fatal.
if docker compose exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - "$DIR/Caddyfile"; then
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >> "$LOG" 2>&1 \
    || docker compose restart caddy >> "$LOG" 2>&1 || true
else
  echo "$(date -u) Caddyfile mount is stale (single-file bind-mount inode trap), force-recreating caddy..." >> "$LOG"
  docker compose up -d --force-recreate caddy >> "$LOG" 2>&1 \
    || docker compose restart caddy >> "$LOG" 2>&1 || true
fi

# One-time: OS Text cutover (same-origin /ostext-app + portal-matched skin).
# The engine container had been running a stale build on this box, so force a
# from-scratch rebuild ONCE, then reload Caddy again for the /ostext-app routes.
# Marker-guarded; bump the marker name to force another engine rebuild later.
if [ ! -f "$DIR/.ostext-cutover-v1" ]; then
  echo "$(date -u) one-time: OS Text cutover (forced engine rebuild)..." >> "$LOG"
  git submodule sync --recursive >> "$LOG" 2>&1 || true
  if git submodule update --init --force money-maker-sms >> "$LOG" 2>&1 \
     && docker compose build --no-cache taltxt >> "$LOG" 2>&1 \
     && docker compose up -d taltxt >> "$LOG" 2>&1; then
    docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >> "$LOG" 2>&1 \
      || docker compose restart caddy >> "$LOG" 2>&1 || true
    touch "$DIR/.ostext-cutover-v1"
    echo "$(date -u) OS Text cutover complete (engine $(git -C money-maker-sms rev-parse --short HEAD 2>/dev/null || echo unknown))" >> "$LOG"
  else
    echo "$(date -u) OS Text cutover failed, will retry next cycle" >> "$LOG"
  fi
fi
