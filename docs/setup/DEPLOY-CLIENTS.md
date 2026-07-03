# Deploy runbook: Clients tab + Reoon email validation

How to push the **Clients tab** (the Hire Signals send-ready book) and switch on **Reoon**
email validation in production. Two independent moves: ship the code, then set the key.

- **Site:** https://recruitersos.co (portal at `/command`)
- **Server:** `root@178.156.170.244` (Hetzner, Ubuntu 24.04)
- **Repo dir on the box:** `/opt/recruitersos` (older installs: `/opt/recruiteros`)
- **Prod deploys `main`.** Feature branches don't go live until merged.

---

## What "live" requires

| Piece | Where it lives | Action |
|-------|----------------|--------|
| Clients tab UI | `assets/js/command.js` + `command.css` (synced to `integration/public`) | **Merge PR #6 → main**, redeploy |
| Reoon validator | `integration/lib/inmarket/reoon.ts` (already on `main`, armed on boot) | Set `REOON_API_KEY` on the box |
| Validated-only enrollment | `INMARKET_REQUIRE_VALIDATED` flag | Set `=1` on the box |

The Clients tab works without Reoon (emails show DNS-level **"deliverable"**); with `REOON_API_KEY`
set, the tick confirms each mailbox and badges flip to **"✓ verified"**.

---

## Step 1 — Merge the feature (run on your machine, in the repo)

`gh` is authed; this merges [PR #6](https://github.com/neadusall/recruiteros/pull/6):

```bash
gh pr merge 6 --squash --delete-branch
```

(Or click **Merge** in the GitHub UI.)

---

## Step 2 — Deploy + switch on Reoon (SSH to the box)

```bash
ssh root@178.156.170.244
```

then on the server:

```bash
cd /opt/recruitersos 2>/dev/null || cd /opt/recruiteros

# Add the Reoon key + validated-only flag (idempotent — safe to re-run).
grep -q '^REOON_API_KEY=' .env.production \
  && sed -i 's#^REOON_API_KEY=.*#REOON_API_KEY=<YOUR_REOON_KEY>#' .env.production \
  || echo 'REOON_API_KEY=<YOUR_REOON_KEY>' >> .env.production
grep -q '^INMARKET_REQUIRE_VALIDATED=' .env.production \
  && sed -i 's#^INMARKET_REQUIRE_VALIDATED=.*#INMARKET_REQUIRE_VALIDATED=1#' .env.production \
  || echo 'INMARKET_REQUIRE_VALIDATED=1' >> .env.production

# Pull the merged code + rebuild.
git fetch origin && git reset --hard origin/main   # the box is a deploy target, not an edit checkout
docker compose up -d --build
```

> Replace `<YOUR_REOON_KEY>` with the live key. It's a secret — it lives only in
> `.env.production` on the box (gitignored), never in the repo.

### Optional Reoon tuning (defaults are fine)
```
REOON_BULK_SIZE=800          # emails per bulk task
REOON_INTERVAL_SEC=180       # how often the tick creates/polls a task
REOON_ACCEPT_CATCHALL=1      # catch-all corporate domains count as valid (set 0 for strict)
REOON_TASK_MAX_AGE_SEC=1800  # abandon a stuck task after this long
```

---

## Step 3 — Verify

1. Open **https://recruitersos.co/command** → **🤝 Clients**.
2. You should see: the **Hire Signals / All leads** segment toggle, the **Send-ready** view,
   the **Video** column, and per-row **verification badges**.
3. Within a few minutes the Reoon tick runs; badges flip **deliverable → ✓ verified** and the
   **🟢 fully ready** count (validated email + a capture) climbs.

Quick server-side checks:
```bash
docker compose ps                                   # app + caddy + db running
docker compose logs --tail=50 app | grep -i reoon   # tick activity / errors
grep -E '^REOON_API_KEY=|^INMARKET_REQUIRE_VALIDATED=' .env.production   # key present
```

---

## Troubleshooting

- **Badges stay "deliverable", never "verified"** → `REOON_API_KEY` not set or not picked up.
  Re-check `.env.production`, then `docker compose up -d` (recreates the app with the new env).
- **Clients tab empty under "Hire Signals"** → no contacts have `category: in_market` yet.
  They arrive as the engine validates decision-makers / auto-enroll runs. Switch to **All leads**
  to see every enriched contact in the meantime.
- **No video / "Generate" does nothing** → ffmpeg + Chromium must be in the image (they are, via
  the Dockerfile). Check `docker compose logs app | grep -i ffmpeg`.
- **`git pull` complains about local changes** → the box is a deploy target; use
  `git fetch origin && git reset --hard origin/main` (as in Step 2) instead of `git pull`.
- **Reoon credits** → check the balance:
  `curl -s "https://emailverifier.reoon.com/api/v1/check-account-balance/?key=<YOUR_REOON_KEY>"`.
  At full 5K/day tilt, top up roughly every couple of weeks.

---

## Rollback

```bash
cd /opt/recruitersos
git reset --hard <previous-good-commit>   # or: git reset --hard origin/main~1
docker compose up -d --build
```

To pause Reoon without redeploying: blank `REOON_API_KEY` in `.env.production`
(or set `INMARKET_REQUIRE_VALIDATED=0` to let unvalidated guesses enroll again), then
`docker compose up -d`.
