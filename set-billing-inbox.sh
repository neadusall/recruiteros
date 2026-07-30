#!/usr/bin/env bash
#
# Point the Spend master's receipt vault at the mailbox your vendors already email.
#
# Owner Console -> Spend master -> "Month by month" reads that mailbox over IMAP,
# finds the receipts, renders each one to an image, and files it to the month it
# belongs to. The connection is READ-ONLY: nothing is deleted, nothing is marked
# read, and the sweep can be re-run over any date range to backfill old months.
#
#   Run on the server:
#     bash /opt/recruiteros/set-billing-inbox.sh <email> <app-password> [imap-host] [port]
#
#   e.g.
#     bash /opt/recruiteros/set-billing-inbox.sh ryan@lumesp.com 'app-password'
#
# The host is guessed from the address when omitted (Outlook/Microsoft 365 for a
# custom domain, imap.gmail.com for Gmail). Use an APP PASSWORD, not the account
# password: Microsoft 365 and Gmail both refuse the real one over IMAP.
#
# WITHOUT this script the vault falls back to the resume inbox's credentials
# (RESUME_INBOX_USER / RESUME_INBOX_PASS), because that is the same mailbox in
# practice. Run this only when billing should read a DIFFERENT mailbox, or when
# the resume inbox has never been configured.
#
# Keys are written to .env.production (gitignored, never committed) and passed as
# arguments, so this script holds no secrets.
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ "$#" -lt 2 ]; then
  echo "usage: bash set-billing-inbox.sh <email> <app-password> [imap-host] [port]"
  exit 1
fi

USER_ADDR="$1"
PASS="$2"
HOST="${3:-}"
PORT="${4:-993}"

ENV=".env.production"
touch "$ENV"

grep -v -E '^BILLING_INBOX_(USER|PASS|HOST|PORT)=' "$ENV" > "$ENV.tmp" 2>/dev/null || true
{
  echo "BILLING_INBOX_USER=$USER_ADDR"
  echo "BILLING_INBOX_PASS=$PASS"
  [ -n "$HOST" ] && echo "BILLING_INBOX_HOST=$HOST"
  echo "BILLING_INBOX_PORT=$PORT"
} >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo "Billing mailbox saved to .env.production. Rebuilding (a few minutes)..."
docker compose up -d --build app

cat <<'DONE'

Done. Next:
  1. Open https://recruitersos.co/owner-console#burn
  2. Under "Month by month", choose how far back to look and press
     "Pull receipts from the mailbox". The first pull takes a few minutes
     because every receipt is rendered to an image.
  3. Anything that still shows "no receipt" is listed in "Where the receipts
     come from" with the vendor's billing page, so it can be attached by hand.

To read a second mailbox as well, add BILLING_INBOX_2_USER / _PASS / _HOST to
.env.production the same way (up to four are supported).
DONE
