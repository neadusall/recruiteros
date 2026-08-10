#!/usr/bin/env bash
# ros-sentinel v1 (installed 2026-08-03)
#
# One watchdog that answers a single question every 5 minutes: is every tool on
# this box active and working? If anything is not, it EMAILS THE OWNER directly
# through the Resend HTTP API. It deliberately does NOT depend on the app
# container to send mail: the app being down is exactly one of the failures it
# must be able to report.
#
# Anti-spam contract:
#   - a change in the failure set (new failure, partial recovery) sends one email
#   - full recovery sends one all-clear email
#   - an unchanged failure set re-alerts every 6 hours, not every tick
#
# Lives at /usr/local/bin (outside the git checkout) on its own systemd timer,
# same survival model as ostext-watchdog: no repo push can take it down.
set -uo pipefail

DIR=/opt/recruiteros
ENVFILE=/opt/recruiteros/.env.production
STATE="${ROS_SENTINEL_STATE:-/var/lib/ros-sentinel}"
LOG="${ROS_SENTINEL_LOG:-/var/log/ros-sentinel.log}"
REALERT_SECS=21600
# ROS_SENTINEL_DRYRUN=1: print emails to stdout instead of sending, and skip
# the deploy-lock guard, so the format can be previewed without side effects.
DRYRUN="${ROS_SENTINEL_DRYRUN:-}"
mkdir -p "$STATE"


# [heartbeat] Every exit path leaves a mark, so a run that was skipped is never
# mistaken for a watchdog that stopped. Read with:
#   date -u -d @$(cat /var/lib/ros-sentinel/lastrun.epoch); cat /var/lib/ros-sentinel/lastrun.reason
RUN_REASON=""
stamp() {
  RUN_REASON="$1"
  date -u +%s > "$STATE/lastrun.epoch" 2>/dev/null || true
  printf '%s\n' "$1" > "$STATE/lastrun.reason" 2>/dev/null || true
}
# The skip paths stamp their own reason first, so the trap must not overwrite it
# on the way out: an unrecorded skip is the exact blindness this closes.
trap '[ -n "$RUN_REASON" ] || stamp completed' EXIT
# [/heartbeat]

# Never inspect the stack mid-deploy: half-recreated containers look broken for
# a few seconds. Non-blocking take of the shared deploy lock, same as
# ostext-watchdog. Holding it for the rest of the run keeps compose from
# starting a recreate under our feet.
if [ -z "$DRYRUN" ]; then
  exec 9>/var/lock/recruiteros-deploy.lock
  flock -w 90 9 || { stamp skipped-deploy-lock; exit 0; }
  case "$(systemctl is-active recruiteros-deploy.service 2>/dev/null || true)" in
    active|activating|deactivating) stamp skipped-deploying; exit 0;;
  esac
fi

envval() { grep -m1 "^$1=" "$ENVFILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'"; }

OWNER_TO="$(envval OWNER_EMAIL)"; [ -n "$OWNER_TO" ] || OWNER_TO="neadusall@gmail.com"
MAIL_FROM="$(envval EMAIL_FROM)"; [ -n "$MAIL_FROM" ] || MAIL_FROM="RecruitersOS <onboarding@resend.dev>"
RESEND_KEY="$(envval RESEND_API_KEY)"

FAILS=()
fail() { FAILS+=("$1 :: $2"); }
# Dry-run only: inject a fake failure (format "CODE :: detail") to preview a
# RED email without anything actually being broken.
[ -n "$DRYRUN" ] && [ -n "${ROS_SENTINEL_FAKE_FAIL:-}" ] && fail "${ROS_SENTINEL_FAKE_FAIL%% ::*}" "${ROS_SENTINEL_FAKE_FAIL#* :: }"

probe_local() { # host, path -> http code, served by local caddy
  curl -s -o /dev/null -w '%{http_code}' -m 12 -k --resolve "$1:443:127.0.0.1" "https://$1$2" || echo 000
}
probe_body_local() {
  curl -s -m 12 -k --resolve "$1:443:127.0.0.1" "https://$1$2" || true
}
retry3() { # fn args... : succeed if any of 3 attempts (12s apart) passes
  local i; for i in 1 2 3; do "$@" && return 0; [ "$i" -lt 3 ] && sleep 12; done; return 1
}

# 1. Portal app serving on both tenant hosts.
check_portal() { case "$(probe_local recruitersos.co /api/health)" in 2*) return 0;; *) return 1;; esac; }
retry3 check_portal || fail "PORTAL-DOWN" "recruitersos.co /api/health is not answering 200 through local Caddy"
case "$(probe_local app.lumesp.com /)" in 2*|3*) :;; *) fail "LUME-PORTAL-DOWN" "app.lumesp.com is not answering through local Caddy";; esac

