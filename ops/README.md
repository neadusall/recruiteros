# ops/ — scripts that were living only on the production box

These four run on `ros` (178.156.170.244) out of `/opt/recruiteros`, driven by systemd
timers, but they had never been committed. They existed on that disk and nowhere else.
This directory is the backup copy, so the same scripts are readable from any machine.

| script | trigger | what it does |
| --- | --- | --- |
| `fleet-watchdog.sh` | `fleet-watchdog.timer` | polls each scraper/worker box `/health`, classifies OK/WARN/STUCK/DOWN, alerts only on a state *change* |
| `koldinfo-monitor.sh` | `koldinfo-monitor.timer`, daily | logs into app.koldinfo.com through the laxis-worker and checks both doors the enrichment chain drives (LinkedIn-URL page + People/Business-Email DB filter pages) |
| `laxis-monitor.sh` | `laxis-monitor.timer`, every 6h | checks the laxis-worker can still reach app.laxis.tech and find the Enrich Prospects entry point |

All three are dependency-free (curl/docker/logger), read-only apart from a single worker
restart in their recovery ladder, and take `ALERT_WEBHOOK_URL` from the systemd unit.

## Not included: `set-vault-key.sh`

`/opt/recruiteros/set-vault-key.sh` is also uncommitted on the box. It is a
credential-installation script for the Owner Console password vault, so it is deliberately
left out of git rather than copied here. It stays on the box only.

## Keeping these in sync

The box copies are the live ones. If you edit a script here, copy it up:

    scp ops/fleet-watchdog.sh ros:/opt/recruiteros/fleet-watchdog.sh

and if you edit one on the box, copy it back down into this directory and commit, or the
next person to read this repo gets a stale version.
