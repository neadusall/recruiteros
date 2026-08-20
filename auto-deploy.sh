#!/usr/bin/env bash
#
# RecruitersOS auto-deploy watcher.
# Checks GitHub for new commits on main; if found, pulls and redeploys.
# Designed to run every couple minutes via a systemd timer (see install below).
# Safe to run repeatedly: it does nothing when there is no new commit.
set -euo pipefail

# Resolve the repo dir from this script's own location, so the watcher works no
# matter what the checkout is named (/opt/recruitersos, /opt/recruiteros, …).
DIR="${DEPLOY_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
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

# RUN FROM A SNAPSHOT OF THIS SCRIPT. Further down, this script git-resets its own
# checkout — it rewrites the very file bash is reading, and bash reads a script
# incrementally by byte offset, so a commit that changes this file's length can
# garble every command after the point already read. Re-exec from a copy taken
# under the lock, so a deploy always finishes as the script it started as. The
# lock (fd 9) survives the exec, and DEPLOY_REPO_DIR carries the real checkout.
if [ -z "${DEPLOY_SELF_COPY:-}" ]; then
  export DEPLOY_REPO_DIR="$DIR"
  export DEPLOY_SELF_COPY=1
  if cp "${BASH_SOURCE[0]}" /tmp/recruiteros-auto-deploy.running.sh 2>/dev/null; then
    exec bash /tmp/recruiteros-auto-deploy.running.sh
  fi
  # The copy could not be made: carry on from the original, exactly as before.
  unset DEPLOY_SELF_COPY
fi

# APP-SWAP LOCK. Every cron tick that `docker exec`s into the app container
# (sending-health, engine-health, nightqueue, receipts) holds
# /var/lock/recruiteros-app-swap.lock SHARED for its run: a container recreate
# landing mid-exec kills the tick with SIGKILL/137 (2026-08-05: the
# sending-health WARNING email at 21:00). So every recreate that touches the
# app goes through swap_app(): take that lock EXCLUSIVELY (waits for running
# ticks, max 120s), recreate, release. On timeout swap anyway: a deploy must
# never be blocked by a stuck tick, and the ticks' own retries recover them.
# This is deliberately a SEPARATE lock from recruiteros-deploy.lock: this
# script systemctl-starts some of those very ticks while holding the deploy
# lock, so ticks waiting on the deploy lock would deadlock against it.
SWAP_LOCK=/var/lock/recruiteros-app-swap.lock
swap_app() {
  flock -x -w 120 -E 249 "$SWAP_LOCK" "$@"
  local rc=$?
  if [ "$rc" -eq 249 ]; then
    echo "$(date -u) swap-lock: a tick held it >120s, swapping without the lock (tick retries cover)" >> "$LOG"
    "$@"
    rc=$?
  fi
  return "$rc"
}

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
    swap_app docker compose up -d --force-recreate app >> "$LOG" 2>&1 || true
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
  if swap_app docker compose up -d --force-recreate app caddy >> "$LOG" 2>&1; then
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

# One-time (v2): restart Caddy to load the lumesp.com access-log directive
# (site-visitor intelligence). Same deterministic restart as v1, new marker.
if [ ! -f "$DIR/.caddy-restart-v2" ]; then
  echo "$(date -u) one-time(v2): caddy restart to enable lumesp.com access log..." >> "$LOG"
  if docker compose restart caddy >> "$LOG" 2>&1; then
    touch "$DIR/.caddy-restart-v2"
    echo "$(date -u) caddy restarted, lumesp access log live" >> "$LOG"
  else
    echo "$(date -u) caddy restart(v2) failed, will retry next cycle" >> "$LOG"
  fi
fi

# One-time (v3): restart Caddy to load the app.lumesp.com access-log directive
# (first-party ground truth for watch-page viewers: client IP + user-agent per
# hit, so a "viewer" can always be settled person-vs-scanner from evidence).
# Same deterministic restart as v1/v2, new marker.
if [ ! -f "$DIR/.caddy-restart-v3" ]; then
  echo "$(date -u) one-time(v3): caddy restart to enable app.lumesp.com access log..." >> "$LOG"
  if docker compose restart caddy >> "$LOG" 2>&1; then
    touch "$DIR/.caddy-restart-v3"
    echo "$(date -u) caddy restarted, app.lumesp.com access log live" >> "$LOG"
  else
    echo "$(date -u) caddy restart(v3) failed, will retry next cycle" >> "$LOG"
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
    if swap_app docker compose up -d --force-recreate app >> "$LOG" 2>&1; then
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
    if swap_app docker compose up -d --no-build --no-deps "$SVC" >> "$LOG" 2>&1; then
      echo "$(date -u) FAIL-SAFE: $SVC revived" >> "$LOG"
    else
      echo "$(date -u) FAIL-SAFE: $SVC revive failed, will retry next tick" >> "$LOG"
    fi
  fi
