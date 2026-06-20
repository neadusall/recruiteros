# Distributed research workers — scaling free naming toward 5K/day

The free naming sources (Common Crawl index, Google News RSS, company team pages, GitHub) rate-limit
**per IP**. Adding cheap worker boxes — each with its **own IP and free IPv6 /64** — gives each box its
own quota, so horizontal scale-out is the path toward 5K/day without paying for data. But two things
that a June-2026 reality probe made concrete, so we don't fool ourselves:

> **The binding constraint is the hosted index server (`index.commoncrawl.org`), not server count.**
> The WARC data host (S3) is robust and indifferent to IP. The *index* is fragile: it 503s/timeouts
> after a handful of requests **even sequentially**, and fails ~100% at concurrency ≥4. ~80 index
> requests from one IP was enough to drop it to 0% success for minutes. So pace, not box count, is the
> real lever — and **boxes only multiply throughput if the index gives each IP an independent quota
> AND isn't globally degraded** (when it is, more boxes all see the same flak). Scale out, but verify
> per-IP independence by adding ONE box first, not three.
>
> What more servers genuinely fix: per-IP limits on news / team pages / GitHub, and *some* index
> headroom. What they do **not** fix: search engines that block datacenter IPs wholesale (we moved off
> those onto Common Crawl) — and they don't fix a flaky/over-hammered index, which only **politeness**
> fixes. That politeness is now enforced by the index governor in `commonCrawl.ts` (below).

## Architecture

```
   worker box #1 ──┐   (scrapes with its own IP/quota)
   worker box #2 ──┼──►  POST /api/in-market/worker  ──►  MAIN server
   worker box #3 ──┘     claim jobs / submit results       (merges into the curated DB,
                                                             serves the UI, runs its own
                                                             curation tick too)
```

Each worker loops: **claim** a batch of `(company, role)` jobs → **research** each decision-maker
with its own IP → **submit** the named rows back. The main server leases out jobs (so workers don't
duplicate) and merges results idempotently. Workers add capacity on top of the main server's own
curation tick — nothing is lost if a worker dies; its leases simply expire and the work is re-handed.

## Setup

### 1. On the MAIN server — turn the endpoint on

Set a shared secret in `/opt/recruiteros/.env.production` and recreate the app:

```bash
ssh root@recruitersos.co "cd /opt/recruiteros && echo 'INMARKET_WORKER_TOKEN='\$(openssl rand -hex 24) >> .env.production && grep INMARKET_WORKER_TOKEN .env.production && docker compose up -d --force-recreate app"
```

Copy the printed token — the workers need it. (Until this is set, the worker endpoint is a no-op 401,
so the feature is inert by default.)

### 2. For EACH worker box (~$5–40/mo Hetzner, its own /64)

```bash
# one-time: clone the repo (use a deploy key / token for the private repo)
git clone https://github.com/neadusall/recruiteros.git /opt/recruiteros && cd /opt/recruiteros

# provision: installs Node, deps, this box's IPv6 /64 egress, and a systemd worker service
WORKER_MAIN_URL=https://recruitersos.co \
WORKER_TOKEN=<the token from step 1> \
bash setup-worker.sh
```

That's it. The worker is now pulling jobs, scraping with its own IP, and pushing results. Follow it:

```bash
journalctl -u recruiteros-worker -f
# [worker] … claimed 120 → researched 118 (named 41) → submitted (new 39)
```

Repeat step 2 on as many boxes as you want — each one adds ~1× more free quota.

## Tuning

Per-worker env (in `/etc/recruiteros-worker.env`, then `systemctl restart recruiteros-worker`):

| Var | Default | What |
|---|---|---|
| `WORKER_BATCH` | 120 | jobs claimed per cycle |
| `WORKER_CONCURRENCY` | 8 | parallel researches on the box (raise on bigger boxes). **Safe to raise** — the index governor paces CC independently, so this only widens the robust sources (ATS / GitHub / S3 / news). |
| `WORKER_IDLE_SLEEP_MS` | 30000 | pause when the main has no due work |
| `CC_INDEX_CONCURRENCY` | 1 | hard cap on simultaneous `index.commoncrawl.org` requests. Leave at 1. |
| `CC_INDEX_MIN_INTERVAL_MS` | 2000 | pacing floor between index requests (adaptive — widens automatically on 503). Raise to be even gentler. |
| `CC_INDEX_MAX_INTERVAL_MS` | 30000 | adaptive ceiling the governor will back off to under sustained throttling. |
| `WORKER_HEALTH_PORT` | 0 (off) | port for the box's local `/health` endpoint. Set it (e.g. 8787) to expose health. |
| `WORKER_HEALTH_TOKEN` | — | optional bearer token to protect `/health` (recommended if the port is reachable). |

## Failsafes (built in)

