# Deploy runbook: automated outreach videos (capture → compose → fleet → 5K/day)

How to switch on the Hire Signals video pipeline so every contact gets a personalized
outreach video hands-off, and how to scale it to **5K videos/day**.

- **Site:** https://recruitersos.co (portal `/command` → 🤝 Clients; Video Studio `/pip-studio`)
- **Main server:** `root@178.156.170.244`, dir `/opt/recruitersos` (older: `/opt/recruiteros`)
- Prod deploys `main`; the code is already there. This is all **env + infra**, gated OFF by default.

```
Hire Signals contacts → autoCapture (screenshots each job posting)
   → autoVideo (composites your 1 clip over it → 42s video)
   → video fleet (spreads capture+composite across worker boxes)
   → Clients tab shows the 🎬 video, served from shared S3
```

---

## What you provide (the only non-code parts)

| Thing | Why | Where to get it |
|---|---|---|
| **Object storage** (`ROS_S3_*`) | A worker's video must be servable by the main; videos don't fit on the 75GB app disk | **Self-hosted: `setup-minio.sh` on a spare box with a ≥2TB disk** (see Step 1), or Hetzner Object Storage / Cloudflare R2 / AWS S3 |
| **One recorded clip** | Your face/audio, composited over every video (one clip covers all) | Record it in Video Studio `/pip-studio` |
| **Your workspace ID** | So the compositor finds your clip | Owner console / portal (ask Claude to fetch it) |
| **Worker token** | Auth between workers and the main | `INMARKET_WORKER_TOKEN` in the main `.env.production` (set one if absent) |
| **2-3 worker boxes** | Each adds its own CPU → the only way past ~2K/day | Any spare mini server / Hetzner CX/CPX — a worker is just Node + ffmpeg + Chromium + systemd |

### Storage math (why retention is not optional)
A 40s composite ≈ **7–9 MB** (mp4 + gif teaser + jpg poster). At **3K videos/day** that's
~25 GB/day, ~750 GB/month of NEW material. With the **30-day retention sweeper on**, the live
working set plateaus at **90–170K videos ≈ 0.8–1.4 TB** and never grows past it — so one storage
box with ~2 TB usable holds the whole system forever. Without retention it's +9 TB/year.

---

## Step 1 — Shared object storage

**Option A — self-hosted MinIO (own the storage, no per-GB bill).** Pick a spare box with a big
disk (≥2 TB for 3K/day × 30 days), scp `setup-minio.sh` onto it and run:
```bash
MINIO_DATA_DIR=/data/minio FLEET_IPS="<main-ip> <worker-ip> ..." bash setup-minio.sh
```
It installs MinIO as a systemd service, creates the `ros-pip-assets` bucket, a least-privilege
app user, a backstop 30-day lifecycle rule on `videos/`, firewalls port 9000 to the fleet, and
**prints the exact `ROS_S3_*` block to paste** on the main + every worker. Note MinIO needs
`ROS_S3_FORCE_PATH_STYLE=1`.

**Option B — managed bucket** (Hetzner Object Storage / R2 / S3): create a bucket, then add to
`/opt/recruitersos/.env.production`:
```
ROS_S3_BUCKET=ros-pip-assets
ROS_S3_ENDPOINT=https://fsn1.your-objectstorage.com   # Hetzner FSN1 example
ROS_S3_ACCESS_KEY_ID=...
ROS_S3_SECRET_ACCESS_KEY=...
# ROS_S3_REGION=auto            # AWS needs the real region; Hetzner ignores it
# ROS_S3_FORCE_PATH_STYLE=1     # only for MinIO
```
Without this, generation still runs on the main box but the **fleet can't be used** (a worker's
video would live only on its own disk).

## Step 2 — Record one clip
Open `/pip-studio`, record a short clip (your face + a generic line). That's the overlay for
every video. The compositor uses the **latest clip** in your workspace (or pin a specific one with
`INMARKET_AUTOVIDEO_CLIP_ID`).

## Step 3 — Turn on the generators (on the main)
Add to `.env.production`, then `docker compose up -d`:
```
INMARKET_AUTOCAPTURE=1
INMARKET_AUTOCAPTURE_CONCURRENCY=3
INMARKET_AUTOVIDEO=1
INMARKET_AUTOVIDEO_WORKSPACE=<your-workspace-id>
INMARKET_AUTOVIDEO_SECONDS=42
INMARKET_AUTOVIDEO_CONCURRENCY=2
# set a worker token if you'll add workers (any long random string)
INMARKET_WORKER_TOKEN=<long-random-string>
# retention: age composites out after 30 days so storage stays flat (arm this with the fleet)
INMARKET_RETENTION=1
INMARKET_RETENTION_DAYS=30
# links should expire no later than the bytes do
RECRUITEROS_SHARE_TTL_DAYS=30
```

