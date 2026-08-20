#!/usr/bin/env bash
# RecruitersOS · MPC daily outreach (Ryan / CPA-Controller) + reply monitor.
# Sends today's FRESH, gated, de-duped, never-re-contacted batch, then reads replies back and
# refreshes the per-variant leaderboard. Sends nothing if there are no fresh prospects.
# Tracked in the repo since 2026-08-20 (deploys manage it); the systemd unit runs this path.
set -euo pipefail
cd /opt/recruiteros
mkdir -p mpc-out
LOG="mpc-out/daily-$(date +%F).log"
# Send ceiling. Actual sends = min(cap, fresh clean supply), so this never forces volume that
# isn't there; it just uncaps the pipeline up to the daily target.
DAILY_CAP="${MPC_DAILY_CAP:-1500}"

echo "===== MPC daily run $(date -u +%FT%TZ) =====" >> "$LOG"

# 0) Standing rota: re-queue the finance search bank DAILY so the pool keeps refilling with fresh
#    postings. Daily uses a 3-day window (quota-efficient); Mondays widen to a full week.
WINDOW=3days; [ "$(date +%u)" = "1" ] && WINDOW=week
echo "-- refreshing finance search bank (window=$WINDOW) --" >> "$LOG"
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
  -e MPC_SEARCH_DATE="$WINDOW" --entrypoint node recruiteros-app \
  /tools/seed-finance-searches.mjs >> "$LOG" 2>&1 || true

# 0.5) Grow the FREE ATS directory: discover + validate new employer boards so free sourcing
#      compounds toward thousands of employers at $0 (no JSearch credits).
docker run --rm -e ATS_MAX_VALIDATE=4000 -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
  --entrypoint node recruiteros-app /tools/discover-ats-slugs.mjs >> "$LOG" 2>&1 || true

# 0.9) Domain rest fail-safe, PRE-SEND pass: evaluate yesterday's audit so today's batch never
#      sends through a domain that is bouncing, reputation-damaged, or auth-broken. Benched
#      domains rest on an escalating quarantine (2d -> 7d -> 14d) and revive themselves only
#      when their signals read clean; warm-up keeps running the whole time. Emails the owner
#      on every bench/revive. batch.mjs and followup.mjs enforce the ledger this writes.
grep -E '^(RESEND_API_KEY|OWNER_EMAIL|EMAIL_FROM)=' .env.production > /tmp/dr.env 2>/dev/null || true
docker run --rm --env-file /tmp/dr.env -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app /tools/domain-rest.mjs >> "$LOG" 2>&1 || true
rm -f /tmp/dr.env

# 0.95) Touch 2, the VIDEO email: personalized-video follow-up to YESTERDAY's touch-1 recipients
#       (no reply, video rendered), one recruiter at a time. Runs BEFORE today's touch-1 batch so
#       box capacity finishes existing sequences before starting new ones. Same box as touch 1;
#       per-box caps, reply stops, and domain-rest ledger all enforced inside the tool.
#       RYAN ONLY (owner decision 2026-08-12): the rendered videos carry RYAN's headshot in the
#       lower-right of the screen capture, so a video email signed by Josh/Sam/Noah/Ariel would
#       show the wrong face. Add an owner back to this loop only once videos exist with THEIR
#       headshot. Everyone still sends touch-1 text emails via the batch below.
grep -E '^(ANTHROPIC_API_KEY|SENDINGAC_MAILBOX_API_KEY|RECRUITEROS_SESSION_SECRET|RECRUITEROS_API_TOKEN|MPC_SMTP_LANE|SENDERS_ENCRYPTION_KEY|APP_ENCRYPTION_KEY)=' .env.production > /tmp/v2.env
for OWNER in ryan; do
  docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
    --env-file /tmp/v2.env --entrypoint node recruiteros-app \
    /tools/video-email2.mjs --owner "$OWNER" --send >> "$LOG" 2>&1 || true
done
rm -f /tmp/v2.env