# 2. OS Text engine: right build, both hosts. A redirect here means a wrong or
#    stale build is serving (the 2026-08-03 incident signature).
for h in recruitersos.co app.lumesp.com; do
  check_engine() { probe_body_local "$h" /ostext-app/api/health | grep -q ostext-engine; }
  retry3 check_engine || fail "OSTEXT-WRONG-BUILD" "$h/ostext-app/api/health is not returning the ostext-engine liveness body"
done

# 3. Deploy fail-safe screaming recently means serving-but-wrong right now.
#    Log lines start with `date -u` output: "Mon Aug  3 02:46:32 PM UTC 2026 ...".
LASTSW=$(grep 'serving-but-wrong' /var/log/recruiteros-deploy.log 2>/dev/null | tail -1 | awk '{print $1, $2, $3, $4, $5, $6, $7}')
if [ -n "$LASTSW" ]; then
  LASTSW_EPOCH=$(date -u -d "$LASTSW" +%s 2>/dev/null || echo 0)
  if [ "$LASTSW_EPOCH" -gt 0 ] && [ $(( $(date -u +%s) - LASTSW_EPOCH )) -lt 1200 ]; then
    fail "DEPLOY-WRONG-BUILD" "auto-deploy fail-safe logged serving-but-wrong within the last 20 minutes"
  fi
fi

# 3b. Deploy converge stuck: main pins an engine commit the box cannot fetch
#     (mistyped or never-pushed pin — the 2026-08-05 incident: git accepts any
#     40-hex gitlink, and the watcher then loops "not our ref" forever while
#     the engine silently stays on the old version). One failed tick is a
#     network blip; the SAME pin failing 5+ ticks (~10 min) with the latest
#     failure fresh is a frozen engine deploy pipeline.
DEPLOY_LOG="${ROS_SENTINEL_DEPLOY_LOG:-/var/log/recruiteros-deploy.log}"
LASTCF=$(grep 'CONVERGE FAILED' "$DEPLOY_LOG" 2>/dev/null | tail -1)
if [ -n "$LASTCF" ]; then
  LASTCF_EPOCH=$(date -u -d "$(echo "$LASTCF" | awk '{print $1, $2, $3, $4, $5, $6, $7}')" +%s 2>/dev/null || echo 0)
  if [ "$LASTCF_EPOCH" -gt 0 ] && [ $(( $(date -u +%s) - LASTCF_EPOCH )) -lt 1200 ]; then
    CF_SHA=$(echo "$LASTCF" | grep -o '[0-9a-f]\{40\}' | head -1)
    CF_COUNT=$(grep -c "CONVERGE FAILED.*${CF_SHA:-no-sha-parsed}" "$DEPLOY_LOG" 2>/dev/null || echo 0)
    if [ "${CF_COUNT:-0}" -ge 5 ]; then
      fail "OSTEXT-PIN-UNFETCHABLE" "deploy converge failed $CF_COUNT ticks and is still failing: main pins engine commit ${CF_SHA:-unknown} which the server cannot fetch (mistyped or never-pushed pin)"
    fi
  fi
fi

# 4. OS Text engine pin: checkout must match the superproject pin, and the pin
#    must never silently move BACKWARD (the autosave regression signature).
PIN=$(git -C "$DIR" ls-tree HEAD money-maker-sms 2>/dev/null | awk '{print $3}')
SUBHEAD=$(git -C "$DIR/money-maker-sms" rev-parse HEAD 2>/dev/null)
if [ -n "$PIN" ] && [ -n "$SUBHEAD" ] && [ "$PIN" != "$SUBHEAD" ]; then
  fail "OSTEXT-PIN-DRIFT" "engine checkout $SUBHEAD does not match superproject pin $PIN"
fi
LASTGOOD="$STATE/lastgood-pin"
if [ -n "$PIN" ]; then
  PREV=$(cat "$LASTGOOD" 2>/dev/null || true)
  if [ -n "$PREV" ] && [ "$PIN" != "$PREV" ] \
     && git -C "$DIR/money-maker-sms" merge-base --is-ancestor "$PIN" "$PREV" 2>/dev/null; then
    fail "OSTEXT-PIN-REGRESSED" "engine pin moved backward: $PREV -> $PIN (a stale checkout likely pushed an old pointer)"
  else
    echo "$PIN" > "$LASTGOOD"
  fi
fi

