#!/usr/bin/env bash
# Host wrapper for the send fuse CLI (runs send-fuse.mjs in the tools container with the
# owner-alert keys). Usage: send-fuse.sh [--status | --trip "why" | --clear | --release SRC]
set -uo pipefail
cd /opt/recruiteros
grep -E '^(RESEND_API_KEY|OWNER_EMAIL|EMAIL_FROM|MPC_[A-Z_]+)=' .env.production > /tmp/fuse.env 2>/dev/null || true
docker run --rm --env-file /tmp/fuse.env -e USER="${SUDO_USER:-${USER:-owner}}" \
  -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
  --entrypoint node recruiteros-app /tools/send-fuse.mjs "$@"
rc=$?
rm -f /tmp/fuse.env
exit $rc