done

# ------------------------------------------------------------------------------
# SUBMODULE CONVERGE (2026-07-27 outage: "OS Text 404"). The money-maker-sms
# checkout silently froze 43 commits behind the superproject's recorded pointer:
# a dirty tracked file (package-lock.json, left by a stray session on the box)
# made every `git submodule update` below fail, and that failure is deliberately
# tolerated so it never blocks the main app deploy. Result: Caddy moved to the
# /ostext-app same-origin scheme while the engine image kept building from
# pre-basePath code, and every request 307-looped. This block runs on EVERY
# tick, BEFORE the up-to-date early-exit: if the checkout is not exactly at the
# recorded commit, stash whatever made it dirty (recoverable, never destroyed),
# force-sync it, and rebuild the engine so the image can never drift from the
# pointer for more than one tick. A prod checkout is a deploy target, not a
# workspace: anything uncommitted in it is drift by definition. Never fatal.
CONVERGE_WANT=$(git ls-tree HEAD money-maker-sms 2>/dev/null | awk '{print $3}')
CONVERGE_HAVE=$(git -C money-maker-sms rev-parse HEAD 2>/dev/null || echo none)
if [ -n "$CONVERGE_WANT" ] && [ "$CONVERGE_WANT" != "$CONVERGE_HAVE" ]; then
  echo "$(date -u) CONVERGE: money-maker-sms checkout at $CONVERGE_HAVE, superproject records $CONVERGE_WANT; forcing sync..." >> "$LOG"
  git -C money-maker-sms stash push --include-untracked -m "auto-converge $(date -u +%Y%m%dT%H%M%S)" >> "$LOG" 2>&1 || true
  git submodule sync -- money-maker-sms >> "$LOG" 2>&1 || true
  if git submodule update --init --force money-maker-sms >> "$LOG" 2>&1 \
     && [ "$(git -C money-maker-sms rev-parse HEAD 2>/dev/null)" = "$CONVERGE_WANT" ]; then
    echo "$(date -u) CONVERGE: checkout synced to $CONVERGE_WANT, rebuilding engine..." >> "$LOG"
    if docker compose build taltxt >> "$LOG" 2>&1 && docker compose up -d --no-deps taltxt >> "$LOG" 2>&1; then
      echo "$(date -u) CONVERGE: engine rebuilt and up on $CONVERGE_WANT" >> "$LOG"
    else
      echo "$(date -u) CONVERGE: engine rebuild failed, previous image keeps serving; will retry next tick" >> "$LOG"
    fi
  else
    echo "$(date -u) CONVERGE FAILED: submodule still not at $CONVERGE_WANT, will retry next tick" >> "$LOG"
  fi
fi

# Deeper OS Text probe, two tiers (upgraded 2026-07-27; the old single probe
# counted ANY 3xx as alive, so a redirect-looping wrong build looked healthy):
#   deep    = /ostext-app/api/health, which ONLY the correct build answers 200
#   shallow = /ostext-app/, any app-level answer (2xx/3xx/401/403)
# deep 200         -> healthy, nothing to do.
# deep!=200 + shallow alive -> WRONG-SERVING: the converge above handles pointer
#   drift, so this means the IMAGE is stale even though the checkout is right
#   (e.g. a skipped rebuild). Rebuild from the current checkout, at most once
#   per 30 minutes so an unfixable build cannot rebuild-flap the box.
# both dark        -> engine restart + Caddy force-recreate (10-min cooldown),
#   same as before.
OSTEXT_DEEP=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -k \
  --resolve recruitersos.co:443:127.0.0.1 https://recruitersos.co/ostext-app/api/health || echo 000)