# 5. Every ops timer active, and its last service run not failed.
for t in recruiteros-deploy ostext-watchdog recruiteros-sending-health \
         recruiteros-nightqueue fleet-watchdog laxis-monitor \
         recruiteros-engine-health recruiteros-receipts recruiteros-month-close; do
  ST=$(systemctl is-active "$t.timer" 2>/dev/null || true)
  [ "$ST" = "active" ] || fail "TIMER-INACTIVE" "$t.timer is '$ST' (should be active)"
  if [ "$(systemctl is-failed "$t.service" 2>/dev/null)" = "failed" ]; then
    fail "SERVICE-FAILED" "$t.service last run failed (systemctl status $t.service)"
  fi
done

# 6. Containers: everything that should run is running, nothing is unhealthy.
RUNNING=$(docker ps --format '{{.Names}}')
for c in recruiteros-app-1 recruiteros-taltxt-1 recruiteros-caddy-1 recruiteros-db-1 \
         recruiteros-lume-jobs-1 recruiteros-laxis-worker-1 recruiteros-autoheal-1 \
         recruiteros-searxng-1 mytal-web landlinedb-svc \
         recruitersos-mail-mail-api-1 recruitersos-mail-mail-web-1 \
         recruitersos-mail-mail-redis-1 recruitersos-mail-mail-postgres-1; do
  echo "$RUNNING" | grep -qx "$c" || fail "CONTAINER-DOWN" "$c is not running"
done
UNHEALTHY=$(docker ps --filter health=unhealthy --format '{{.Names}}')
[ -z "$UNHEALTHY" ] || fail "CONTAINER-UNHEALTHY" "unhealthy: $(echo "$UNHEALTHY" | tr '\n' ' ')"

# 7. Database answering.
docker exec recruiteros-db-1 pg_isready -q 2>/dev/null || fail "DB-DOWN" "postgres in recruiteros-db-1 is not accepting connections"

# 8. Disk headroom (deploys need room to build images).
USEDPCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "${USEDPCT:-0}" -lt 90 ] || fail "DISK-LOW" "root filesystem at ${USEDPCT}% used"

# 9. Remote mail infrastructure (RackNerd Mailcow, sends for Lume).
MC=$(curl -s -o /dev/null -w '%{http_code}' -m 15 https://mail.lumesp.com/ || echo 000)
case "$MC" in 2*|3*|401) :;; *) fail "MAILCOW-DOWN" "https://mail.lumesp.com answered $MC";; esac
timeout 8 bash -c 'exec 3<>/dev/tcp/mail.lumesp.com/587' 2>/dev/null || fail "MAILCOW-SMTP-DOWN" "mail.lumesp.com port 587 is not accepting connections"

# 10. mytal.co onboarding site (served from this box).
case "$(probe_local mytal.co /)" in 2*|3*) :;; *) fail "MYTAL-DOWN" "mytal.co is not answering through local Caddy";; esac