# 1) Outreach: fuse -> gate -> verification belt -> write -> render-gate -> suppress/dedupe -> send.
#    2026-08-20: the send env carries the verifier key (pre-send belt), the owner alert keys
#    (fuse/breaker emails) and every MPC_* knob. The fuse is evaluated first; batch.mjs holds
#    on its own when the fuse is tripped or bounce data is stale.
grep -E '^(ANTHROPIC_API_KEY|SENDINGAC_MAILBOX_API_KEY|REOON_API_KEY|REOON_VERIFY_MODE|RESEND_API_KEY|OWNER_EMAIL|EMAIL_FROM|MPC_[A-Z_]+)=' .env.production > /tmp/mpc.env
grep -E '^ALERT_(TELNYX_KEY|SMS_FROM|SMS_TO|SMS_PROFILE)=' /etc/ros-alert.env >> /tmp/mpc.env 2>/dev/null || true  # owner SMS on fuse trips
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/mpc.env --entrypoint node recruiteros-app \
  /tools/send-fuse.mjs >> "$LOG" 2>&1 || true
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/mpc.env --entrypoint node recruiteros-app \
  /tools/batch.mjs --send --limit "$DAILY_CAP" >> "$LOG" 2>&1
rm -f /tmp/mpc.env

# 2) Monitor: read inboxes back, match replies, print the leaderboard, AND bridge real replies
#    into the portal inbox (writes /data/snap_mpc_reply_queue_v1.json -> app scheduler ingests).
grep -E '^(SENDINGAC_MAILBOX_API_KEY)=' .env.production > /tmp/mon.env
docker run --rm \
  -v recruiteros_app_data:/data \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/mon.env --entrypoint node recruiteros-app \
  /tools/monitor.mjs >> "$LOG" 2>&1
rm -f /tmp/mon.env

# 3) Refresh the BD cockpit stats snapshot for the Dashboard.
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app /tools/mpc-stats.mjs >> "$LOG" 2>&1 || true

# 3.5) Growth Engine: idle demand + capacity gap + campaign proposals for the cockpit.
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app /tools/growth-engine.mjs >> "$LOG" 2>&1 || true

# 3.7) Deliverability tracker: document real per-domain landing numbers + roll the daily history.
grep -E '^(SMARTLEAD_API_KEY)=' .env.production > /tmp/dl.env
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --env-file /tmp/dl.env --entrypoint node recruiteros-app /tools/mpc-deliverability.mjs >> "$LOG" 2>&1 || true
rm -f /tmp/dl.env

# 3.8) Autonomous DNS auth remediation: publish enforcing DMARC on any SENDING domain that has
#      SPF+DKIM but DMARC p=none (reads the audit from 3.7). Idempotent + safe: only ever the
#      _dmarc TXT record. No-ops gracefully until the Porkbun API key pair is set in the env.
grep -E '^(PORKBUN_API_KEY|PORKBUN_SECRET_KEY|MPC_DMARC_POLICY)=' .env.production > /tmp/pb.env 2>/dev/null || true
docker run --rm --env-file /tmp/pb.env -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app /tools/dns-authfix.mjs --apply >> "$LOG" 2>&1 || true
rm -f /tmp/pb.env

# 3.9) Domain rest fail-safe, POST-AUDIT pass: act on TODAY's numbers (and on DNS auth just
#      repaired by 3.8) the same day they are measured instead of waiting for tomorrow.
grep -E '^(RESEND_API_KEY|OWNER_EMAIL|EMAIL_FROM)=' .env.production > /tmp/dr.env 2>/dev/null || true
docker run --rm --env-file /tmp/dr.env -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app /tools/domain-rest.mjs >> "$LOG" 2>&1 || true
rm -f /tmp/dr.env

# 4) AI advisor: daily "how to move the needle" recommendations, grounded in REAL deliverability
#    facts (failure rate, bounces, campaign age, Smartlead warm-up), so it never guesses.
grep -E '^(ANTHROPIC_API_KEY|SMARTLEAD_API_KEY)=' .env.production > /tmp/adv.env
docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/mpc-out:/out -v /opt/recruiteros/tools:/tools:ro --env-file /tmp/adv.env \
  --entrypoint node recruiteros-app /tools/mpc-advisor.mjs >> "$LOG" 2>&1 || true
rm -f /tmp/adv.env

echo "===== done $(date -u +%FT%TZ) =====" >> "$LOG"