if [ "$OSTEXT_DEEP" != "200" ]; then
  OSTEXT_CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -k \
    --resolve recruitersos.co:443:127.0.0.1 https://recruitersos.co/ostext-app/ || echo 000)
  case "$OSTEXT_CODE" in
    2*|3*|401|403)
      STAMP="$DIR/.ostext-wrongbuild-rebuild"
      if [ -z "$(find "$STAMP" -mmin -30 2>/dev/null)" ]; then
        touch "$STAMP"
        echo "$(date -u) FAIL-SAFE: health probe got $OSTEXT_DEEP but the path serves ($OSTEXT_CODE): rebuilding engine..." >> "$LOG"
        # Capture the image identity BEFORE the build. `docker compose build` is a
        # cache hit whenever the checkout already matches what is serving, so it
        # returns success in 2-3s having done nothing. This block used to log
        # "engine rebuilt from current checkout" on that no-op and exit happy,
        # which is why a wrong pin looked like a repair-in-progress for 40+ min on
        # 2026-08-07 and ~1.5h on 2026-08-03. A rebuild can only fix a STALE
        # IMAGE; it can never fix a WRONG PIN, and the two need different words.
        IMG_BEFORE=$(docker image inspect -f '{{.Id}}' recruiteros-taltxt:latest 2>/dev/null || echo none)
        if docker compose build taltxt >> "$LOG" 2>&1 && docker compose up -d --no-deps taltxt >> "$LOG" 2>&1; then
          IMG_AFTER=$(docker image inspect -f '{{.Id}}' recruiteros-taltxt:latest 2>/dev/null || echo none)
          sleep 20
          OSTEXT_RECHECK=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -k \
            --resolve recruitersos.co:443:127.0.0.1 https://recruitersos.co/ostext-app/api/health || echo 000)
          if [ "$OSTEXT_RECHECK" = "200" ]; then
            echo "$(date -u) FAIL-SAFE: engine rebuilt and healthy again (health=200)" >> "$LOG"
          elif [ "$IMG_BEFORE" = "$IMG_AFTER" ]; then
            # Nothing was rebuilt and it is still wrong: the image already IS the
            # checkout, so the checkout itself is the wrong build. Name the pin so
            # the log points at the one thing that actually fixes this.
            PIN=$(git ls-tree HEAD money-maker-sms 2>/dev/null | awk '{print $3}')
            echo "$(date -u) FAIL-SAFE: WRONG PIN, not a stale image — rebuild was a cache no-op and health is still $OSTEXT_RECHECK. The engine image already matches the pinned checkout (money-maker-sms ${PIN:-unknown}), so no rebuild can fix this. The pinned build must serve /ostext-app (basePath) to match the edge; repin the submodule and push." >> "$LOG"
          else
            echo "$(date -u) FAIL-SAFE: engine rebuilt to a new image but health is still $OSTEXT_RECHECK, will retry after cooldown" >> "$LOG"
          fi
        else
          echo "$(date -u) FAIL-SAFE: engine rebuild failed, previous image keeps serving" >> "$LOG"
        fi
      else
        echo "$(date -u) FAIL-SAFE: health probe got $OSTEXT_DEEP, serving-but-wrong (rebuild cooldown active)" >> "$LOG"
      fi
      ;;
    *)
      STAMP="$DIR/.ostext-probe-restart"
      if [ -z "$(find "$STAMP" -mmin -10 2>/dev/null)" ]; then
        touch "$STAMP"
        echo "$(date -u) FAIL-SAFE: /ostext-app probe got $OSTEXT_CODE (health $OSTEXT_DEEP), restarting engine + caddy..." >> "$LOG"
        docker compose restart taltxt >> "$LOG" 2>&1 || true
        docker compose up -d --force-recreate caddy >> "$LOG" 2>&1 || true
      else
        echo "$(date -u) FAIL-SAFE: /ostext-app probe got $OSTEXT_CODE (restart cooldown active)" >> "$LOG"
      fi
      ;;
  esac
fi

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

