#!/usr/bin/env bash
#
# The one-command receipt pull. Sweeps every connected inbox for the last N months,
# waits for the scan, and prints what's in the books — including a domain-registrar tally.
#
# Run it from anywhere (your PC's PowerShell is fine), one line:
#   ssh root@178.156.170.244 "bash /opt/recruiteros/pull-receipts.sh"
# Look back further (default 3 months):
#   ssh root@178.156.170.244 "bash /opt/recruiteros/pull-receipts.sh 6"
#
cd /opt/recruiteros || { echo "cannot find /opt/recruiteros"; exit 1; }
MONTHS="${1:-3}"
SECRET=$(grep -E '^RECRUITEROS_CRON_SECRET=' .env.production | cut -d= -f2- | tr -d '"')
if [ -z "$SECRET" ]; then echo "could not read the cron secret from .env.production"; exit 1; fi

echo ">>> sweeping the last ${MONTHS} months across every inbox (receipts / invoices / \$ amounts)..."
curl -sS -X POST "https://recruitersos.co/api/owner/receipts/cron?monthsBack=${MONTHS}&wait=0&vendors=0" -H "x-cron-secret: $SECRET"
echo
echo ">>> scanning in the background, giving it 3 minutes..."
sleep 180

docker compose exec -T app cat /data/snap_owner_spend_receipts_v1.json 2>/dev/null | python3 -c '
import sys, json, collections
try:
    d = json.loads(sys.stdin.read())
except Exception:
    print("could not read the vault yet - wait a minute and run it again"); sys.exit()
r = [x for x in d.get("receipts", []) if (x.get("period") or "") >= "2026-06"]
print("")
print("=== RECEIPTS IN THE BOOKS (June 2026 onward):", len(r), "===")
for v, n in collections.Counter(x.get("vendor") for x in r).most_common():
    print(f"  {n:3}  {v}")
print("")
print("domain registrars:")
for name in ["Dynadot", "Porkbun", "Namecheap", "GoDaddy"]:
    print("  ", (name + ":").ljust(11), sum(1 for x in r if x.get("vendor") == name), "found")
lume = [s for s in d.get("sweeps", []) if s.get("mailbox") == "ryan@lumesp.com"]
print("")
print("ryan@lumesp.com swept:", ("YES, " + str(lume[0].get("imported")) + " found") if lume else "not yet - run again in a minute")
'
echo
echo ">>> if any inbox was still scanning, just run the same command again to catch the rest."
