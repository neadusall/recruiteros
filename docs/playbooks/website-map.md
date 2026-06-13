# RecruitersOS — Website Map (where to change what)

A single index of everything in this codebase, so you can find the exact file to
edit for any change on the website. **Edit the files in the repo root.** The copies
under `integration/public/` are generated — see ["Source of truth"](#source-of-truth).

---

## 1. Pages (the website)

Every page is a standalone `.html` file in the repo root. Edit the HTML for copy,
structure, and layout; edit the linked CSS/JS (next column) for styling and behavior.

### Marketing / public site

| Page | What it is | CSS it uses | JS it uses |
|---|---|---|---|
| [index.html](index.html) | **Landing page** — full product vision, hero search | styles.css | landing.js |
| [about.html](about.html) | Our story / why we built it | styles.css | landing.js |
| [features.html](features.html) | Every feature grouped by module | styles.css | landing.js |
| [platform.html](platform.html) | Platform overview ("campaign is the atomic unit") | styles.css | landing.js |
| [pricing.html](pricing.html) | Plans, credits, pricing | styles.css | landing.js |
| [recruiting-os.html](recruiting-os.html) | The Recruiter OS product page | styles.css, app.css | landing.js |
| [business-development-os.html](business-development-os.html) | The BD OS product page | styles.css, app.css | landing.js |
| [signals.html](signals.html) | Signal Engine explainer | styles.css | landing.js |
| [sourcing.html](sourcing.html) | Sourcing & enrichment explainer | styles.css, app.css | landing.js |
| [outreach.html](outreach.html) | Outreach & campaigns explainer | styles.css, app.css | landing.js |
| [linkedin.html](linkedin.html) | LinkedIn Engine explainer | styles.css, app.css | landing.js |
| [conversations.html](conversations.html) | "The Money Maker" SMS/voice inbox explainer | styles.css, app.css | landing.js |
| [analytics.html](analytics.html) | Analytics / reporting explainer | styles.css, app.css | landing.js |
| [integrations.html](integrations.html) | ATS/CRM + infra integrations | styles.css | landing.js |
| [developers.html](developers.html) | Developers & API + interactive console | styles.css | developers.js, landing.js |
| [help.html](help.html) | Help center (inline styles + script) | *(inline)* | *(inline)* |

### Auth pages

| Page | What it is | CSS | JS |
|---|---|---|---|
| [login.html](login.html) | Sign in | auth.css, styles.css | auth.js, config.js, local-backend.js, pw-toggle.js |
| [signup.html](signup.html) | Create workspace | auth.css, styles.css | auth.js, config.js, local-backend.js, pw-toggle.js |
| [forgot-password.html](forgot-password.html) | Request reset link | auth.css, styles.css | reset.js, config.js, local-backend.js |
| [reset-password.html](reset-password.html) | Set new password | auth.css, styles.css | reset.js, config.js, local-backend.js, pw-toggle.js |

### The app (logged-in product)

| Page | What it is | CSS | JS |
|---|---|---|---|
| [app.html](app.html) | Tiny loader/redirect into the product ("Opening RecruitersOS…") | styles.css | *(inline)* |
| [command.html](command.html) | **Command Center** — Overview, Campaigns, Prospects, Outreach, Response, Accounts, Connected, ATS | styles.css, app.css, command.css, campaign-studio.css | command.js, campaign-studio.js, session-bridge.js, local-backend.js |
| [campaign-builder.html](campaign-builder.html) | Build a targeted campaign from signals | styles.css | campaign-builder.js, industries.js, landing.js |
| [campaign-studio.html](campaign-studio.html) | Drag-and-drop multi-channel sequence canvas | styles.css, app.css, campaign-studio.css | campaign-studio.js, landing.js |
| [alfred.html](alfred.html) | **Outreach Studio** (MeetAlfred-style engine) | styles.css, app.css, alfred.css | alfred/* (core, ui, backend, studio-bridge), local-backend.js |

### Private / internal

| Page | What it is | Notes |
|---|---|---|
| [owner-console.html](owner-console.html) | **Owner Console** — single-operator back office (overview, pricing, spend, accounts) | Never served at a guessable URL; published only at a secret slug (see sync-public.cjs). Uses owner.js, owner.css, command.css. |
| [project-map.html](project-map.html) | In-browser wireframe/site map (inline) | Visual map; this markdown file is the editing guide. |
| [dev-console.html](dev-console.html) | Dev console / sessions viewer (inline) | ⚠️ Currently **untracked** in git (not committed). |

---

## 2. Styles (`assets/css/`)

| File | Scope |
|---|---|
| [styles.css](assets/css/styles.css) | **Global design system** + landing FX (aurora, particles, shimmer). Loaded by almost every page — edit here for site-wide colors/typography. |
| [app.css](assets/css/app.css) | Shared command-center / product UI |
| [command.css](assets/css/command.css) | Command Center specifics |
| [campaign-studio.css](assets/css/campaign-studio.css) | Drag-and-drop sequence canvas |
| [alfred.css](assets/css/alfred.css) | Outreach Studio |
| [auth.css](assets/css/auth.css) | Login / signup / reset pages |
| [owner.css](assets/css/owner.css) | Owner Console |

## 3. Scripts (`assets/js/`)

| File | Role |
|---|---|
| [landing.js](assets/js/landing.js) | Scroll reveals, animated counters, hero particle field (marketing pages) |
| [command.js](assets/js/command.js) | Command Center logic (whole GTM engine on one screen) |
| [campaign-builder.js](assets/js/campaign-builder.js) | Interactive campaign builder (search → refine → review) |
| [campaign-studio.js](assets/js/campaign-studio.js) | Freeform 2D drag-and-drop sequence builder |
| [industries.js](assets/js/industries.js) | Industry taxonomy (250+) for builder search (`window.ROS_INDUSTRIES`) |
| [developers.js](assets/js/developers.js) | Interactive API/developer console demo (self-contained, no backend) |
| [app.js](assets/js/app.js) | Original command-center demo logic (mock data) |
| [auth.js](assets/js/auth.js) | Real auth client → `/api/auth/*` (no demo mode) |
| [reset.js](assets/js/reset.js) | Password reset client (forgot + reset pages) |
| [pw-toggle.js](assets/js/pw-toggle.js) | Show/hide password eye toggle (any page) |
| [config.js](assets/js/config.js) | Sets backend API base (empty = same origin) |
| [local-backend.js](assets/js/local-backend.js) | Local shim so the portal works with **no server** (intercepts fetches) |
| [session-bridge.js](assets/js/session-bridge.js) | Boots Command Center from session cookie (e.g. after LinkedIn login) |
| [owner.js](assets/js/owner.js) | Owner Console back office |
| **alfred/** | Outreach Studio engine: `alfred-core.js` (sequence engine), `alfred-ui.js` (browser controller), `backend.js` (Next.js client), `studio-bridge.js` (drives browser extension) |

---

## 4. Backend — `integration/` (Next.js app)

The real product backend. Static pages above are served from here in production
(copied into `integration/public/` at build time). Key areas:

- **API routes:** [integration/app/api/](integration/app/api/) — auth, campaigns, prospects, sms, linkedin, response, owner, ats, etc. (one folder per endpoint).
- **Business logic:** [integration/lib/](integration/lib/) — signals, campaigns, outreach channels, linkedin, sms, response routing, billing, owner, auth, providers (Telnyx, Instantly, Unipile, RapidAPI, Tomba…).
- **Public API surface:** [integration/api/](integration/api/) + [integration/openapi.yaml](integration/openapi.yaml).
- **Docs:** [integration/README.md](../../integration/README.md), [integration/BACKEND.md](../../integration/BACKEND.md), [integration/OWNER-CONSOLE.md](../../integration/OWNER-CONSOLE.md), [integration/lib/signals/README.md](../../integration/lib/signals/README.md).
- **Backend per-domain reference:** [docs/platform/](../platform/) — what each `integration/lib/` domain does and where to start.

## 5. Browser extension — `extension/`

Chrome/Edge extension that drives LinkedIn / Sales Navigator on the user's behalf
and talks to the Outreach Studio. Entry points: [extension/manifest.json](extension/manifest.json),
[extension/background.js](extension/background.js), [extension/content/](extension/content/) (linkedin.js, salesnav.js, overlay.css),
[extension/popup/](extension/popup/), [extension/lib/](extension/lib/) (alfred-bridge, limiter, messaging).

## 6. Outreach bridge — `bridge/`

Local Node helper for outreach: [bridge/outreach-bridge.cjs](bridge/outreach-bridge.cjs) (+ README, test, `.env.example`).

---

## 7. Run / build / deploy

| File | Purpose |
|---|---|
| [server.cjs](server.cjs) | Zero-dependency static server (`node server.cjs` → http://localhost:5173) — needed so the Studio can reach the extension (file:// can't). |
| [START-STUDIO.ps1](START-STUDIO.ps1) | Windows launcher for the local server. |
| [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml), [Caddyfile](Caddyfile) | Container + reverse-proxy deploy. |
| [deploy.sh](deploy.sh), [auto-deploy.sh](auto-deploy.sh), [install-auto-deploy.sh](install-auto-deploy.sh) | Deploy + auto-pull/redeploy watcher. |
| [vercel.json](vercel.json) | Vercel config. |
| [integration/sync-public.cjs](integration/sync-public.cjs) | Copies root `*.html` + `assets/` into `integration/public/` at build (and hides the owner console behind a secret slug). |
| [.env.production.example](.env.production.example), [integration/.env.example](integration/.env.example), [bridge/.env.example](bridge/.env.example) | Environment templates. |

**Setup / how-to docs:** [README.md](../../README.md) (root),
[docs/STRUCTURE.md](../STRUCTURE.md) (project map),
[setup/server/2-deploy.md](../setup/server/2-deploy.md),
[setup/server/3-go-live-walkthrough.md](../setup/server/3-go-live-walkthrough.md),
[setup/server/1-hetzner.md](../setup/server/1-hetzner.md),
[setup/server/integration-architecture.md](../setup/server/integration-architecture.md),
[setup/channels/email-resend.md](../setup/channels/email-resend.md) (email),
[setup/channels/linkedin-login.md](../setup/channels/linkedin-login.md),
[playbooks/copywriting-playbook.md](copywriting-playbook.md) (copywriting voice/guidelines).

> Other repo-path links on this page (e.g. `integration/…`, `extension/…`, `server.cjs`) are written
> relative to the **repo root** — open them from the project root, not from this file's folder.

---

## Source of truth

⚠️ **Edit the root files, not `integration/public/`.** Everything under
`integration/public/` (its own `*.html` and `assets/`) is an automatic copy made by
[integration/sync-public.cjs](integration/sync-public.cjs) on build. Changes there
get overwritten. Always change the root `*.html` and `assets/` — the build syncs them.

**Current uncommitted state (snapshot):** `command.html` has uncommitted edits;
`dev-console.html` is untracked (not yet in git).
