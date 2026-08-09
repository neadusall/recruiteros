# ops/ — scripts that were living only on the production box

These four run on `ros` (178.156.170.244) out of `/opt/recruiteros`, driven by systemd
timers, but they had never been committed. They existed on that disk and nowhere else.
This directory is the backup copy, so the same scripts are readable from any machine.

| script | trigger | what it does |
| --- | --- | --- |
| `fleet-watchdog.sh` | `fleet-watchdog.timer` | polls each scraper/worker box `/health`, classifies OK/WARN/STUCK/DOWN, alerts only on a state *change* |
| `koldinfo-monitor.sh` | `koldinfo-monitor.timer`, daily | logs into app.koldinfo.com through the laxis-worker and checks both doors the enrichment chain drives (LinkedIn-URL page + People/Business-Email DB filter pages) |
| `laxis-monitor.sh` | `laxis-monitor.timer`, every 6h | checks the laxis-worker can still reach app.laxis.tech and find the Enrich Prospects entry point |
| `signals-watch-check.sh` | `recruiteros-signals-watch-monitor.timer`, every 15m | judges the In-Market discovery belt: heartbeat age, consecutive tick errors, feed budget, news/job feed outages, and whether any watchlist exists at all. Emails the owner via Resend on a state change, re-alerts every 6h, sends one all-clear on recovery. Lives at `/opt/recruiteros/bin/`. |

All three are dependency-free (curl/docker/logger), read-only apart from a single worker
restart in their recovery ladder, and take `ALERT_WEBHOOK_URL` from the systemd unit.

## The signals-watch timer: how it was broken, and what fixes it

Worth writing down because it failed silently for a long time and looked exactly like a
quiet market. `recruiteros-signals-watch.timer` fired every 15 minutes at
`http://127.0.0.1:3000` and got `curl: (7) Failed to connect` every single time. Nothing
has ever listened there: the app container publishes `3000/tcp` only on the Docker
network, and Caddy owns 443 on the host. So In-Market discovery had never run once —
`totalTicks: 0` — while every dashboard read zero and looked healthy.

The monitor DID detect it on every tick and wrote `UNREACHABLE` to journald, where nobody
reads. That is the more important lesson: the detector was correct and wired to nothing.

Two settings fix it, and both live outside git, so re-apply them on any rebuilt box:

    # /etc/recruiteros-signals-watch.env
    WATCH_URL=https://recruitersos.co

    # /etc/systemd/system/recruiteros-signals-watch.service — reach the app THROUGH Caddy,
    # the same way ros-sentinel.sh already proves works from this host.
    ExecStart=/usr/bin/curl -fsS -m 20 -k --resolve recruitersos.co:443:127.0.0.1 \
      -X POST -H "x-cron-secret: ${RECRUITEROS_CRON_SECRET}" \
      "${WATCH_URL}/api/signals/watch?tick=1"

Verify with `systemctl start recruiteros-signals-watch.service` — a healthy run logs
`{"ok":true,"ticked":true}` and `?status=1` shows `totalTicks` climbing.

## Not included: `set-vault-key.sh`

`/opt/recruiteros/set-vault-key.sh` is also uncommitted on the box. It is a
credential-installation script for the Owner Console password vault, so it is deliberately
left out of git rather than copied here. It stays on the box only.

## Keeping these in sync

The box copies are the live ones. If you edit a script here, copy it up:

    scp ops/fleet-watchdog.sh ros:/opt/recruiteros/fleet-watchdog.sh

and if you edit one on the box, copy it back down into this directory and commit, or the
next person to read this repo gets a stale version.
