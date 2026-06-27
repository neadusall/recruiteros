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
| **Object storage** (`ROS_S3_*`) | A worker's video must be servable by the main; videos don't fit on the 75GB app disk | Hetzner Object Storage (same provider), or Cloudflare R2 / AWS S3 / MinIO |
| **One recorded clip** | Your face/audio, composited over every video (one clip covers all) | Record it in Video Studio `/pip-studio` |
| **Your workspace ID** | So the compositor finds your clip | Owner console / portal (ask Claude to fetch it) |
| **Worker token** | Auth between workers and the main | `INMARKET_WORKER_TOKEN` in the main `.env.production` (set one if absent) |
| **2-3 cheap worker boxes** | Each adds its own CPU → the only way to reach 5K/day | Hetzner CX/CPX (~$5-40/mo each) |

---

## Step 1 — Shared object storage (on the main)

Create a bucket, then add to `/opt/recruitersos/.env.production`:
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
```

## Step 4 — Add worker boxes (the path to 5K/day)
On each cheap box (repo checked out), run:
```bash
WORKER_MAIN_URL=https://recruitersos.co \
WORKER_TOKEN=<same as INMARKET_WORKER_TOKEN on the main> \
ROS_S3_BUCKET=... ROS_S3_ENDPOINT=... ROS_S3_ACCESS_KEY_ID=... ROS_S3_SECRET_ACCESS_KEY=... \
bash setup-video-worker.sh
```
It installs node + ffmpeg + Chromium, then runs the worker as a systemd service. Each box claims
jobs, captures + composites locally, uploads the video to S3, and reports back.

## Step 5 — Tune + verify
- Raise `*_CONCURRENCY` (main and `VIDEO_WORKER_CONCURRENCY` on workers) toward each box's vCPU count; watch `docker stats` / `htop`.
- Progress: the `engine_health` API returns `autoCapture.totalMade` and `autoVideo.totalMade`.
- See the videos: **Clients tab → Asset column → click the 🎬 thumbnail.** The "🎬 with video N"
  legend chip filters to contacts that have one.

**Math:** main + 2-3 workers, each composing ~2K/day → **5K+/day**, hands-off.

---

## Where recipients watch (and book)
Each video has a branded landing page — the video with a **calendar booking widget on the right**,
tied to your calendar. Set the booking URL + brand (logo / accent / CTA) in Video Studio's **Brand**
tab (`videoSettings`); it bakes into every share link. The Clients tab "Copy email" produces a
paste-ready email whose clickable GIF opens that landing page.

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