# 12. Personalized-video streaming: play a chunk of the newest composite through
#     the real signed public endpoint. Two range requests: the first may warm the
#     app's stream cache from S3, the SECOND must come back fast from disk. A slow
#     second chunk is the playback-starvation failure (frozen video, audio playing).
VKEY=$(docker exec recruiteros-app-1 node -e "
try{const m=require('/data/snap_inmarket_autovideo_map_v1.json');
const es=Object.values(m).filter(e=>e&&e.videoKey).sort((a,b)=>(a.at<b.at?1:-1));
if(es[0])console.log(es[0].videoKey);}catch(e){}" 2>/dev/null || true)
if [ -n "$VKEY" ]; then
  VSECRET=$(grep -m1 -oP '^RECRUITEROS_SESSION_SECRET=\K.*' "$ENVFILE" 2>/dev/null || grep -m1 -oP '^RECRUITEROS_API_TOKEN=\K.*' "$ENVFILE" 2>/dev/null || true)
  if [ -n "$VSECRET" ]; then
    VSIG=$(printf 'share:%s:0' "$VKEY" | openssl dgst -sha256 -hmac "$VSECRET" -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n' | cut -c1-24)
    VURL="/api/in-market/watch?key=$VKEY&fmt=mp4&exp=0&sig=$VSIG&cb=sentinel$(date +%s)"
    V1=$(curl -s -o /dev/null -m 15 -k --resolve "recruitersos.co:443:127.0.0.1" -H "Range: bytes=200000-265535" -w "%{http_code} %{time_starttransfer}" "https://recruitersos.co$VURL" || echo "000 99")
    V2=$(curl -s -o /dev/null -m 15 -k --resolve "recruitersos.co:443:127.0.0.1" -H "Range: bytes=400000-465535" -w "%{http_code} %{time_starttransfer}" "https://recruitersos.co$VURL" || echo "000 99")
    VC2=${V2%% *}; VT2=${V2##* }
    if [ "$VC2" != "206" ]; then
      fail "VIDEO-STREAM-BROKEN" "watch endpoint returned $VC2 for a ranged chunk of $VKEY (first probe: $V1)"
    elif awk -v t="$VT2" 'BEGIN{exit !(t>1.0)}'; then
      fail "VIDEO-STREAM-SLOW" "warm video chunk took ${VT2}s (limit 1.0s) for $VKEY - playback will freeze while audio continues"
    fi
  fi
fi

# 13. Personalized-video PRODUCTION: the render fleet must keep landing videos.
#     Zero videos in 30 minutes means content creation has stopped - the Aug 2026
#     stall ran a full day unnoticed because only playback was checked, not
#     production. Owner mandate 2026-08-06: this system must run hard; alert at
#     30 minutes of silence.
#
#     BUT silence has two very different causes and they need different answers
#     (learned 2026-08-06 21:23 UTC, when a healthy fleet paged CRITICAL):
#       - work is WAITING and nothing is rendering it  -> the fleet is broken (CRITICAL)
#       - the fleet has rendered every eligible role   -> supply is the constraint (WARNING)
#     A CRITICAL that fires every time the book drains trains the owner to ignore
#     the one that means the fleet actually died, so measure the claimable queue
#     as well as the output.
#
#     Claimable = exactly what claimVideoJobs() hands a worker: a curated row that is
#     contactable (has an email), whose company+role has no video yet and is not benched
#     in the failure ledger. shotKey/isBenched are mirrored here deliberately - they key
#     the video map itself, so if they ever change, the map changes with them.
VSTATS=$(docker exec recruiteros-app-1 node -e "
try{
const fs=require('fs'),{createHash}=require('crypto');
const key=(c,r)=>{const h=createHash('sha1').update((c+r).toLowerCase()).digest('hex').slice(0,16);
const s=(c+'-'+r).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-\$/g,'').slice(0,60);return (s||'role')+'_'+h;};
const rd=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){return {}}};
const m=rd('/data/snap_inmarket_autovideo_map_v1.json');
const f=rd('/data/snap_inmarket_autovideo_fails_v1.json');
const cur=rd('/data/snap_inmarket_curation_v1.json');
const rows=Array.isArray(cur)?cur:Object.values(cur);
const made=Object.values(m).filter(e=>e&&e.at&&Date.parse(e.at)>Date.now()-30*60*1000).length;
const WF=/browser|chromium|closed|disconnected|Protocol error|Target/i, MAXT=4, now=Date.now();
const benched=e=>{if(!e)return false;if(WF.test(e.reason||''))return false;if(e.benched||e.tries>=MAXT)return true;
const w=now-Date.parse(e.at||'');if(!Number.isFinite(w))return false;
return w<Math.min(864e5,18e5*Math.pow(2,Math.max(0,e.tries-1)));};
const bud=rd('/data/snap_inmarket_websearch_budget_v1.json');
const resc=r=>!!r.emailInvalid&&!!r.managerName&&!!r.domain&&!r.sentAt&&!r.bouncedAt&&!r.repliedAt;
const seen=new Set();let pending=0,unnamed=0,rejected=0,epending=0,catchall=0;
for(const r of rows){const role=r.role||r.managerTitle;if(!r.company||!role)continue;
const ctc=r.status==='contactable'||r.status==='queued'||r.status==='enrolled';
if(!ctc||!r.likelyEmail){
if(r.status==='suppressed'){if(resc(r))rejected++;continue;}
if(!r.managerName)unnamed++;else if(r.emailCatchAll)catchall++;else if(r.emailInvalid)rejected++;else epending++;
continue;}
const k=key(r.company,role);if(seen.has(k))continue;seen.add(k);
if(m[k]||benched(f[k]))continue;pending++;}
const tday=new Date().toISOString().slice(0,10);
const bu=(bud&&bud.day===tday&&bud.used)?bud.used:0;
const bc=(bud&&bud.cap)?bud.cap:0;
console.log([made,pending,unnamed,rejected,epending,catchall,bu,bc].join(' '));
}catch(e){console.log('ERR ERR ERR ERR ERR ERR ERR ERR')}" 2>/dev/null || echo "ERR ERR ERR")
read VN VPEND VUNNAMED VREJECT VEPEND VCATCH VBUSED VBCAP <<SENTINEL_VSTATS
$VSTATS
SENTINEL_VSTATS

# NAMING SUPPLY. The free search scrapers are throttled to zero from this box, so the PAID search
# hop is decision-maker naming. Naming gates emails, emails gate renderable roles: when the daily
# ceiling is spent, naming silently falls back to those dead scrapers and supply drains from the
# TOP, surfacing hours later as an empty render queue that looks like a video fault. Say it here,
# at the source, and say it BEFORE the budget is gone - once spent, nothing recovers until midnight.
if [ "${VBCAP:-0}" -gt 0 ] 2>/dev/null; then
  if [ "${VBUSED:-0}" -ge "${VBCAP:-0}" ] 2>/dev/null; then
    fail "NAMING-BUDGET-SPENT" "today's paid search ceiling is fully spent (${VBUSED}/${VBCAP} queries) - decision-maker naming has fallen back to the free scrapers, which return nothing from this box, so no new roles can become contactable until UTC midnight"
  elif [ "$(( VBUSED * 100 / VBCAP ))" -ge 85 ] 2>/dev/null; then
    fail "NAMING-BUDGET-LOW" "today's paid search budget is ${VBUSED}/${VBCAP} queries spent - when it runs out, decision-maker naming stops producing and video supply follows it down a few hours later"
  fi
fi

if [ "$VN" = "0" ]; then
  if [ "$VPEND" = "ERR" ] || [ "${VPEND:-0}" -gt 0 ] 2>/dev/null; then
    fail "VIDEO-OUTPUT-STALLED" "0 videos produced in the last 30 minutes while ${VPEND} roles are queued and claimable (normal rate is 100+/hour) - the render fleet is not consuming its queue"
  else
    # Name the gate ACTUALLY holding supply. The old text said "waiting on a decision-maker email"
    # for every stuck role, which was wrong in the most common case by a whole stage: a role with no
    # decision-maker NAME has not reached the email step at all. That one word sent a fix at the
    # wrong subsystem. Report the largest bucket, and show the rest so the claim can be checked.
    GATE="${VUNNAMED} roles have no decision-maker NAME yet - the naming gate, upstream of email"
    GN=${VUNNAMED:-0}
    if [ "${VREJECT:-0}" -gt "$GN" ] 2>/dev/null; then GATE="${VREJECT} named people had every guessed address rejected and need a residual email finder"; GN=${VREJECT:-0}; fi
    if [ "${VEPEND:-0}" -gt "$GN" ] 2>/dev/null; then GATE="${VEPEND} named people are waiting on an email to be found"; GN=${VEPEND:-0}; fi
    if [ "${VCATCH:-0}" -gt "$GN" ] 2>/dev/null; then GATE="${VCATCH} named people are on catch-all domains whose specific mailbox cannot be confirmed"; GN=${VCATCH:-0}; fi
    fail "VIDEO-SUPPLY-EMPTY" "0 videos produced in the last 30 minutes because the queue is empty: every contactable role already has a video. The gate upstream is: ${GATE}. Full breakdown - unnamed ${VUNNAMED}, rejected-address ${VREJECT}, email-pending ${VEPEND}, catch-all ${VCATCH}"
  fi
fi

# 11. JD Sourcing engine-health stamp freshness (its converge layer should keep
#     it fresh; a stale stamp means that whole layer is quietly dead).
EH=/var/lib/recruiteros/engine-health.last
if [ -f "$EH" ]; then
  AGE=$(( $(date -u +%s) - $(cat "$EH" 2>/dev/null || echo 0) ))
  [ "$AGE" -lt 7200 ] || fail "ENGINE-HEALTH-STALE" "JD Sourcing engine-health stamp is ${AGE}s old (limit 7200s)"
fi

# 12. Tool readiness: any account with a tool that CANNOT work because its
#     connection is missing. This is the quiet failure mode — no error, no
#     crash, just a search that returns nobody — so the watchdog is what
#     notices it.  [ready-monitor]
READY_SECRET="$(envval RECRUITEROS_CRON_SECRET)"
if [ -n "$READY_SECRET" ]; then
  READY_JSON=$(curl -s -m 20 -k --resolve recruitersos.co:443:127.0.0.1 \
    "https://recruitersos.co/api/ready/audit?secret=$READY_SECRET" || true)
  if ! printf '%s' "$READY_JSON" | jq -e '.blocked' >/dev/null 2>&1; then
    fail "READY-AUDIT-UNREACHABLE" "the tool-readiness audit did not answer (portal up but /api/ready/audit returned nothing usable)"
  else
    READY_N=$(printf '%s' "$READY_JSON" | jq -r '.blocked | length')
    if [ "${READY_N:-0}" -gt 0 ]; then
      READY_LIST=$(printf '%s' "$READY_JSON" | jq -r '[.blocked[] | "\(.workspaceName): \(.toolLabel) needs \(.missing | join(" + "))"] | unique | join("; ")')
      fail "TOOL-NOT-CONNECTED" "$READY_N tool/account combination(s) cannot work: $READY_LIST"
    fi
  fi
fi

# ---- notify on change ----
send_mail() { # subject, body
  local subject="$1" body="$2"
  if [ -n "$DRYRUN" ]; then
    printf 'SUBJECT: %s\n\n%s\n' "$subject" "$body"; return 0
  fi
  if [ -z "$RESEND_KEY" ]; then
    echo "$(date -u) WOULD MAIL (no RESEND_API_KEY): $subject" >> "$LOG"; return 1
  fi
  local payload
  payload=$(jq -n --arg from "$MAIL_FROM" --arg to "$OWNER_TO" \
                 --arg subject "$subject" --arg text "$body" \
                 '{from:$from, to:[$to], subject:$subject, text:$text}')
  local code
  code=$(curl -s -o /tmp/ros-sentinel-mail.out -w '%{http_code}' -m 30 \
    -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_KEY" -H "Content-Type: application/json" \
    -d "$payload")
  echo "$(date -u) mail '$subject' -> $OWNER_TO (resend $code)" >> "$LOG"
  case "$code" in 2*) return 0;; *) cat /tmp/ros-sentinel-mail.out >> "$LOG" 2>/dev/null; return 1;; esac
}