# One-time(v2): reinstall the watchdog with the 2026-07-27 upgrade (deep
# /ostext-app/api/health probe, DOWN vs WRONG-SERVING distinction, submodule
# converge + rebuild escalation, owner-cell SMS on any action). The v1 block
# above only ever runs once, so /usr/local/bin kept the old copy; this bumps it.
# Timer/service files are rewritten idempotently. Marker-guarded.
if [ ! -f "$DIR/.ostext-watchdog-v2" ] && [ -f "$DIR/ostext-watchdog.sh" ] \
   && grep -q 'WRONG-SERVING' "$DIR/ostext-watchdog.sh"; then
  echo "$(date -u) one-time(v2): upgrading standalone OS Text watchdog..." >> "$LOG"
  if install -m 755 "$DIR/ostext-watchdog.sh" /usr/local/bin/ostext-watchdog.sh \
     && printf '%s\n' '[Unit]' 'Description=OS Text never-down watchdog' \
          '[Service]' 'Type=oneshot' 'ExecStart=/usr/local/bin/ostext-watchdog.sh' \
          > /etc/systemd/system/ostext-watchdog.service \
     && printf '%s\n' '[Unit]' 'Description=Run OS Text watchdog every 3 minutes' \
          '[Timer]' 'OnBootSec=2min' 'OnUnitActiveSec=3min' '[Install]' 'WantedBy=timers.target' \
          > /etc/systemd/system/ostext-watchdog.timer \
     && systemctl daemon-reload && systemctl enable --now ostext-watchdog.timer >> "$LOG" 2>&1; then
    touch "$DIR/.ostext-watchdog-v2"
    echo "$(date -u) OS Text watchdog v2 installed and armed" >> "$LOG"
  else
    echo "$(date -u) OS Text watchdog v2 install failed, will retry next cycle" >> "$LOG"
  fi
fi

# ---- ENGINE-HEALTH WATCH CONVERGE (every tick, BEFORE the up-to-date exit) ----
# The hourly engine watch is what turns "Serper silently hit zero and JD Sourcing
# lost 62% of its supply" into an alert. But a watch that can quietly stop is worth
# very little: the failure it exists to catch is exactly the kind nobody notices.
# So this runs on EVERY tick (~2 min), before the no-new-commit early exit, and is
# deliberately placed here rather than in the deploy path — it must converge even
# when nothing is being deployed, which is almost always.
#
# Two independent failure modes, both self-healed:
#   1. unit missing / disabled / not active (fresh box, someone ran systemctl
#      disable, a botched reinstall) -> re-run the installer, which is idempotent.
#   2. unit looks fine but is not actually producing results (container restart
#      loop, cron secret rotated, the route 500ing) -> the success stamp goes
#      stale, so kick the service once. Threshold is 3h against an hourly timer,
#      so a single missed run is tolerated and a real stall is not.
ENGINE_STAMP=/var/lib/recruiteros/engine-health.last
ENGINE_KICK=/var/lib/recruiteros/engine-health.kick
ENGINE_RUNNER=/usr/local/bin/recruiteros-engine-health.sh
# Bump this marker (and the one in the runner heredoc) to force a re-install.
ENGINE_RUNNER_VERSION="engine-health-runner-v3"
stamp_age() { # <file> -> seconds since it was written, or a huge number
  local v; v=$(cat "$1" 2>/dev/null || echo 0)
  case "$v" in (*[!0-9]*|"") v=0 ;; esac
  echo $(( $(date -u +%s) - v ))
}
if [ -x "$DIR/install-engine-health-timer.sh" ]; then
  if ! systemctl is-enabled --quiet recruiteros-engine-health.timer 2>/dev/null \
     || ! systemctl is-active --quiet recruiteros-engine-health.timer 2>/dev/null \
     || ! grep -q "$ENGINE_RUNNER_VERSION" "$ENGINE_RUNNER" 2>/dev/null; then
    # Also covers UPGRADES: an older runner (no success stamp) would otherwise look
    # permanently stale below and get kicked every single tick, which on Serper means
    # burning a paid credit every 2 minutes. Version-check first, kick second.
    echo "$(date -u) CONVERGE: engine-health timer missing/inactive/outdated, reinstalling..." >> "$LOG"
    bash "$DIR/install-engine-health-timer.sh" >> "$LOG" 2>&1 || true
  elif [ "$(stamp_age "$ENGINE_STAMP")" -gt 10800 ] && [ "$(stamp_age "$ENGINE_KICK")" -gt 3600 ]; then
    # Stalled despite a healthy-looking unit (container restart loop, rotated cron
    # secret, route 500ing). Kick it, but at most once an hour so a persistent
    # failure cannot turn into a credit-burning retry storm.
    echo "$(date -u) CONVERGE: engine-health stale >3h, kicking (rate-limited to 1/h)..." >> "$LOG"
    date -u +%s > "$ENGINE_KICK" 2>/dev/null || true
    systemctl start recruiteros-engine-health.service >> "$LOG" 2>&1 || true
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