- **Index reputation governor** (`commonCrawl.ts`) — every `index.commoncrawl.org` request funnels
  through one **single-flight, paced, adaptive** gate (default: 1 at a time, ≥2s apart). On a `503`/`429`
  it **honors `Retry-After`**, widens spacing up to 30s, and sets a global cooldown; on clean success it
  relaxes back toward the floor. A consecutive-trip **circuit breaker** rests the whole source with an
  **escalating** rest (5 → 10 → … → 30 min) so a persistently throttled IP backs all the way off instead
  of grinding its reputation down. This is what keeps a box from getting red-flagged.
- The per-domain **cache** (30d positive / 7d negative) means each company hits the index at most once a
  month — so steady-state index pressure is just the *new*-company front, not the whole pool.
- Workers **never crash out of the loop** — claim/submit failures back off exponentially and retry;
  per-company research errors are skipped.
- Job **leases** (10 min) stop two workers researching the same company; the merge is idempotent by
  id, so even an expired-lease overlap only wastes a little work, never corrupts data.
- Submitted rows are **sanitized** (whitelisted + clamped) before they touch the curated store.
- A worker dying just stops adding capacity; the main server keeps running its own tick.

## Health: knowing each box is sustainable

Two ways to watch the fleet, both built in:

**1. Per-box `/health` endpoint.** Set `WORKER_HEALTH_PORT` (e.g. 8787) on a box and it serves a live
JSON report — loop stats (cycles, named/hour, consecutive fails), the full Common Crawl governor state,
and per-search-engine health — and returns **HTTP 503 when the box is unhealthy** so a monitor can alert
on the status code alone. Protect it with `WORKER_HEALTH_TOKEN` if the port is reachable.

```bash
curl -s -H "Authorization: Bearer $WORKER_HEALTH_TOKEN" http://<box>:8787/health | jq .status,.reasons
# "healthy"  []      ← sustainable
# "degraded" ["common-crawl index spacing maxed (16000ms)"]   ← strained, still producing
# "unhealthy"["common-crawl resting 240s"]   ← back off / rotate this box
```

**2. Fleet roll-up on the main server.** Each box piggybacks a compact health digest on its claim/submit
calls (no extra request), so `fleetStatus()` aggregates every box: per-worker `health` plus a fleet-wide
`health` field = the **worst online box** (so one strained IP never hides behind healthy ones). This is
the single "is the whole model sustainable right now" read.

## Monitoring & thresholds

`commonCrawlHealth()` exposes live governor telemetry (also embedded in `/health` above) — alert on
these. The point is to catch reputation strain **early** and back off *before* the index starts refusing
the box, never to push toward the ceiling.

| Signal (`commonCrawlHealth().index`) | Healthy | Warn | Act |
|---|---|---|---|
| `breakerTrips` | 0 | 1 | **≥2** — IP is being throttled repeatedly; this box should rest longer / be rotated |
| `spacingMs` (adaptive) | ~2000 | >8000 | **at `MAX` (30000)** — index is hostile to this IP right now; don't add load |
| `cooldownForSec` | 0 | >0 occasionally | **>0 sustained** — honoring Retry-After; expected, but if constant the index is degraded |
| `resting` / `restingForSec` | false | brief | **frequent/long rests** — the source is effectively down for this box |

Two derived alerts worth adding at the **main** server (it sees all boxes): **named-rate drop** (named/day
falls while jobs are flowing → index trouble, not a data problem) and **per-box divergence** (one box
resting far more than peers → that IP/box is cooked; rotate it). Rule of thumb: if a box sits at max
spacing with `breakerTrips ≥ 2` for an hour, take it out of rotation for a day — that's the cheap way to
preserve its standing instead of burning it.

## Cost / expectation

Honest, corrected math (CC = Common Crawl, **not** Crunchbase — there is no anti-bot and no
datacenter-IP blocking, so there are **no proxy or per-record data fees**):

- **Server cost only:** ~$5–15/mo per Hetzner box → **~$10–40/mo for 2–3 boxes.**
- **Throughput is gated by the index server's stability, not your box count.** One box, run politely,
  sustainably yields a few hundred to ~1K named/day on free sources. 2–3 boxes put **~3–5K/day within
  reach _if_ the index cooperates and gives each IP its own quota** — which is exactly the thing to
  confirm by adding ONE box first and watching for per-box divergence above.
- The residual gap (companies with no public footprint at all) is the only thing the optional paid rung
  (`RAPID_NAMING_KEY`) covers, and only on misses.

**Recommended rollout (de-risks what the single-IP probe couldn't):** (1) ship the governor on the box
you already have and confirm it sustains a healthy named-rate for a day without `breakerTrips` climbing;
(2) add **one** more box, verify it earns its own quota (both boxes productive, neither resting
abnormally); (3) only then add the third. Don't buy three up front.
