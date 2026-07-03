# RecruitersOS, Project Structure & Developer Map

> **Purpose:** a single map of the whole repo so you can find *where to build each thing*
> and understand *why files live where they do*. Read the "Mental model" first, then jump
> to the table for the area you're working in.

---

## Mental model (read this first)

RecruitersOS is **one deployable: a Next.js app in [`integration/`](../integration/)** that serves
both the API *and* the marketing/portal pages from one origin. There are a few satellite pieces
(a browser extension, the Laxis enrichment worker, the lumesp.com job board + static site,
a SearXNG search backend, and the OS Text app as a git submodule).

The single most important rule:

> ### 🟢 Frontend source of truth = the root `*.html` files and [`assets/`](../assets/)
> You edit pages at the **repo root** (e.g. [`command.html`](../command.html), `assets/js/...`).
> On every build, [`integration/sync-public.cjs`](../integration/sync-public.cjs) copies all root
> `*.html` + `assets/` into `integration/public/`. **Never edit `integration/public/` directly** -
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
| [`assets/`](../assets/) | Shared frontend `css/` + `js/` for the root pages. Synced with the HTML. The two big SPAs, [`assets/js/command.js`](../assets/js/command.js) (admin/recruiter portal) and [`assets/js/owner.js`](../assets/js/owner.js) (owner console), open with a **navigation map** comment listing every `#hash` route → `render…`/`view…` function, so search by name to jump. | You're changing page styles or client-side JS. |
| [`bridge/`](../bridge/) | The in-backend **outreach bridge** (`outreach-bridge.cjs`) + tests. Coordinates work that runs in the Chrome extension. | You're changing how the backend talks to the extension. |
| [`extension/`](../extension/) | **Chrome extension** (`manifest.json`, `background.js`, `content/`, `popup/`). Does the actual LinkedIn/outreach actions in the browser. | You're changing extension behavior. Build artifact lands in `dist/`. |
| [`laxis-worker/`](../laxis-worker/) | **Laxis enrichment sidecar**: headless Chromium that runs JD-Sourcing CSVs through app.laxis.tech (no public API). Own container; the app reaches it at `laxis-worker:3000`. | You're changing Laxis enrichment behavior. |
| [`lume-jobs/`](../lume-jobs/) | **lumesp.com job-board backend** (postings + applications + team portal). Own container; Caddy proxies `/api/*` on lumesp.com to it. | You're changing the Lume job board. |
| [`lumesp-web/`](../lumesp-web/) | **Static white-label marketing site** for lumesp.com. Served directly by Caddy (volume mount, no build). | You're changing lumesp.com pages. |
| [`searxng/`](../searxng/) | **SearXNG config** (`settings.yml`) for the free X-ray people-finder search backend. Mounted into the searxng container. | You're tuning the free search backend. JSON format MUST stay enabled. |
| [`money-maker-sms/`](../money-maker-sms/) | **OS Text (taltxt)**, separate SMS app, embedded in the portal via iframe. **Git submodule** (own repo). | You're changing OS Text. `cd` in and treat as its own project. |
| [`dist/`](../dist/) | Packaged extension zip(s). Build output. | Never by hand, produced by `extension/package.ps1`. |
| [`docs/`](.) | **All project documentation** (this reorg). See the docs tree below. | You're writing/reading setup guides, playbooks, runbooks, designs. |

---

## Inside `integration/` (the app)

| Path | What it is |
|---|---|
| [`integration/app/`](../integration/app/) | Next.js App Router entry, `layout.tsx`, `page.tsx`, and `app/api/` route handlers. |
| [`integration/api/`](../integration/api/) | API surface / handlers. |
| [`integration/lib/`](../integration/lib/) | **The backend domain layer**, one folder per feature domain (see below). This is where most backend work happens. |
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
├── README.md                 Folder-by-folder guide to docs/
├── STRUCTURE.md              ← you are here (the project map)
├── DESIGN-SYSTEM.md          Meridian: the one visual language for portal + marketing + auth (tokens, components)
├── INFRASTRUCTURE.md         Full tech-stack inventory + cost model + go-live key checklist + open decisions
├── RECRUITEROS-BACKEND.md    Sending + voice-drop backend wiring (companion to CLAUDE.md)
├── DISTRIBUTED-WORKERS.md    Worker-box fleet: setup-worker.sh boxes that scrape with their own IPs
├── PORTALS.md                The portals (admin / recruiter / owner / clients) and how they relate
├── access-reference.csv      Access/credentials reference sheet
├── platform/                 Per-category backend reference (integration/lib domains)
│   ├── README.md             "find your feature" index → which domain + reference
│   ├── outreach-and-messaging.md   channels · outreach · sms · voice · sequences · campaigns · content
│   ├── people-and-data.md          prospects · importmotion · inmarket · signals · sourcing · linkedin · data
│   ├── platform-and-infra.md       accounts · auth · owner · billing · providers · connected · ats · core
│   └── (feature deep-dives: ats-loxo-integration, hire-signals-5k-setup, internal-automation, lumesp-golive)
├── setup/
│   ├── DEPLOY-CLIENTS.md     Clients portal deploy runbook
│   ├── DEPLOY-EMAIL.md       Mail platform deploy runbook (referenced by name in portal UI copy)
│   ├── DEPLOY-VIDEO.md       Video worker deploy runbook (pairs with setup-video-worker.sh)
│   ├── ai-vetting.md
│   ├── server/               Stand up + deploy the app (1-hetzner → 2-deploy → 3-go-live)
│   └── channels/             Turn on outreach channels (cold-email, email-resend, sms, linkedin)
├── changelog/                Dated session logs, what changed, why, and where it lives
├── playbooks/                How-to / reference playbooks (copywriting, website map, bd-outreach model)
├── runbooks/                 Operational runbooks + their data (campaign runs, go-lives, onboarding)
├── integrations/             External-tool integrations (n8n outreach router)
└── design/                   Design / planning docs for in-flight work
```

> **Developing a backend feature? Start at [`docs/platform/README.md`](platform/README.md)** -
> it maps every feature to its `integration/lib/<domain>/` folder and a detailed reference.

> Component-specific docs intentionally live **next to their code**, not here:
> `integration/BACKEND.md`, `bridge/README.md`,
> `extension/README.md`, `money-maker-sms/` (submodule has its own docs).
> Only **cross-cutting / operational** docs live in `docs/`.

---

## Build & deploy flow (so you know what your change touches)

1. **Local dev:** `node server.cjs` (or `START-STUDIO.ps1`) serves the root `*.html` over
   `http://localhost:5173` with clean URLs (`/alfred` → `alfred.html`). Localhost is required so
   the portal can reach the browser extension.
   - **Fast loop for the app (API + portal):** from `integration/`, run `npm run dev:fast`
     (`integration/dev.cjs`). It runs `next dev` on `:3000` **and** re-syncs `assets/` + root
     `*.html` into `public/` on every change, so edits show on refresh with no push, no deploy,
     no server restart. **Push to `main` only after the change is confirmed locally** (every push
     auto-deploys to production, which restarts the server). Keep one agent/session editing the
     repo at a time, concurrent edits cause boot crashes and edit conflicts.