# Turn a failure code into owner-facing language: what the tool is, what broke,
# what it affects, and what to do. Sets NAME/SEV/MEANING/IMPACT/ACTION.
explain() {
  local code="$1"
  NAME="$code"; SEV="WARNING"
  MEANING="A monitored check failed."
  IMPACT="See the technical detail below."
  ACTION="Paste this whole email into Claude Code and say: fix this."
  case "$code" in
    TOOL-NOT-CONNECTED) NAME="Tool with a missing connection"; SEV="WARNING"
      MEANING="A tool is switched on for an account, but the account it runs through was never connected (or its key was removed)."
      IMPACT="That tool cannot do its work. It does not error - a search finds nobody, a campaign sends nothing - so the person using it believes there was nothing to find and tries again. The detail line says which account and which connection.";;
    READY-AUDIT-UNREACHABLE) NAME="Tool readiness monitoring"; SEV="WARNING"
      MEANING="The portal is up but the readiness audit did not answer, so nothing is currently checking whether tools have what they need."
      IMPACT="Tools could be silently unable to work and nobody would be told. The platform itself is fine.";;
    PORTAL-DOWN) NAME="RecruitersOS portal"; SEV="CRITICAL"
      MEANING="The main portal (recruitersos.co) is not answering."
      IMPACT="Recruiters cannot log in or do any work until this is fixed.";;
    LUME-PORTAL-DOWN) NAME="Lume portal"; SEV="CRITICAL"
      MEANING="app.lumesp.com is not answering."
      IMPACT="The Lume team cannot log in or do any work until this is fixed.";;
    OSTEXT-WRONG-BUILD) NAME="OS Text engine"; SEV="CRITICAL"
      MEANING="The texting engine is running, but it is serving the WRONG version of itself."
      IMPACT="The OS Text tab will error or show a login page. Campaigns and texting may misbehave. This is the same failure that broke OS Text on Aug 3.";;
    DEPLOY-WRONG-BUILD) NAME="Deploy system"; SEV="CRITICAL"
      MEANING="The last deploy shipped a build the server itself says is wrong, and its auto-repair has not recovered it."
      IMPACT="Parts of the portal may look up but behave incorrectly.";;
    OSTEXT-PIN-UNFETCHABLE) NAME="OS Text engine deploys"; SEV="CRITICAL"
      MEANING="The code on GitHub points at an engine version the server cannot download - usually a mistyped or never-pushed engine commit."
      IMPACT="Engine deploys are FROZEN: texting keeps running the old version and no new engine fixes can ship until the pin is corrected. The rest of the platform still deploys.";;
    OSTEXT-PIN-DRIFT) NAME="OS Text engine version"; SEV="CRITICAL"
      MEANING="The engine version running does not match the version the code says should run."
      IMPACT="OS Text may be missing recent fixes or running stale behavior.";;
    OSTEXT-PIN-REGRESSED) NAME="OS Text engine version"; SEV="CRITICAL"
      MEANING="The engine version moved BACKWARD to an older release. A stale checkout probably pushed an old pointer."
      IMPACT="Recent OS Text features and fixes silently disappeared from production.";;
    VIDEO-STREAM-BROKEN) NAME="Personalized video playback"; SEV="CRITICAL"
      MEANING="The public video endpoint is not serving video chunks at all."
      IMPACT="Prospects clicking video links see a broken or never-loading player.";;
    VIDEO-STREAM-SLOW) NAME="Personalized video playback"; SEV="CRITICAL"
      MEANING="Video chunks are coming back too slowly from the server."
      IMPACT="Videos freeze while the audio keeps playing - prospects see a stuck face. Same failure as the Aug 4 playback incident.";;
    VIDEO-OUTPUT-STALLED) NAME="Personalized video production"; SEV="CRITICAL"
      MEANING="There are roles queued and ready to render, and not a single video came out in the last 30 minutes. The render fleet is not consuming its queue: the workers are down, crash-looping, or the claim endpoint is broken."
      IMPACT="Content creation has stopped with work waiting. Video emails have nothing fresh to attach and outreach quietly dries up. This is the silent stall that cut output to 54/day in early August.";;
    VIDEO-SUPPLY-EMPTY) NAME="Personalized video supply"; SEV="WARNING"
      MEANING="The render fleet is healthy and idle: it has already made a video for every role it is allowed to render. No videos came out simply because there was nothing left to render."
      IMPACT="Nothing is broken, but video output has hit its ceiling and will stay near zero until new roles become renderable. The detail line names WHICH upstream stage is holding them - a role has to earn a decision-maker NAME first, then an EMAIL, and those are different problems with different fixes. Trust that breakdown over any assumption about which one it is; adding render boxes would change nothing either way.";;
    NAMING-BUDGET-SPENT) NAME="Decision-maker naming"; SEV="WARNING"
      MEANING="The paid search budget that finds decision-maker names is fully spent for the day. The free search engines it falls back to are blocked from this server, so naming is effectively stopped until the counter resets at UTC midnight."
      IMPACT="No NEW roles will become contactable, so video supply and outreach volume will drift down over the following hours. Everything already contactable is unaffected. Raising INMARKET_SEARCH_DAILY_MAX buys more naming; the ceiling is enforced in dollars, so failover to a pricier provider cannot overshoot it.";;
    NAMING-BUDGET-LOW) NAME="Decision-maker naming"; SEV="WARNING"
      MEANING="The paid search budget that finds decision-maker names is nearly spent for the day."
      IMPACT="This is the early warning, not the failure: naming still works right now. If it runs out, new supply stops until UTC midnight and video output follows a few hours later. Raise INMARKET_SEARCH_DAILY_MAX now to avoid that.";;
    TIMER-INACTIVE) NAME="Automated background job"; SEV="WARNING"
      MEANING="One of the self-maintenance jobs is switched off entirely."
      IMPACT="Whatever that job maintains (deploys, texting watchdog, sender health, receipts...) has stopped maintaining itself. Nothing may look broken yet, but its safety net is gone.";;
    SERVICE-FAILED) NAME="Automated background job"; SEV="WARNING"
      MEANING="A self-maintenance job ran and FAILED on its last attempt."
      IMPACT="That job's work is not getting done. If it keeps failing, the thing it maintains will degrade.";;
    CONTAINER-DOWN) NAME="Platform component"; SEV="CRITICAL"
      MEANING="A piece of the platform that should always be running is stopped."
      IMPACT="The feature that component powers is down right now.";;
    CONTAINER-UNHEALTHY) NAME="Platform component"; SEV="CRITICAL"
      MEANING="A piece of the platform is running but reporting itself as unhealthy."
      IMPACT="The feature it powers is failing or about to fail.";;
    DB-DOWN) NAME="Database"; SEV="CRITICAL"
      MEANING="The main database is not accepting connections."
      IMPACT="The entire portal is effectively down: logins, candidates, campaigns, everything.";;
    DISK-LOW) NAME="Server disk space"; SEV="WARNING"
      MEANING="The server disk is over 90 percent full."
      IMPACT="Deploys will start failing soon and the box can grind to a halt if it fills completely.";;
    MAILCOW-DOWN) NAME="Mail server (Mailcow)"; SEV="CRITICAL"
      MEANING="The mail server at mail.lumesp.com is not answering on the web."
      IMPACT="Lume email sending and mailbox access are affected.";;
    MAILCOW-SMTP-DOWN) NAME="Mail server SMTP"; SEV="CRITICAL"
      MEANING="The mail server is not accepting SMTP connections on port 587."
      IMPACT="Outbound email through the Mailcow server is NOT sending.";;
    MYTAL-DOWN) NAME="mytal.co site"; SEV="WARNING"
      MEANING="The client intake site mytal.co is not answering."
      IMPACT="Prospects and clients hitting that link get an error.";;
    ENGINE-HEALTH-STALE) NAME="JD Sourcing health monitor"; SEV="WARNING"
      MEANING="The hourly JD Sourcing health check has not reported in over 2 hours."
      IMPACT="Sourcing problems could now go unnoticed. The monitor itself needs reviving.";;
  esac
}

