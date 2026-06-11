# LUME white-label go-live (app.lumesp.com)

Runbook to bring the Lume-branded portal live. The login/portal branding is **code-ready**
(see [[white-label-portals]]): a built-in preset (`lib/branding/presets.ts`) makes any
`*.lumesp.com` host resolve to Lume (logo, name, teal `#0080A0`, favicon) with zero
"RecruitersOS" leakage — verified on the dev server.

`app.lumesp.com` is served by **RecruiterOS** (this app), NOT Cloudflare Pages. The
marketing site `lumesp.com` is the separate Pages project.

## Status
- ✅ Branding + theme + de-leak: in the working tree, **not yet committed/deployed**.
- ⏳ Deploy: commit the white-label files → push `main` (auto-deploy watcher) to ship.
- ⏳ DNS: records below.
- ⏳ Lume workspace + admin account: none exists yet.
- ⏳ Caddy reload on the keeper for on-demand TLS (known infra blocker).

## DNS (app.lumesp.com)
| Type | Host | Value | Proxy | Note |
|---|---|---|---|---|
| CNAME | `app.lumesp.com` | `recruitersos.co` | **DNS only / grey cloud** | matches `WHITE_LABEL_CNAME_TARGET`; A-record alt: `178.156.170.244` |
| TXT | `_recruiteros.app.lumesp.com` | `<token>` | — | from Setup → Custom domain (verification) |

⚠️ Must be **DNS-only** — Caddy terminates TLS at the origin via on-demand certs. A proxied
(orange-cloud) record breaks `caddyask`.

## Steps
1. **Deploy the code** — commit the white-label changes and push `main` (auto-deploy).
2. **Create the Lume workspace** — sign up with an `@lumesp.com` email (corporate auto-join)
   or owner-provision; this is the admin account for `/admin`. Invite recruiters from
   Team → they land in `/recruiter` (invite links use the verified domain, no house ref).
3. **Claim the domain** — Setup → Custom domain → enter `app.lumesp.com` → copy the TXT
   token → publish the CNAME + TXT above → **Verify** (advances `verified` → `live`).
4. **Reload Caddy on the keeper** (one-time) so on-demand TLS serves the new host:
   `docker compose restart caddy` (or `up -d --force-recreate`). `caddyask` only 200s for
   `verified`/`live` domains, so randoms can't mint certs.
5. **Confirm** — `https://app.lumesp.com/admin` and `/recruiter` (logged-out → `/login`)
   show the Lume wordmark + teal theme, tab title "Lume Search Partners", Lume favicon,
   no "RecruitersOS" anywhere.

## Notes
- The preset means the login is Lume **before** the workspace sets any branding; once the
  workspace uploads its own logo/name in Setup → Branding, that overrides the preset.
- `/owner-login` is intentionally left house-branded (platform-operator door, not Lume's).
- Branded transactional emails (reset/verify/magic-link) still need an email provider
  connected — see [[white-label-portals]].
