# Hire Signals → 5K verified prospects/day → BD Bulk (operator runbook)

The pipeline auto-populates the Hiring Signals → BD Bulk funnel with verified decision-makers,
100% free. This is how to turn the two scaling levers on. Both ship OFF (no-op until configured),
so nothing here changes behavior until you set the env vars.

## The pipeline (already live, hands-off)

```
free hiring signals (pool, ~10–20K/day)
  → domain backfill: resolve + VERIFY each company's real web domain (live + on-brand + MX)
  → curation tick (every 5 min, 80 companies): find the real decision-maker (free: team page /
    news / GitHub) + build the work email on the verified domain
  → free email verification: drop role/disposable/malformed/no-MX → "contactable" = a real person
    with a deliverable, verified email
  → [auto-enroll autopilot] → BD Bulk MPC campaign → MPC outreach (BD Bulk's own send controls)
```

Liveness is on the Curated header (🟢/🔴 "pool fed / curated N ago") and the `engine_health` API
action (`{ health, egress, autoEnroll }`).

## Lever 1 — Egress IP rotation (defeat the free-source rate-limit ceiling)

Free sources rate-limit per source IP. Rotating across several Hetzner IPs keeps us 100% free at
5K/day. See lib/net/egress.ts.

**Buy on Hetzner**
- Hetzner **Cloud**: 8 × Floating IPv4 (~€1.19/mo each ≈ €9–10/mo), all assigned to the keeper.
- Hetzner **Robot/dedicated**: one /29 IPv4 subnet (8 usable).
- Free bonus: the server's included /64 IPv6 — unlimited rotation for IPv6-capable sources.

**Attach the IPs to the host** (per extra IPv4, on the keeper):
```
ip addr add <IP>/32 dev eth0      # make persistent via netplan / systemd-networkd
```
(Hetzner Cloud floating IPs: assign in console, then add to the interface as above.)

**Configure the app** (`.env.production` on the keeper):
```
INMARKET_EGRESS_IPS=1.2.3.4,1.2.3.5,1.2.3.6,1.2.3.7,1.2.3.8,1.2.3.9,1.2.3.10,1.2.3.11
# optional IPv6 (free /64): either explicit
INMARKET_EGRESS_IPV6=2a01:4f8:abc:def::10,2a01:4f8:abc:def::11
# …or auto-generate N from the /64 base
INMARKET_EGRESS_IPV6_BASE=2a01:4f8:abc:def::
INMARKET_EGRESS_IPV6_COUNT=16
```
Redeploy. Confirm via `engine_health` → `egress.enabled: true` + `egress.ips`. The default route
stays in the pool, so requests still flow even if an IP isn't up yet.

## Lever 2 — Auto-enroll autopilot (populate BD Bulk hands-off; never auto-sends)

See lib/inmarket/autoEnroll.ts. Every 5 min it enrolls verified-contactable prospects into a BD
Bulk campaign up to a daily cap. Enrolling only CREATES the prospect on the campaign — the MPC
emails still send only under BD Bulk's own controls. Point it at a campaign that is NOT on
send-autopilot and nothing leaves the building automatically.

```
INMARKET_AUTOENROLL=1
INMARKET_AUTOENROLL_WORKSPACE=<workspaceId>
INMARKET_AUTOENROLL_CAMPAIGN=<bd-bulk-campaignId>
INMARKET_AUTOENROLL_DAILY_CAP=5000      # default 5000
INMARKET_AUTOENROLL_BATCH=300           # default 300 per tick
```
Confirm via `engine_health` → `autoEnroll.enabled: true`, `autoEnroll.today` climbing toward the cap.

## Throughput dials (lib/inmarket/accumulator.ts)

`CURATE_BATCH` (80) × `CURATE_CYCLE_MS` (5 min) ≈ 23K researched/day; `DOMAIN_BATCH` (80/cycle)
backfills domains. With egress rotation in place these can be raised safely toward 5K+ verified/day
— raise gradually and watch `engine_health` error fields + source response codes.