2. **Production build:** Docker builds `integration/`. The prebuild runs `sync-public.cjs`
   (root HTML + assets → `public/`), then `next build`.
3. **Serving:** Caddy ([`Caddyfile`](../Caddyfile)) terminates HTTPS and proxies
   `recruitersos.co` → the app, `taltxt.recruitersos.co` → OS Text. See
   [`docker-compose.yml`](../docker-compose.yml).
4. **Auto-deploy:** A systemd timer on the server runs `auto-deploy.sh` every couple of minutes;
   **any push to `main` goes live automatically.** First-time server setup is `deploy.sh`
   (curl'd by URL, see [`docs/setup/server/2-deploy.md`](setup/server/2-deploy.md)).

---

## 🚫 Don't move these (load-bearing root files)

Their location is pinned by build/deploy/serve machinery. Moving them breaks the live site:

| File / folder | Pinned by |
|---|---|
| All root `*.html` | `sync-public.cjs` flat-globs the repo root; `server.cjs` serves from root. |
| `assets/` | `sync-public.cjs` copies `root/assets` → `public/assets`. |
| `integration/`, `money-maker-sms/`, `scraper/` | `vercel.json`, `Dockerfile`, `docker-compose.yml`, `.gitmodules`. |
| `deploy.sh` | Curl'd by URL: `raw.githubusercontent.com/.../main/deploy.sh`. |
| `auto-deploy.sh`, `enable-db.sh`, `install-auto-deploy.sh`, `taltxt-db-setup.sh` | Hard-coded `$DIR/<name>` paths in `deploy.sh` + a **systemd unit** on the live server. |
| All `set-*.sh` (adzuna, directdial, findwork, jobdata, rapidjobs, live-lean) | Operator runbooks + docs invoke them as `bash /opt/recruiteros/set-*.sh` on the server. |
| `setup-egress.sh`, `setup-worker.sh`, `setup-video-worker.sh`, `setup-minio.sh`, `deploy-video-backbone.sh` | `auto-deploy.sh` and worker boxes call them at `$DIR/<name>`; fleet docs say `bash setup-worker.sh` from a fresh clone root. |
| `taltxt.env.example` | Referenced by `deploy.sh` comments as the taltxt env template. |
| `Caddyfile`, `Dockerfile`, `docker-compose.yml`, `vercel.json`, `.env*` | Compose mounts / build config / URL pins. |
| `lumesp-web/`, `searxng/` | Caddy + searxng containers volume-mount these paths directly (`docker-compose.yml`). |
| `server.cjs`, `START-STUDIO.ps1`, `START-PORTAL.cmd`, `RUN.md` | Local dev entry points (RUN.md documents START-PORTAL.cmd next to it). |

> Loose root docs are the one thing that DOES get moved: deployment/how-to markdown belongs in
> `docs/` (the DEPLOY-* runbooks now live in `docs/setup/`). Before moving any root file, grep
> for its name first; if a script or systemd unit references it, it is pinned.

---

## Branch conventions

- **`main` = production.** Every push auto-deploys (see flow above). Confirm locally first.
- Feature branches are short-lived: merge into `main`, then delete (local + origin).
- **Superseded or backup work becomes an `archive/*` tag** (annotated, pushed), never a
  parked branch: `git tag -l 'archive/*'` lists them. Long-lived branches should be only
  `main` and `white-label-edge` plus whatever is actively in flight.

> **If you ever do want the root HTML foldered:** it's a real project, you'd make
> `sync-public.cjs` recurse, update `server.cjs`'s resolver, and fix every inter-page clean-URL
> link across all pages. Scope it separately; don't do it piecemeal.
