#!/usr/bin/env bash
#
# Point the Spend master's receipt vault at a mailbox your vendors email receipts to.
#
# Owner Console -> Spend master -> "Month by month" reads these mailboxes over IMAP,
# finds the receipts, renders each one to an image, and files it to the month it
# belongs to. The connection is READ-ONLY: nothing is deleted, nothing is marked
# read, and the sweep can be re-run over any date range to backfill old months.
#
#   Run on the server, ONCE PER MAILBOX (up to four):
#     bash /opt/recruiteros/set-billing-inbox.sh <email> <app-password> [imap-host] [port]
#
#   e.g.
#     bash /opt/recruiteros/set-billing-inbox.sh ryan@lumesp.com 'app-password'
#     bash /opt/recruiteros/set-billing-inbox.sh neadusall@gmail.com 'app-password'
#     bash /opt/recruiteros/set-billing-inbox.sh rrnead@gmail.com 'app-password'
#     bash /opt/recruiteros/set-billing-inbox.sh ryan@dev.com 'app-password' imap.yourhost.com
#
# Each run takes the next free slot, or updates the entry if that address is already
# stored. Rebuild happens once at the end of each run, so add them one after another.
#
# The IMAP host is guessed from the address when omitted: imap.gmail.com for Gmail,
# outlook.office365.com for Microsoft 365 and for custom domains. Pass it explicitly
# for anything else.
#
# USE AN APP PASSWORD, NOT THE ACCOUNT PASSWORD:
#   Gmail            myaccount.google.com/apppasswords  (needs 2-step verification on)
#   Microsoft 365    account.microsoft.com security -> app passwords, or ask the
#                    tenant admin to allow IMAP for the mailbox
# Both providers reject the real password over IMAP.
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

ADDR="$1"
PASS="$2"
HOST="${3:-}"
PORT="${4:-993}"

ENV=".env.production"
touch "$ENV"
chmod 600 "$ENV"

# Slots are BILLING_INBOX_USER, then BILLING_INBOX_2_USER … _4_USER.
prefix_for_slot() { [ "$1" = "1" ] && echo "BILLING_INBOX" || echo "BILLING_INBOX_$1"; }

SLOT=""
# Reuse the slot this address already occupies, so re-running only rotates the password.
for n in 1 2 3 4; do
  P="$(prefix_for_slot "$n")"
  if grep -qE "^${P}_USER=${ADDR}$" "$ENV"; then SLOT="$n"; break; fi
done
# Otherwise take the first empty one.
if [ -z "$SLOT" ]; then
  for n in 1 2 3 4; do
    P="$(prefix_for_slot "$n")"
    if ! grep -qE "^${P}_USER=" "$ENV"; then SLOT="$n"; break; fi
  done
fi
if [ -z "$SLOT" ]; then
  echo "All four mailbox slots are in use. Remove one from $ENV first:"
  grep -E '^BILLING_INBOX(_[2-4])?_USER=' "$ENV" || true
  exit 1
fi

PREFIX="$(prefix_for_slot "$SLOT")"

grep -v -E "^${PREFIX}_(USER|PASS|HOST|PORT)=" "$ENV" > "$ENV.tmp" 2>/dev/null || true
{
  echo "${PREFIX}_USER=$ADDR"
  echo "${PREFIX}_PASS=$PASS"
  [ -n "$HOST" ] && echo "${PREFIX}_HOST=$HOST"
  echo "${PREFIX}_PORT=$PORT"
} >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo "Saved $ADDR to slot $SLOT. Mailboxes now configured:"
grep -E '^BILLING_INBOX(_[2-4])?_USER=' "$ENV" | sed 's/^/  /'

echo ""
echo "Rebuilding (a few minutes)..."
docker compose up -d --build app

cat <<'DONE'

Done. Next:
  1. Open https://recruitersos.co/owner-console#burn
  2. Under "Month by month", choose how far back to look and press
     "Pull receipts from the mailbox". The first pull takes a few minutes
     because every receipt is rendered to an image.
  3. Anything still showing "no receipt" is listed in "Where the receipts
     come from" with that vendor's billing page, so it can be attached by hand.

The nightly sweep keeps it current on its own once the timer calls
  POST /api/owner/receipts/cron?monthsBack=3
with the x-cron-secret header, so a month cannot pass unreported.
DONE
