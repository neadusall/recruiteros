# Distributed research workers — scaling free naming toward 5K/day

The free naming sources (Common Crawl index, Google News RSS, company team pages, GitHub) all
rate-limit **per IP**. One server hits that ceiling. The fix is horizontal: add cheap worker boxes,
each with its **own IP and free IPv6 /64**, so each one gets its **own full quota**. Three boxes ≈
3× the sustainable free throughput. This is the legitimate path to 5K/day without paying for data.

> What more servers fix: the per-IP rate limits on CC / news / team pages / GitHub.
> What they do **not** fix: search engines that block datacenter IPs wholesale (we've moved off
> those onto Common Crawl, so it doesn't matter).

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
| `WORKER_CONCURRENCY` | 8 | parallel researches on the box (raise on bigger boxes) |
| `WORKER_IDLE_SLEEP_MS` | 30000 | pause when the main has no due work |

## Failsafes (built in)

- Workers **never crash out of the loop** — claim/submit failures back off exponentially and retry;
  per-company research errors are skipped.
- Job **leases** (10 min) stop two workers researching the same company; the merge is idempotent by
  id, so even an expired-lease overlap only wastes a little work, never corrupts data.
- Submitted rows are **sanitized** (whitelisted + clamped) before they touch the curated store.
- A worker dying just stops adding capacity; the main server keeps running its own tick.

## Cost / expectation

Honest math: one box sustainably yields a few hundred to ~1K named/day on free sources. **2–3 worker
boxes (~$10–120/mo total) puts a consistent ~3–5K/day in reach** — server cost only, no per-record
data fees. The residual gap (companies with no public footprint at all) is the only thing the
optional paid rung (`RAPID_NAMING_KEY`) covers, and only on misses.