CURR=$(printf '%s\n' "${FAILS[@]:-}" | sed '/^$/d' | sort)
PREVF="$STATE/failures.txt"
PREV=$(cat "$PREVF" 2>/dev/null || true)
LASTMAIL=$(cat "$STATE/lastmail.epoch" 2>/dev/null || echo 0)
NOW=$(date -u +%s)
HOSTLINE="Server: $(hostname), checked $(date -u '+%Y-%m-%d %H:%M UTC'). Checks run every 5 minutes."

if [ "${1:-}" = "--test" ]; then
  send_mail "[ROS SENTINEL] TEST: this is only a delivery check, nothing is broken" \
"=================================================
 THIS IS A TEST: NOTHING IS BROKEN
=================================================

STATUS: TEST ONLY. If you are reading this, alerts will reach you.

Real emails come in exactly two colors, named in the subject line:
- RED = NEGATIVE, something is broken, action is needed
- GREEN = POSITIVE, everything recovered, no action needed

Every RED email explains each problem in plain English: what happened,
what it affects, and what to do, plus the technical detail to hand to
Claude for the fix.

$HOSTLINE"
  exit $?
fi

if [ -n "$CURR" ]; then
  N=$(echo "$CURR" | wc -l)
  if [ "$CURR" != "$PREV" ] || [ $((NOW - LASTMAIL)) -ge $REALERT_SECS ]; then
    NEWLINES=$(comm -13 <(echo "$PREV") <(echo "$CURR") 2>/dev/null || echo "$CURR")
    GONE=$(comm -23 <(echo "$PREV") <(echo "$CURR") 2>/dev/null || true)

    # Overall severity: CRITICAL if any single problem is critical.
    OVERALL="WARNING"
    PROBLEMS=""
    i=0
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      i=$((i+1))
      CODE="${line%% ::*}"
      DETAIL="${line#* :: }"
      explain "$CODE"
      [ "$SEV" = "CRITICAL" ] && OVERALL="CRITICAL"
      MARK="STILL BROKEN (already alerted)"
      echo "$NEWLINES" | grep -qxF "$line" && MARK="NEW"
      PROBLEMS="$PROBLEMS