# QUIET-PERIOD DEBOUNCE (2026-08-20). Build only once a push burst has SETTLED.
#
# Why: this box has TWO cores and a full `next build` saturates them for 10-16 min,
# and the swap at the end REPLACES the app container. The Hire Signals curation tick
# needs ~13 uninterrupted minutes. With several agents/sessions pushing to main
# independently, commits landed every 10-16 min all day, so the engine was killed
# mid-tick every single time and never completed one: `phases: {}` at the 900s
# watchdog, the whole supply pipeline (research, email verify, residual finder,
# company phones) making zero progress for hours.
#
# Building on EVERY commit is what made a burst of N pushes cost N full builds.
# Waiting for the newest commit to be at least DEPLOY_QUIET_SEC old coalesces that
# burst into ONE build, which is the difference between the engine never running and
# running most of the time. Nothing is skipped: the newest commit still ships, just
# once the pushes stop. A deploy already in flight is unaffected (it holds the lock).
#
# Tunable; 0 restores the old build-on-every-commit behaviour. An urgent fix can
# bypass the wait entirely:  touch /opt/recruiteros/.deploy-now
QUIET_SEC="${DEPLOY_QUIET_SEC:-600}"
if [ "$QUIET_SEC" -gt 0 ] && [ ! -f "$DIR/.deploy-now" ]; then
  # Force to a plain integer. An empty/garbled value would make the [ -gt ] test throw
  # "integer expression expected", and under `set -e` that would kill the deploy script
  # outright — a debounce must never be able to stop deploys. Unparseable => 0 => build now.
  COMMIT_TS=$(git log -1 --format=%ct "$REMOTE" 2>/dev/null | head -1 | tr -cd "0-9")
  [ -n "$COMMIT_TS" ] || COMMIT_TS=0
  AGE=$(( $(date +%s) - COMMIT_TS ))
  if [ "$COMMIT_TS" -gt 0 ] && [ "$AGE" -lt "$QUIET_SEC" ]; then
    # Log once per commit, not every 2-min tick, so the log stays readable.
    if [ "$(cat "$DIR/.deploy-waiting" 2>/dev/null)" != "$REMOTE" ]; then
      echo "$(date -u) new commit $REMOTE — holding for the push burst to settle (${QUIET_SEC}s quiet period)" >> "$LOG"
      echo "$REMOTE" > "$DIR/.deploy-waiting"
    fi
    exit 0
  fi
fi
rm -f "$DIR/.deploy-waiting" "$DIR/.deploy-now"

echo "$(date -u) new commit $REMOTE (was $LOCAL), deploying..." >> "$LOG"

# DISK FAIL-SAFE. Every `up -d --build` leaves the previous image dangling (~3GB
# on this stack). Nothing reclaimed them, so a heavy push day quietly ate the
# disk: on 2026-07-31, 31 dangling images took / to 99% (924MB free) and Postgres
# began PANICking in a crash loop — "could not write to file
# pg_logical/replorigin_checkpoint.tmp: No space left on device" — unable to
# checkpoint, which is a data-loss risk for every tenant on the box.
#
# So: reclaim BEFORE building (the build is what needs the room), and refuse to
# build at all if it is still too tight. Refusing costs one deploy cycle; filling
# the disk mid-build costs the database. Dangling-only prune — Docker never
# removes an image a container is using, so running services are untouched.
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
if [ "${FREE_GB:-0}" -lt 20 ]; then
  echo "$(date -u) disk low (${FREE_GB}GB free) — reclaiming before build" >> "$LOG"
  docker image prune -f >> "$LOG" 2>&1 || true
  docker builder prune -f --keep-storage 5GB >> "$LOG" 2>&1 || true
  FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  echo "$(date -u) after reclaim: ${FREE_GB}GB free" >> "$LOG"
fi
if [ "${FREE_GB:-0}" -lt 8 ]; then
  echo "$(date -u) DEPLOY ABORTED: only ${FREE_GB}GB free after reclaim — building would risk the database. Free space on the box." >> "$LOG"
  exit 0
fi

