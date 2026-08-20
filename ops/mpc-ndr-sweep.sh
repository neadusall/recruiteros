#!/usr/bin/env bash
# mpc-ndr-sweep: fleet bounce visibility (see /opt/recruiteros/tools/ndr-sweep.mjs), then the
# deliverability refresh + domain-rest breaker, so a domain that starts bouncing is benched the
# SAME 4-hour cycle its bounces are found, not at tomorrow's rota. Rest ladder: 2, 7, 14 days.
# Installed at /usr/local/bin/mpc-ndr-sweep.sh (mpc-ndr-sweep.timer); this is the tracked copy.
set -uo pipefail
export SENDINGAC_MAILBOX_API_KEY="$(grep '^SENDINGAC_MAILBOX_API_KEY=' /opt/recruiteros/.env.production | cut -d= -f2-)"
LOG=/opt/recruiteros/mpc-out/ndr-sweep-$(date +%F).log
IMAPLOG=$LOG
# OWN-SMTP lane first: sweep the Mailcow boxes over IMAP (the Mailbox API cannot
# see them), so the host sweep below merges BOTH lanes into one bounce ledger.
grep -E '^(SENDERS_ENCRYPTION_KEY|APP_ENCRYPTION_KEY)=' /opt/recruiteros/.env.production > /tmp/ndr-imap.env 2>/dev/null || true
docker run --rm --env-file /tmp/ndr-imap.env -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro   -v /opt/recruiteros/mpc-out:/out --entrypoint node recruiteros-app   /tools/ndr-sweep-imap.mjs >> "$IMAPLOG" 2>&1 || true
rm -f /tmp/ndr-imap.env
node /opt/recruiteros/tools/ndr-sweep.mjs >> "$LOG" 2>&1
echo "$(date -u +%FT%TZ) ndr-sweep exit $?" >> "$LOG"
grep -E '^(SMARTLEAD_API_KEY)=' /opt/recruiteros/.env.production > /tmp/ndr-dv.env 2>/dev/null || true
docker run --rm --env-file /tmp/ndr-dv.env -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out --entrypoint node recruiteros-app \
  /tools/mpc-deliverability.mjs >> "$LOG" 2>&1
echo "$(date -u +%FT%TZ) deliverability refresh exit $?" >> "$LOG"
grep -E '^(PORKBUN_API_KEY|PORKBUN_SECRET_KEY|MPC_DMARC_POLICY|RESEND_API_KEY|EMAIL_FROM|OWNER_EMAIL)=' /opt/recruiteros/.env.production > /tmp/ndr-dr.env 2>/dev/null || true
docker run --rm --env-file /tmp/ndr-dr.env -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out --entrypoint node recruiteros-app \
  /tools/domain-rest.mjs >> "$LOG" 2>&1
echo "$(date -u +%FT%TZ) domain-rest exit $?" >> "$LOG"
# SEND FUSE (2026-08-20): re-evaluate the fleet fuse + per-source breakers on the fresh sweep, so a
# bounce spike trips the fuse the same cycle it is seen (and the owner is emailed), not at the next
# send tick. Exit 2 = tripped (informational here; the senders hold on their own).
grep -E '^(RESEND_API_KEY|EMAIL_FROM|OWNER_EMAIL|MPC_[A-Z_]+)=' /opt/recruiteros/.env.production > /tmp/ndr-fuse.env 2>/dev/null || true
grep -E '^ALERT_(TELNYX_KEY|SMS_FROM|SMS_TO|SMS_PROFILE)=' /etc/ros-alert.env >> /tmp/ndr-fuse.env 2>/dev/null || true  # owner SMS on fuse trips
docker run --rm --env-file /tmp/ndr-fuse.env -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out --entrypoint node recruiteros-app \
  /tools/send-fuse.mjs >> "$LOG" 2>&1
echo "$(date -u +%FT%TZ) send-fuse exit $?" >> "$LOG"
rm -f /tmp/ndr-dv.env /tmp/ndr-dr.env /tmp/ndr-fuse.env
