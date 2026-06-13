# RecruitersOS — Project Structure & Developer Map

> **Purpose:** a single map of the whole repo so you can find *where to build each thing*
> and understand *why files live where they do*. Read the "Mental model" first, then jump
> to the table for the area you're working in.

---

## Mental model (read this first)

RecruitersOS is **one deployable: a Next.js app in [`integration/`](../integration/)** that serves
both the API *and* the marketing/portal pages from one origin. There are a few satellite pieces
(a browser extension, a Python LinkedIn scraper sidecar, and the OS Text app as a git submodule).

The single most important rule:

> ### 🟢 Frontend source of truth = the root `*.html` files and [`assets/`](../assets/)
> You edit pages at the **repo root** (e.g. [`command.html`](../command.html), `assets/js/...`).
> On every build, [`integration/sync-public.cjs`](../integration/sync-public.cjs) copies all root
> `*.html` + `assets/` into `integration/public/`. **Never edit `integration/public/` directly** —
> it is generated and your changes will be overwritten.

Because that sync script does a *flat* `readdirSync(root)`, **the root HTML files cannot be moved
into subfolders** without rewriting the sync script, the local dev server, and every clean-URL link
between pages. They look like clutter but they are load-bearing. See "Don't move these" below.

---

## Top-level layout

| Path | What it is | Develop here when… |
|---|---|---|
| [`integration/`](../integration/) | **The app.** Next.js: API + portal, the production deployable. | You're changing backend logic, API routes, or app behavior. |
| `*.html` (root) | **Portal + marketing pages** (source of truth). Synced into `integration/public/`. | You're changing any page's HTML/markup. |
| [`assets/`](../assets/) | Shared frontend `css/` + `js/` for the root pages. Synced with the HTML. | You're changing page styles or client-side JS. |
| [`bridge/`](../bridge/) | The in-backend **outreach bridge** (`outreach-bridge.cjs`) + tests. Coordinates work that runs in the Chrome extension. | You're changing how the backend talks to the extension. |
| [`extension/`](../extension/) | **Chrome extension** (`manifest.json`, `background.js`, `content/`, `popup/`). Does the actual LinkedIn/outreach actions in the browser. | You're changing extension behavior. Build artifact lands in `dist/`. |
| [`scraper/`](../scraper/) | **Python LinkedIn scraper sidecar** (`app.py`, `engine.py`, Playwright/Chromium). Its own Docker container; reached at `scraper:8000`. | You're changing the open-source scraper engine. |
| [`linkedin_scraper/`](../linkedin_scraper/) | Vendored open-source `linkedin_scraper` Python library used by the sidecar. | Rarely — it's a third-party lib. Prefer changing `scraper/` around it. |
| [`money-maker-sms/`](../money-maker-sms/) | **OS Text (taltxt)** — separate SMS app, embedded in the portal via iframe. **Git submodule** (own repo). | You're changing OS Text. `cd` in and treat as its own project. |
| [`dist/`](../dist/) | Packaged extension zip(s). Build output. | Never by hand — produced by `extension/package.ps1`. |
| [`docs/`](.) | **All project documentation** (this reorg). See the docs tree below. | You're writing/reading setup guides, playbooks, runbooks, designs. |

---

## Inside `integration/` (the app)

| Path | What it is |
|---|---|
| [`integration/app/`](../integration/app/) | Next.js App Router entry — `layout.tsx`, `page.tsx`, and `app/api/` route handlers. |
| [`integration/api/`](../integration/api/) | API surface / handlers. |
| [`integration/lib/`](../integration/lib/) | **The backend domain layer** — one folder per feature domain (see below). This is where most backend work happens. |
| [`integration/public/`](../integration/public/) | 🚫 **Generated** by `sync-public.cjs`. Do not edit. |
| [`integration/sync-public.cjs`](../integration/sync-public.cjs) | Prebuild step that copies root `*.html` + `assets/` into `public/`. Also hides the owner console behind a secret slug. |
| [`integration/openapi.yaml`](../integration/openapi.yaml) | API spec. |
| [`integration/smoke.cjs`](../integration/smoke.cjs) | Smoke test. |
| `integration/BACKEND.md`, `integration/OWNER-CONSOLE.md` | App-specific docs (kept next to the code they describe). |

### `integration/lib/` domains (where to build each feature)

Each folder is a self-contained domain. Pick the one that matches the feature:

| Want to change… | Go to |
|---|---|
| Accounts / sign-up / login | `lib/accounts/`, `lib/auth/` |
| ATS integrations | `lib/ats/` |
| Billing & rates | `lib/billing/` |
| Campaigns & sequences | `lib/campaigns/`, `lib/sequences/` |
| Outreach channels (email/SMS/voice) | `lib/channels/`, `lib/outreach/`, `lib/sms/`, `lib/voice/` |
| Prospects / candidate lists | `lib/prospects/`, `lib/prospect-lists/`, `lib/importmotion/` |
| Hire signals / sourcing | `lib/signals/`, `lib/sourcing/`, `lib/inmarket/` |
| LinkedIn | `lib/linkedin/` |
| Provider adapters (3rd-party APIs) | `lib/providers/`, `lib/connected/` |
| Data warehouse / imports | `lib/data/`, `lib/db/` |
| Owner console | `lib/owner/` |
| AI content generation | `lib/content/` |
| Core utilities / shared | `lib/core/`, `lib/api.ts` |
| Dev tooling | `lib/dev/`, `lib/exttoken/` |