git reset --hard "origin/$BRANCH" >> "$LOG" 2>&1
# Pull/checkout submodules (OS Text lives in money-maker-sms). reset
# --hard does NOT touch submodule working trees. TOLERATE failure (e.g. a private
# submodule the server can't clone) — it must NEVER block the main app deploy.
git submodule sync --recursive >> "$LOG" 2>&1 || true
git submodule update --init --recursive >> "$LOG" 2>&1 || echo "$(date -u) submodule update failed — OS Text may be skipped" >> "$LOG"
# ROLLBACK POINT. Tag whatever app image is currently live as :previous BEFORE we
# build over it, so the health gate below has something to fall back to. On the very
# first run there is no image yet; that is fine, the gate just alerts instead of
# rolling back. Never fatal — a missing tag must not stop a deploy.
APP_IMG_BEFORE="$(docker image inspect recruiteros-app:latest --format '{{.Id}}' 2>/dev/null || echo '')"
if [ -n "$APP_IMG_BEFORE" ]; then
  docker tag recruiteros-app:latest recruiteros-app:previous >> "$LOG" 2>&1 || true
fi

# BUILD FIRST, SWAP SECOND. Building touches nothing that is serving, so it can run
# while recruiters work; the container swap is what kills work in flight. Splitting
# them means the expensive minutes happen up front and the swap lands in the quiet
# window the hold below waits for. Best-effort: if this build fails (or only partly
# succeeds), the deploy logic underneath is unchanged and handles it — this is a
# warm-up, not a gate.
docker compose build >> "$LOG" 2>&1 || true

# HOLD THE SWAP while a candidate search is running. A search is the one job with
# nothing to resume from: enrichment parks job refs and picks up where it left off,
# but a search killed halfway leaves a checkpoint and has to be paid for all over
# again. On 2026-07-31 nine deploys inside one hour ate a recruiter's LinkedIn
# search outright, which is what the crash net (and now this) exists for.
#
# Bounded, and fails OPEN in every unclear case (app down, endpoint missing, no
# answer): a deploy must never be blocked by a probe it cannot read, and the crash
# net still catches whatever the hold does not.
#
# The block between the markers below is executed as-is by the regression test
# (integration/scripts/test-deploy-hold.sh) against a stub docker, so the gate's
# behaviour is pinned rather than assumed. Keep the markers.
# >>> deploy-hold
HOLD_MAX_SEC="${DEPLOY_HOLD_MAX_SEC:-900}"
HOLD_STEP_SEC="${DEPLOY_HOLD_STEP_SEC:-15}"
HOLD_WAITED=0
while [ "$HOLD_WAITED" -lt "$HOLD_MAX_SEC" ]; do
  # The secret is expanded INSIDE the container (single quotes), where it lives —
  # same trick the nightqueue timer uses.
  INFLIGHT="$(docker exec recruiteros-app-1 sh -c 'wget -qO- --timeout=5 "http://localhost:3000/api/sourcing/night?inflight=1&secret=$RECRUITEROS_CRON_SECRET"' 2>/dev/null || echo '')"
  case "$INFLIGHT" in
    *'"busy":true'*) : ;;
    *'"busy":false'*) break ;;
    *)
      # No readable answer (app down mid-deploy, secret unset, endpoint older than
      # this script). Fail open, but SAY SO: a gate that silently stopped gating
      # would otherwise look exactly like a quiet box.
      echo "$(date -u) deploy-gate: no readable in-flight answer, swapping without a hold" >> "$LOG"
      break
      ;;
  esac
  if [ "$HOLD_WAITED" -eq 0 ]; then
    echo "$(date -u) holding the container swap: a candidate search is running ($INFLIGHT)" >> "$LOG"
  fi
  sleep "$HOLD_STEP_SEC"
  HOLD_WAITED=$((HOLD_WAITED + HOLD_STEP_SEC))
done
if [ "$HOLD_WAITED" -ge "$HOLD_MAX_SEC" ]; then
  echo "$(date -u) hold expired after ${HOLD_MAX_SEC}s — swapping anyway; the search crash net recovers what it interrupts" >> "$LOG"
elif [ "$HOLD_WAITED" -gt 0 ]; then
  echo "$(date -u) searches finished after ${HOLD_WAITED}s — swapping now" >> "$LOG"
fi
# <<< deploy-hold