## Step 4 — Add worker boxes (the path to 3–5K/day)
Any always-on Linux box works as a worker — a mini server on your shelf, an idle Hetzner VPS —
as long as it can reach the main over HTTPS and the storage box on 9000. (Keep the Claimie VPS
out of the fleet; don't mix workloads.) On each box (repo checked out), run:
```bash
WORKER_MAIN_URL=https://recruitersos.co \
WORKER_TOKEN=<same as INMARKET_WORKER_TOKEN on the main> \
ROS_S3_BUCKET=... ROS_S3_ENDPOINT=... ROS_S3_ACCESS_KEY_ID=... ROS_S3_SECRET_ACCESS_KEY=... \
ROS_S3_FORCE_PATH_STYLE=1 \
bash setup-video-worker.sh
```
It installs node + ffmpeg + Chromium, then runs the worker as a systemd service (`Restart=always`
— it survives crashes and reboots). Each box claims jobs, captures + composites locally, uploads
the video to S3, and reports back. If a worker dies mid-job nothing is lost: unclaimed work is
re-derived every tick and renders are idempotent by key.

## Step 5 — Tune + verify
- Raise `*_CONCURRENCY` (main and `VIDEO_WORKER_CONCURRENCY` on workers) toward each box's vCPU count; watch `docker stats` / `htop`.
- Progress: the `engine_health` API returns `autoCapture.totalMade`, `autoVideo.totalMade`, and
  `retention` (last sweep, assets expired, bytes freed). Fleet roll-up: `GET /api/in-market/worker?token=…`.
- See the videos: **Clients tab → Asset column → click the 🎬 thumbnail.** The "🎬 with video N"
  legend chip filters to contacts that have one.

**Math (benchmarked):** a small N-series mini box composes ~2–2.5K/day capture-bound; a mid box
~2–4K/day. So **3K/day = main + 2 workers with headroom; 5K/day = main + 2-3 workers.** At 3K/day
that's ~60–90K sends/month; storage stays ≈1.2 TB flat with retention on.

---

## Where recipients watch (and book)
Each video has a branded landing page — the video with a **calendar booking widget on the right**,
tied to your calendar. Set the booking URL + brand (logo / accent / CTA) in Video Studio's **Brand**
tab (`videoSettings`); it bakes into every share link. The Clients tab "Copy email" produces a
paste-ready email whose clickable GIF opens that landing page.

## The email thumbnail (Loom-style)
Every composite now renders **three** artifacts: the watch **mp4**, the animated **gif** teaser,
and a static **jpg poster** — a real frame of that prospect's video with a play button baked in.
The `{{videoembed}}` merge field (always the **2nd email** of the sequence) embeds the poster at
600px wide, rounded, clickable through to the watch page, with a text "▶ Watch" link underneath
for image-blocking clients. The poster is preferred over the GIF because Outlook/mobile freeze or
strip animated GIFs and the JPEG paints instantly; loading it counts as the email open.

## Retention (how storage stays flat)
`INMARKET_RETENTION=1` arms a 6-hourly sweep on the main that ages out composites older than
`INMARKET_RETENTION_DAYS` (default 30): deletes the mp4/gif/jpg from object storage + local disk,
marks the row "expired" (so the fleet never re-renders it), and clears orphans + stale local shot
caches. The MinIO setup also installs a bucket lifecycle rule as a backstop. Source webcam clips
under `clips/` are never expired. Watch links stop working at `RECRUITEROS_SHARE_TTL_DAYS` — keep
it ≤ the retention window.

---

## Throughput reality
One box does ~2-4K heavy videos/day flat out (each = a Chromium capture + an ffmpeg composite).
**5K/day reliably needs the fleet** — concurrency on one box won't get there alone. Workers are
cheap and each one adds its own throughput; 2-3 clears 5K with headroom.

## Troubleshooting
- **No videos appear** → check `engine_health`: is `autoVideo.enabled` true, is a `clipId` resolved
  (record a clip / set `INMARKET_AUTOVIDEO_CLIP_ID`), is `autoCapture` producing captures first.
- **Workers idle / "no shared storage"** → `ROS_S3_*` not set on the main (`claim_video` returns
  `shared:false`); set it and restart.
- **Worker errors on capture/compose** → ffmpeg or Chromium missing on the box; re-run
  `setup-video-worker.sh` (installs both).
- **CPU pegged** → lower `*_CONCURRENCY`, or add another worker box instead of pushing one harder.

## Rollback / pause
Blank `INMARKET_AUTOCAPTURE` / `INMARKET_AUTOVIDEO` in `.env.production` and `docker compose up -d`;
stop a worker with `systemctl stop recruiteros-video-worker`.
