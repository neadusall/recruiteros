#!/usr/bin/env bash
#
# What Hetzner actually charges per month, computed from the Hetzner Cloud API, so the
# ONE "Hetzner · Servers (all boxes)" row in Owner Console -> Spend master can be priced
# from a real figure instead of a guess.
#
# It lists every server in the project with its own monthly price, adds the primary IPv4
# addresses and volumes (billed separately, and easy to keep paying for after the server
# they belonged to is gone), and prints the total to type into the row's "Set amount" box.
#
# READ-ONLY: it only ever GETs. It creates, resizes and deletes nothing.
#
#   Run on the server (reads the token already in .env.production):
#     bash /opt/recruiteros/hetzner-cost.sh
#
#   Or with a token you paste, from anywhere with docker + the app container:
#     bash hetzner-cost.sh <hcloud_read_token>
#
# The token is passed to the container through the environment and is never printed,
# logged, or written anywhere. If the stored one is rejected, mint a fresh READ-ONLY
# token: Hetzner Cloud Console -> the project -> Security -> API tokens -> Generate,
# permission "Read". A token belongs to ONE project, so if the scraper fleet lives in a
# separate project, run this once per project and add the totals.
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  # Script dir first, then the deploy dir, so it also runs from /tmp on the server.
  for f in .env.production .env /opt/recruiteros/.env.production /opt/recruiteros/.env; do
    [ -f "$f" ] || continue
    TOKEN="$(sed -n 's/^HCLOUD_TOKEN=//p' "$f" | head -1 | tr -d '"'"'"'\r' || true)"
    [ -n "$TOKEN" ] && break
  done
fi
if [ -z "$TOKEN" ]; then
  echo "No HCLOUD_TOKEN found in .env.production and none given."
  echo "usage: bash hetzner-cost.sh <hcloud_read_token>"
  exit 1
fi

CONTAINER="${CONTAINER:-recruiteros-app-1}"
docker exec -i -e HCLOUD_TOKEN="$TOKEN" "$CONTAINER" node - <<'JS'
/* Reads the Hetzner Cloud API and prices the project. Node's global fetch only; no deps.
   Set HZ_FIXTURE_DIR to a folder of servers.json/pricing.json/primary_ips.json/volumes.json
   to run the same arithmetic offline (that is how the numbers below are regression-tested). */
const TOKEN = process.env.HCLOUD_TOKEN || "";
const FIX = process.env.HZ_FIXTURE_DIR || "";

async function get(path, file) {
  if (FIX) return JSON.parse(require("fs").readFileSync(require("path").join(FIX, file), "utf8"));
  const r = await fetch("https://api.hetzner.cloud/v1/" + path, { headers: { Authorization: "Bearer " + TOKEN } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j && j.error ? j.error.message : "HTTP " + r.status;
    throw new Error(
      r.status === 401
        ? "Hetzner rejected the token (" + msg + "). Mint a read-only one in the Cloud Console -> Security -> API tokens."
        : "Hetzner API " + path + ": " + msg
    );
  }
  return j;
}

/* Hetzner quotes every price per location, so a price is only meaningful next to the
   location the thing actually sits in. gross = what the invoice says (VAT included). */
function priceAt(prices, location) {
  const list = prices || [];
  const hit = list.find((p) => p.location === location) || list[0];
  if (!hit || !hit.price_monthly) return { net: 0, gross: 0 };
  return { net: Number(hit.price_monthly.net) || 0, gross: Number(hit.price_monthly.gross) || 0 };
}
const money = (n, cur) => (cur === "EUR" ? "€" : cur === "USD" ? "$" : cur + " ") + n.toFixed(2);

(async () => {
  const [servers, pricing, ips, vols] = await Promise.all([
    get("servers?per_page=50", "servers.json"),
    get("pricing", "pricing.json"),
    get("primary_ips?per_page=50", "primary_ips.json"),
    get("volumes?per_page=50", "volumes.json"),
  ]);

  const P = pricing.pricing || {};
  const CUR = P.currency || "EUR";
  const types = new Map((P.server_types || []).map((t) => [t.name, t.prices]));
  const ipTypes = new Map((P.primary_ips || []).map((t) => [t.type, t.prices]));

  let total = 0;
  const rows = [];
  for (const s of servers.servers || []) {
    const loc = (((s.datacenter || {}).location) || {}).name || "";
    const p = priceAt(types.get(((s.server_type || {}).name) || ""), loc);
    total += p.gross;
    rows.push([s.name, ((s.server_type || {}).name || "?") + " · " + loc + " · " + s.status, p.gross]);
  }
  /* An IPv4 attached to a server is already inside that server's price; a floating or
     detached one is pure waste, so those are what this separates out. */
  let idle = 0;
  for (const ip of ips.primary_ips || []) {
    if (ip.assignee_id) continue;
    const p = priceAt(ipTypes.get(ip.type), (ip.datacenter || {}).location ? ip.datacenter.location.name : "");
    total += p.gross;
    idle += p.gross;
    rows.push([ip.name || ip.ip, ip.type + " · UNATTACHED, still billed", p.gross]);
  }
  const perGb = ((P.volume || {}).price_per_gb_month) || {};
  for (const v of vols.volumes || []) {
    const gross = (Number(perGb.gross) || 0) * (Number(v.size) || 0);
    total += gross;
    rows.push([v.name, "volume " + v.size + " GB" + (v.server ? "" : " · UNATTACHED"), gross]);
  }

  const w = Math.max(4, ...rows.map((r) => String(r[0]).length));
  console.log("");
  console.log("Hetzner, one project, monthly (gross, VAT " + ((Number(P.vat_rate) || 0)) + "%)");
  console.log("-".repeat(w + 46));
  for (const [name, what, gross] of rows) {
    console.log(String(name).padEnd(w) + "  " + String(what).padEnd(34) + money(gross, CUR).padStart(10));
  }
  console.log("-".repeat(w + 46));
  console.log("servers: " + (servers.servers || []).length + "   TOTAL: " + money(total, CUR) + " / month");
  if (idle > 0) console.log("WASTE:   " + money(idle, CUR) + "/mo of IPs billed with nothing attached to them.");
  console.log("");
  console.log("Type " + money(total, CUR) + " into Owner Console -> Spend master ->");
  console.log("\"Hetzner · Servers (all boxes)\" -> Set amount." + (CUR === "USD" ? "" : " That register is in USD, so"));
  if (CUR !== "USD") console.log("convert at the rate on the invoice, or just enter the invoice total when it lands.");
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
JS