> If you add a new feature domain, create a new `lib/<domain>/` folder so it stays consistent.

---

## `docs/` (this reorganization)

```
docs/
├── STRUCTURE.md              ← you are here (the project map)
├── INFRASTRUCTURE.md         Full tech-stack inventory + cost model + go-live key checklist + open decisions
├── RECRUITEROS-BACKEND.md    Sending + voice-drop backend wiring (companion to CLAUDE.md). Email = self-hosted MTA (Instantly interim)
├── platform/                 Per-category backend reference (integration/lib domains)
│   ├── README.md             "find your feature" index → which domain + reference
│   ├── outreach-and-messaging.md   channels · outreach · sms · voice · sequences · campaigns · content · response
│   ├── people-and-data.md          prospects · prospect-lists · importmotion · inmarket · signals · sourcing · linkedin · data · db
│   └── platform-and-infra.md       accounts · auth · owner · billing · providers · connected · ats · core · overview · dev · exttoken
├── setup/
│   ├── server/               Stand up + deploy the app
│   │   ├── 1-hetzner.md
│   │   ├── 2-deploy.md
│   │   ├── 3-go-live-walkthrough.md
│   │   └── integration-architecture.md
│   └── channels/             Turn on outreach channels
│       ├── cold-email.md
│       ├── email-resend.md
│       ├── sms-qualification.md
│       └── linkedin-login.md
├── playbooks/                How-to / reference playbooks
│   ├── copywriting-playbook.md
│   └── website-map.md
├── runbooks/                 Operational runbooks + their data
│   ├── jaggaer-vp-sales-east.md
│   └── jaggaer-vp-sales-east-sourcing.csv   (used by the runbook above)
└── design/                   Design / planning docs for in-flight work
    ├── jd-to-1000-prospects.md
    ├── bd-engine-next-steps.md
    └── self-hosted-email-infrastructure.md   Build plan for the owned email sender (Postal MTA), replacing Instantly
```

> **Developing a backend feature? Start at [`docs/platform/README.md`](platform/README.md)** —
> it maps every feature to its `integration/lib/<domain>/` folder and a detailed reference.

> Component-specific docs intentionally live **next to their code**, not here:
> `integration/BACKEND.md`, `bridge/README.md`, `scraper/README.md`,
> `extension/README.md`, `money-maker-sms/` (submodule has its own docs).
> Only **cross-cutting / operational** docs live in `docs/`.

---

## Build & deploy flow (so you know what your change touches)

1. **Local dev:** `node server.cjs` (or `START-STUDIO.ps1`) serves the root `*.html` over
   `http://localhost:5173` with clean URLs (`/alfred` → `alfred.html`). Localhost is required so
   the portal can reach the browser extension.
2. **Production build:** Docker builds `integration/`. The prebuild runs `sync-public.cjs`
   (root HTML + assets → `public/`), then `next build`.
3. **Serving:** Caddy ([`Caddyfile`](../Caddyfile)) terminates HTTPS and proxies
   `recruitersos.co` → the app, `taltxt.recruitersos.co` → OS Text. See
   [`docker-compose.yml`](../docker-compose.yml).
4. **Auto-deploy:** A systemd timer on the server runs `auto-deploy.sh` every couple of minutes;
   **any push to `main` goes live automatically.** First-time server setup is `deploy.sh`
   (curl'd by URL — see [`docs/setup/server/2-deploy.md`](setup/server/2-deploy.md)).

---

## 🚫 Don't move these (load-bearing root files)

Their location is pinned by build/deploy/serve machinery. Moving them breaks the live site:

| File / folder | Pinned by |
|---|---|
| All root `*.html` | `sync-public.cjs` flat-globs the repo root; `server.cjs` serves from root. |
| `assets/` | `sync-public.cjs` copies `root/assets` → `public/assets`. |
| `integration/`, `money-maker-sms/`, `scraper/` | `vercel.json`, `Dockerfile`, `docker-compose.yml`, `.gitmodules`. |
| `deploy.sh` | Curl'd by URL: `raw.githubusercontent.com/.../main/deploy.sh`. |
| `auto-deploy.sh`, `enable-db.sh`, `install-auto-deploy.sh`, `taltxt-db-setup.sh`, `set-adzuna.sh` | Hard-coded `$DIR/<name>` paths in `deploy.sh` + a **systemd unit** on the live server. |
| `Caddyfile`, `Dockerfile`, `docker-compose.yml`, `vercel.json`, `.env*` | Compose mounts / build config / URL pins. |
| `server.cjs`, `START-STUDIO.ps1` | Local dev entry points. |

> **If you ever do want the root HTML foldered:** it's a real project — you'd make
> `sync-public.cjs` recurse, update `server.cjs`'s resolver, and fix every inter-page clean-URL
> link across all pages. Scope it separately; don't do it piecemeal.