--------------------------------------------------
PROBLEM $i of $N: $NAME
Severity: $SEV | $MARK
What happened: $MEANING
What it affects: $IMPACT
What to do: $ACTION
Technical detail (for Claude): $CODE :: $DETAIL
"
    done <<< "$CURR"

    HEADLINE="STATUS: NEGATIVE. $N problem(s) found. Action is needed."
    [ "$OVERALL" = "CRITICAL" ] && HEADLINE="STATUS: NEGATIVE. $N problem(s) found, at least one CRITICAL. Act on this as soon as you can."

    BODY="=================================================
 THIS IS A NEGATIVE ALERT: SOMETHING IS BROKEN
=================================================

$HEADLINE

Fastest path to a fix: copy this entire email into Claude Code and say
\"fix this\". Every problem below includes the technical detail Claude needs.
$PROBLEMS"
    [ -n "$GONE" ] && BODY="$BODY
--------------------------------------------------
GOOD NEWS in the same run, these fixed themselves since the last alert:
$GONE
"
    BODY="$BODY
--------------------------------------------------
You will get ONE reminder every 6 hours while this stays broken, and a
GREEN all-clear email the moment everything passes again.

$HOSTLINE"
    # Advance the "already alerted" state ONLY when the email actually went
    # out. A failed send (Resend blip, network) leaves PREVF untouched, so the
    # very next tick sees the same change and retries until delivery succeeds.
    if send_mail "[ROS SENTINEL] RED / $OVERALL: $N problem(s) need attention" "$BODY"; then
      echo "$NOW" > "$STATE/lastmail.epoch"
      echo "$CURR" > "$PREVF"
    fi
  else
    echo "$CURR" > "$PREVF"
  fi
  echo "$(date -u) FAIL($N): $(echo "$CURR" | tr '\n' '|')" >> "$LOG"
else
  if [ -n "$PREV" ]; then
    FIXEDLIST=""
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      CODE="${line%% ::*}"
      explain "$CODE"
      FIXEDLIST="$FIXEDLIST
- $NAME is working again (was: ${line#* :: })"
    done <<< "$PREV"
    send_mail "[ROS SENTINEL] GREEN: everything is working again, no action needed" \
"=================================================
 THIS IS A POSITIVE ALL-CLEAR: EVERYTHING IS FINE
=================================================

STATUS: POSITIVE. Every check passes. You do NOT need to do anything.

What recovered:$FIXEDLIST

All portals, the OS Text engine, every background job, every container,
the database, disk space, the mail server, and mytal.co are healthy.

$HOSTLINE" || exit 0
    # Same delivery guarantee as alerts: only clear the state once the
    # all-clear email really sent, so a failed send retries next tick.
    echo "$NOW" > "$STATE/lastmail.epoch"
  fi
  : > "$PREVF"
fi

date -u +%s > "$STATE/last-run"
exit 0