# Deploy. Try the full stack; if any service (e.g. the `taltxt` OS Text service) fails to build, fall
# back to (re)building just the core app + db + caddy so app updates ALWAYS ship.
if swap_app docker compose up -d --build >> "$LOG" 2>&1; then
  echo "$(date -u) deploy complete (full stack)" >> "$LOG"
else
  echo "$(date -u) full build failed — deploying core only (skipping the OS Text service)" >> "$LOG"
  swap_app docker compose up -d --build --no-deps app >> "$LOG" 2>&1 || true
  docker compose up -d --no-deps db caddy >> "$LOG" 2>&1 || true
  # A failed full build must NEVER leave OS Text (or lume-jobs) dark: bring both
  # back up on their existing images (no build) so the old version keeps serving.
  docker compose up -d --no-build --no-deps taltxt lume-jobs >> "$LOG" 2>&1 || true
  echo "$(date -u) deploy complete (core only, side services on previous images)" >> "$LOG"
fi

# Reclaim the image this deploy just superseded, so dangling images can never
# accumulate across a busy day again. Runs after the deploy is up, so a rollback
# to the still-tagged previous image is unaffected; only untagged, unused layers
# go. Best-effort: a prune failure must never fail a deploy that already shipped.
docker image prune -f >> "$LOG" 2>&1 || true
echo "$(date -u) disk after deploy: $(df -h / | tail -1 | awk '{print $4" free ("$5" used)"}')" >> "$LOG"

# ---- POST-DEPLOY HEALTH GATE (with rollback) --------------------------------
# WHY: until 2026-07-30 this watcher shipped the main app BLIND. It built, swapped
# the container, logged "deploy complete" and moved on without ever asking whether
# what it shipped could serve a request. That is how a build missing `undici` ran in
# production for hours — the image built clean, the container started clean, and the
# first signal was a recruiter saying a JD Sourcing search had disappeared. The OS
# Text engine already had a deep health probe with a fail-safe rebuild; the app,
# which is the bigger surface, had nothing. This closes that gap.
#
# /api/health is the right probe precisely BECAUSE it is not special-cased: it is a
# normal compiled route, so it dies from exactly the same bundling/dependency faults
# as every other route. During the undici outage it was 500ing too.
app_healthy() {
  docker exec recruiteros-app-1 wget -qO- --timeout=5 \
    http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok":true'
}

HEALTHY=0
for _ in $(seq 1 30); do            # up to ~90s: cold Next boot is ~1s, image pull/start slower
  if app_healthy; then HEALTHY=1; break; fi
  sleep 3
done

if [ "$HEALTHY" = "1" ]; then
  rm -f "$DIR/.deploy-health-failed" 2>/dev/null || true
  echo "$(date -u) health gate OK (/api/health serving at $REMOTE)" >> "$LOG"
else
  echo "$(date -u) !! HEALTH GATE FAILED at $REMOTE — /api/health never returned ok:true" >> "$LOG"
  echo "$REMOTE" > "$DIR/.deploy-health-failed" 2>/dev/null || true
  # Capture why, while the broken container is still up — this is the evidence that
  # was missing on 2026-07-30 and cost hours of guessing.
  docker logs --tail 40 recruiteros-app-1 >> "$LOG" 2>&1 || true

  if docker image inspect recruiteros-app:previous >/dev/null 2>&1; then
    echo "$(date -u) !! rolling back to the previous app image..." >> "$LOG"
    docker tag recruiteros-app:previous recruiteros-app:latest >> "$LOG" 2>&1 || true
    swap_app docker compose up -d --no-build --no-deps app >> "$LOG" 2>&1 || true
    ROLLED=0
    for _ in $(seq 1 20); do
      if app_healthy; then ROLLED=1; break; fi
      sleep 3
    done
    if [ "$ROLLED" = "1" ]; then
      echo "$(date -u) !! ROLLED BACK — prod is serving the PREVIOUS build. Commit $REMOTE is BAD; fix it and push again." >> "$LOG"
    else
      echo "$(date -u) !! ROLLBACK ALSO UNHEALTHY — manual intervention needed. Check: docker logs recruiteros-app-1" >> "$LOG"
    fi
  else
    echo "$(date -u) !! no :previous image to roll back to — leaving the new build up, manual intervention needed" >> "$LOG"
  fi
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
