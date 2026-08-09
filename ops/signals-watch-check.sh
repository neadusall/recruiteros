#!/usr/bin/env bash
# RecruitersOS · Signal Watchlist watchdog
#
# Judges the discovery belt every 15 minutes and EMAILS THE OWNER when it is not
# working. Before this it only called logger(), which is why a timer that had never
# once connected went unnoticed: the failure was detected correctly on every tick and
# written somewhere nobody reads.
#
# Anti-spam contract, same shape as ros-sentinel:
#   - a CHANGE in the failure set emails once
#   - an unchanged failure set re-emails every 6 hours, not every tick
#   - recovery emails one all-clear
#
# Never exits non-zero: a watchdog that fails its own systemd unit is a second outage.
set -uo pipefail
source /etc/recruiteros-signals-watch.env
STALE_MIN="${STALE_MIN:-45}"
TAG="signals-watch-monitor"
STATE="${SIGNALS_WATCH_STATE:-/var/lib/signals-watch-monitor}"
ENVFILE=/opt/recruiteros/.env.production
REALERT_SECS=21600
mkdir -p "$STATE" 2>/dev/null || true

envval() { grep -m1 "^$1=" "$ENVFILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'"; }
OWNER_TO="$(envval OWNER_EMAIL)"; [ -n "$OWNER_TO" ] || OWNER_TO="neadusall@gmail.com"
MAIL_FROM="$(envval EMAIL_FROM)"; [ -n "$MAIL_FROM" ] || MAIL_FROM="RecruitersOS <onboarding@resend.dev>"
RESEND_KEY="$(envval RESEND_API_KEY)"

send_mail() {
  local subject="$1" body="$2"
  [ -n "$RESEND_KEY" ] || { logger -t "$TAG" -p user.err "WOULD MAIL (no RESEND_API_KEY): $subject"; return 1; }
  local payload code
  payload=$(jq -n --arg from "$MAIL_FROM" --arg to "$OWNER_TO" \
                  --arg subject "$subject" --arg text "$body" \
                  '{from:$from, to:[$to], subject:$subject, text:$text}')
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 \
    -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_KEY" -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || echo 000)
  logger -t "$TAG" -p user.info "mail '$subject' -> $OWNER_TO (resend $code)"
}

# Alert only when the failure set CHANGED, or the same one has been open 6h.
maybe_alert() {
  local sig="$1" subject="$2" body="$3"
  local hash last_hash last_at now
  hash=$(printf '%s' "$sig" | md5sum | cut -d' ' -f1)
  last_hash=$(cat "$STATE/hash" 2>/dev/null || echo "")
  last_at=$(cat "$STATE/at" 2>/dev/null || echo 0)
  now=$(date -u +%s)
  if [ "$hash" != "$last_hash" ] || [ $((now - last_at)) -ge "$REALERT_SECS" ]; then
    send_mail "$subject" "$body"
    printf '%s' "$hash" > "$STATE/hash" 2>/dev/null || true
    printf '%s' "$now"  > "$STATE/at"   2>/dev/null || true
  fi
}

clear_alert() {
  local had; had=$(cat "$STATE/hash" 2>/dev/null || echo "")
  if [ -n "$had" ]; then
    send_mail "RecruitersOS: signal discovery recovered" \
      "The Signal Watchlist belt is healthy again.

$1"
    rm -f "$STATE/hash" "$STATE/at" 2>/dev/null || true
  fi
}

body="$(curl -fsS -m 20 -k --resolve recruitersos.co:443:127.0.0.1 \
  -H "x-cron-secret: ${RECRUITEROS_CRON_SECRET}" \
  "${WATCH_URL}/api/signals/watch?status=1" 2>/dev/null || true)"

if [ -z "$body" ]; then
  msg="UNREACHABLE: ${WATCH_URL}/api/signals/watch?status=1 returned nothing (app down or secret wrong)"
  logger -t "$TAG" -p user.err "$msg"
  maybe_alert "unreachable" "RecruitersOS: signal discovery is UNREACHABLE" \
"The Signal Watchlist status endpoint returned nothing.

$msg

This means In-Market discovery is not running: no Hire Signals, no news signals,
no new companies entering the belt. It is NOT a quiet market.

Check:  systemctl status recruiteros-signals-watch.service
        journalctl -u recruiteros-signals-watch.service -n 20"
  exit 0
fi

verdict="$(echo "$body" | STALE_MIN="$STALE_MIN" node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    let j; try{ j=JSON.parse(d); }catch{ console.log("ALERT PARSE_FAIL (status endpoint returned unparseable output)"); process.exit(0); }
    const h=j.health||{}, staleMin=Number(process.env.STALE_MIN)||45;
    const active=j.activeWatchlists||0;
    const budget=(j.budget&&j.budget.remaining);
    const out=[];
    // No watchlists at all is its own failure: the belt is wired and idle, which
    // produces exactly the zeros a healthy-but-quiet system produces.
    if(active===0) out.push("NO_WATCHLISTS: nothing is configured to watch, so nothing can ever be discovered");
    if(active>0){
      if(!h.lastTickAt){ out.push("NO_TICK_YET (active lists but the poller has never ticked)"); }
      else {
        const ageMin=(Date.now()-new Date(h.lastTickAt).getTime())/60000;
        if(ageMin>staleMin) out.push("STALE: last tick "+Math.round(ageMin)+"m ago (>"+staleMin+"m) - timer dead or app down");
      }
    }
    if((h.consecutiveErrors||0)>=3) out.push("FAILING: "+h.consecutiveErrors+" ticks in a row errored ("+(h.lastError||"")+")");
    if(budget===0) out.push("BUDGET_EXHAUSTED: no feed pulls left today (raise SIGNALS_WATCH_DAILY_FETCH_CAP or lower cadence)");
    // A feed that answers 200-with-nothing is an outage wearing a quiet market as a disguise.
    if(j.newsFeed&&j.newsFeed.open) out.push("NEWS_FEED_BLOCKED: "+(j.newsFeed.lastError||"refusing us")+" until "+(j.newsFeed.openUntil||"?"));
    if(j.jobFeed&&j.jobFeed.suspectOutage) out.push("JOB_FEED_SUSPECT: "+(j.jobFeed.note||"200 OK with zero jobs repeatedly"));
    // Discovery paused on purpose is NOT an alert. Reported so a deliberate pause is
    // never mistaken for a dead belt.
    const paused=(j.capacity&&j.capacity.hasRoom===false)?" PAUSED_FOR_CAPACITY("+(j.capacity.note||"")+")":"";
    console.log(out.length? "ALERT "+out.join(" | ") : "OK active="+active+" lastTick="+(h.lastTickAt||"never")+" errs="+(h.consecutiveErrors||0)+" budgetLeft="+budget+paused);
  });
' 2>/dev/null || echo "ALERT NODE_FAIL (could not evaluate status)")"

case "$verdict" in
  ALERT*)
    logger -t "$TAG" -p user.warning "$verdict"
    maybe_alert "$verdict" "RecruitersOS: signal discovery needs attention" \
"$verdict

Raw status:
$body"
    ;;
  *)
    logger -t "$TAG" -p user.info "$verdict"
    clear_alert "$verdict"
    ;;
esac
exit 0
