# Overnight sourcing queue: how it runs and how it heals

The JD Sourcing overnight queue runs searches and enrichment server-side so
recruiters queue work, close the tab, and wake up to delivered lists. This
runbook covers the moving parts, the guardrails that keep it alive, and what
to check when something looks stuck.

## The belt, end to end

1. **Queueing.** "Queue for overnight" (or an Enrich resume) adds an item to
   `sourcing_night_queue_v1` (snapshot on the app `/data` volume). Items are a
   per-item state machine: `queued -> search -> kold -> koldDb -> laxis -> done`.
   Code: `integration/lib/sourcing/nightQueue.ts`.
2. **Ticking.** `recruiteros-nightqueue.timer` on `ros` (systemd, every 45s)
   docker-execs a wget inside the app container against
   `GET /api/sourcing/night?secret=$RECRUITEROS_CRON_SECRET`. One bounded step
   per tick; the long search step runs fire-and-forget behind a mutex.
3. **Delivery.** The same tick sweeps `tickSourcingAutoflow`
   (`integration/lib/sourcing/autoflow.ts`): finished recruiting lists are
   promoted to Candidates and pushed to OS Text (Telnyx cell-validated),
   stamping `run.autoflow.sentAt`. OS Text campaigns then WAIT for a human-set
   send date and time (the send-gate fail-safe); delivery does not mean texting.
4. **The card.** The queue card is a WORKING queue, not a history log. Done
   items show "N emails + N phones added · in Candidates + OS Text", linger
   about an hour, then clear themselves once `autoflow.sentAt` confirms
   delivery (a day at most if never delivered). Error items stay until removed.
   The permanent record is the saved list (journey strip included).

## The guardrail ladder (cheapest heal first)

| Layer | Where | Trips when | Action |
| --- | --- | --- | --- |
| Rung retry | state machine | a worker job dies mid-run (deploy, crash) | re-runs that rung once, then moves on |
| Latch steal | `tickNightQueue` | a step hangs >15 min (vendor call never resolves) | steals the tick mutex so the queue keeps moving |
| Latch finally | `tickNightQueue` | the snapshot save throws | latch still clears; a wedged latch can never outlive one tick |
| Autoflow self-heal | `autoflow.ts` | orphaned job refs (60 min) or a stalled chain (45 min idle) | queues one resume, then force-sends with what it has |
| Host watchdog | `nightqueue-watchdog.timer` on `ros` (every 5 min, `/usr/local/bin/nightqueue-watchdog.sh`, OUTSIDE the git checkout) | app container not running, OR active items with no `updatedAt` progress for 45 min | revives/restarts the app (snapshot is durable, next tick resumes) and texts the ops cell (rate-limited, one per 6h) |

The ordering is deliberate: in-code heals fire well before the host watchdog's
restart, so the big hammer is the last resort. The regression suite
(`integration/scripts/test-sourcing-nightqueue.mts`, run with
`npx tsx scripts/test-sourcing-nightqueue.mts`) pins the prune rules, the
latch-finally shape, and that ladder ordering; run it whenever
`nightQueue.ts` changes.

## When someone says "my overnight search is stuck"

1. **Read the card first.** "sending to Candidates + OS Text…" on a done item
   means the sweeper hasn't confirmed delivery yet (it retries itself).
   "stopped: …" is the only state needing a human.
2. **Is the ticker alive?**
   `journalctl -u recruiteros-nightqueue.service --since '10 minutes ago'`
   on `ros`; healthy ticks print `{"ok":true,"ticked":true}` every 45s.
   `Connection refused` during a deploy is normal for one or two ticks.
3. **Is the queue progressing?** Read the snapshot from the host:
   `/var/lib/docker/volumes/recruiteros_app_data/_data/snap_sourcing_night_queue_v1.json`.
   Every real step bumps the active item's `updatedAt`; older than 45 min with
   active items = the watchdog will restart the app within 5 minutes anyway.
4. **Watchdog history:** `/var/log/nightqueue-watchdog.log` records every
   intervention. Repeated stall restarts point at a vendor flow change
   (check `laxis-monitor` / `koldinfo-monitor` results next).
5. **Delivery but no texts:** that is the OS Text send gate working as
   designed; open the campaign and set a send date and time.

## Sharp edges

- The night route must be the ONLY driver of the queue and the autoflow sweep
  (instrumentation.ts gets a separate bundle instance whose stale store copy
  can clobber live data; see the autoflow header comment).
- The queue snapshot must never be hand-edited under a running app: the app's
  next save clobbers it. Seed/repair recipe: write the file, then
  `docker restart recruiteros-app-1`.
- `promotedCount` on a run counts only pipeline rows NEW in the last sweep; a
  re-enrich top-up legitimately reads 0 while the list is fully delivered.
