# RecruitersOS

**The operating system for modern recruiting + business development.** Live at
**[recruitersos.co](https://recruitersos.co)**: one platform where signals, sourcing,
enrichment, outreach (email / SMS / LinkedIn / video), and reporting run together.

**One deployable:** a Next.js app in [`integration/`](integration/) serves the API,
the recruiter/admin portal, and the marketing pages from a single origin. Everything
else in the repo is a satellite (browser extension, sidecar services, the OS Text
submodule) or the frontend source it builds from.

---

## The one rule that matters

> **Frontend source of truth = the root `*.html` files + [`assets/`](assets/).**
> On every build, `integration/sync-public.cjs` copies them into `integration/public/`.
> Never edit `integration/public/` (generated), and never move the root HTML into
> subfolders (the sync, the dev server, and every clean URL depend on them being at root).

The full map of what lives where, and why, is **[docs/STRUCTURE.md](docs/STRUCTURE.md)**.
Read it before moving anything: a "Don't move these" table lists every root file pinned
by build, deploy, or server machinery.

## Repo map

| Path | What it is |
|---|---|
| [`integration/`](integration/) | **The app.** Next.js API + portal, the production deployable. Backend work happens in `integration/lib/<domain>/`. |
| `*.html` + [`assets/`](assets/) | Portal + marketing pages (source of truth, synced into the app at build). |
| [`bridge/`](bridge/) | Outreach bridge between the backend and the Chrome extension. |
| [`extension/`](extension/) | Chrome extension that performs LinkedIn/outreach actions in the browser. Packaged zips land in `dist/`. |
| [`laxis-worker/`](laxis-worker/) | Headless-Chromium sidecar that enriches JD-Sourcing CSVs through Laxis (no public API there). |
| [`lume-jobs/`](lume-jobs/) | Backend for the lumesp.com job board + its team portal. |
| [`lumesp-web/`](lumesp-web/) | Static white-label marketing site for lumesp.com, served directly by Caddy. |
| [`searxng/`](searxng/) | SearXNG meta-search config: the free search backend for the X-ray people finder. |
| [`money-maker-sms/`](money-maker-sms/) | OS Text (taltxt), the SMS app. **Git submodule** with its own repo. |
| [`docs/`](docs/) | All cross-cutting documentation: structure map, setup guides, playbooks, runbooks, designs, changelog. |

Root shell scripts (`deploy.sh`, `auto-deploy.sh`, `set-*.sh`, `setup-*.sh`) are server
operations tooling. They stay at the repo root because the live server and worker boxes
call them at hard-coded paths like `/opt/recruiteros/<name>`.

## Run it locally

Two local loops, depending on what you are changing:

```powershell
# Portal/marketing pages only (static, serves root *.html with clean URLs):
node server.cjs                    # http://localhost:5173  (or START-STUDIO.ps1)

# The full app (API + portal), with live re-sync of root HTML + assets:
cd integration
npm run dev:fast                   # http://localhost:3000
```

For the packaged Clients portal experience, double-click `START-PORTAL.cmd` (see
[RUN.md](RUN.md)).

## Deploy

**Every push to `main` deploys to production automatically.** A systemd timer on the
Hetzner server runs `auto-deploy.sh` every couple of minutes: it pulls, rebuilds, and
restarts the Docker Compose stack (app + taltxt + lume-jobs + laxis-worker + searxng +
Caddy + autoheal). So: confirm changes locally first, and keep one session editing the
repo at a time.

Manual redeploy from the server: `cd /opt/recruiteros && git pull && docker compose up -d --build app`.
First-time server setup and the full go-live walkthrough live in
[docs/setup/server/](docs/setup/server/).

## Branches

- **`main`** is production (auto-deploys on push).
- Long-lived: `white-label-edge` (white-label build). Short-lived feature branches merge
  into `main` and get deleted.
- Superseded or backup work is preserved as **`archive/*` tags** instead of leftover
  branches: `git tag -l 'archive/*'` to list, `git checkout <tag>` to inspect.

## Where to go next

- **[docs/STRUCTURE.md](docs/STRUCTURE.md)**: the project map (start here).
- **[docs/platform/README.md](docs/platform/README.md)**: which `integration/lib/` domain
  owns each feature.
- **[docs/setup/](docs/setup/)**: stand up the server, turn on channels, deploy guides.
- **[docs/changelog/](docs/changelog/)**: dated session logs of what changed and why.
