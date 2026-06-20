# Free X-ray search backend (SearXNG) — make live people-finding actually work

The X-ray people finder (`lib/inmarket/xray.ts`) reads public search results to turn
**company + job title → a real person + email**. Doing that by scraping Google/Bing HTML
directly from ONE IP gets rate-limited almost immediately. There are two free ways to fix it,
and you can use either or both:

| Backend | What it needs | Works from a single IP? | Best for |
|---|---|---|---|
| **SearXNG** (recommended) | one Docker container | **Yes** | dev box + prod |
| **Egress IP rotation** | several IPs on the host (Hetzner /64) | No (needs the IPs) | prod, high volume |

When `INMARKET_SEARXNG_URL` is set, the X-ray uses SearXNG **first** (clean JSON, captures the
LinkedIn profile URL) and falls back to the rotated HTML scrapers. Set neither and live runs throttle.

---

## Option A — SearXNG (works on your Windows box AND on Hetzner)

SearXNG is a meta-search proxy: one query fans out across many engines *server-side* and returns
JSON. Because it spreads load across scrape-tolerant engines, it works from a single IP.

> ⚠ SearXNG **disables the JSON API by default**. You MUST enable the `json` format (below) or
> every request returns HTML and the X-ray gets nothing.

### Local dev (Docker Desktop on Windows)

1. Create a settings file `searxng/settings.yml` next to where you'll run it:

   ```yaml
   use_default_settings: true
   server:
     secret_key: "change-me-to-anything-random"
   search:
     formats:
       - html
       - json        # <-- this line is what makes the X-ray work
   ```

2. Run the container:

   ```powershell
   docker run -d --name searxng -p 8080:8080 `
     -v ${PWD}\searxng:/etc/searxng `
     searxng/searxng:latest
   ```

3. Point the app at it and run the probe:

   ```powershell
   $env:INMARKET_SEARXNG_URL = "http://localhost:8080"
   npx tsx scripts/xray-probe.ts "Stripe" "CTO" stripe.com
   ```

   The probe's BACKEND STATUS line should now read `SearXNG: ON`, and you should get a named
   person + email instead of THROTTLED.

### Production (Hetzner, docker-compose)

Add a service to `docker-compose.yml` (same repo) and wire the env var into the app:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    restart: unless-stopped
    volumes:
      - ./searxng:/etc/searxng        # holds settings.yml with the json format enabled
    # no published port needed — the app reaches it on the internal docker network

  app:
    # ...existing config...
    environment:
      # ...existing vars...
      INMARKET_SEARXNG_URL: "http://searxng:8080"
    depends_on:
      - searxng
```

Commit `searxng/settings.yml` (the same yaml as above), then redeploy:

```bash
cd /opt/recruiteros && git pull && docker compose up -d --build
```

---

## Option B — Egress IP rotation (prod, for volume)

This is already coded (`lib/net/egress.ts`); it just needs IPs actually live on the host. From
your Windows box: `ssh root@178.156.170.244`, then:

1. **Confirm the env is set** (in `/opt/recruiteros/.env.production`):

   ```bash
   grep INMARKET_EGRESS /opt/recruiteros/.env.production
   # INMARKET_EGRESS_IPV6_BASE=2a01:4f8:...::   and   INMARKET_EGRESS_IPV6_COUNT=16
   ```

2. **Confirm the IPs are on the interface** — rotation silently falls back to the single default
   route if they aren't:

   ```bash
   ip -6 addr show dev eth0 | grep inet6
   ```

   If only one global address shows, add the block (Hetzner routes the /64 to the box):

   ```bash
   for i in $(seq 1 16); do ip -6 addr add 2a01:4f8:...::$i/64 dev eth0; done
   ```

   To survive reboot, add these to the netplan/systemd-networkd config.

3. **Verify from inside the app container** that `egressEnabled()` is true:

   ```bash
   docker compose exec app npx tsx scripts/xray-probe.ts "Stripe" "CTO" stripe.com
   ```

   BACKEND STATUS should show `egress IP rotation: ON (N sources …)`.

Raising `INMARKET_EGRESS_IPV6_COUNT` (and adding the matching IPs) raises the throttle ceiling —
still $0.

---

## Recommended setup

- **Now / dev:** Option A locally → develop and test the model against real data for free.
- **Prod:** Option A **and** B together — SearXNG as the reliable primary, egress rotation behind
  it for the HTML fallback and the rest of the free-source scrapers.

Once a backend is live, the X-ray is already wired into the pipeline: `xrayPeopleGraph()` is one of
the free strategies inside `freePeopleGraph` (`lib/inmarket/decisionMaker.ts`), so every hiring
signal automatically runs company + title → person → email → free verify.
