# Portals & access reference

## One codebase → every portal (the standing rule)

**All portals run from ONE shared codebase.** Owner Console, your Admin Portal, the
Recruiter Portal, the White-label Signup, and every customer instance (e.g. LUME)
are the same app — `command.html` + `assets/` (synced into `integration/public/`)
on the same Next.js backend.

So: **a change to the workflow / UI / a function changes it for ALL of them, by
default, unless it is explicitly gated.** The same function is there everywhere and
everything keeps working. What differs between portals is **DATA, not code**:

- **Per-workspace data** — branding (logo/name/accent/domain), the keys a workspace
  has connected, its plan. (See `integration/lib/branding`, `lib/connected`.)
- **Role** — `owner` / `admin` / `member` decides which nav + capabilities show
  (`lib/auth/permissions.ts`). The Admin and Recruiter portals are the same file,
  scoped by role.
- **Identity gate** — the Owner Console additionally requires the `OWNER_EMAIL`
  allow-list server-side.

If a change should NOT apply everywhere, it must be gated deliberately — by role
(`data-cap` / `can()`), by workspace identity (`isHouseWorkspace()`), or by a
per-workspace setting. Examples already in place: the platform trial banner is
hidden for white-label customer domains; house env API keys are isolated from
customer workspaces. Everything else is shared on purpose.

Editing rule: edit the repo-root `command.html` / `assets/`, then run
`node integration/sync-public.cjs` (it regenerates `integration/public/`). Never
edit `integration/public/` directly.

## Portal map

| Portal | URL | Email(s) / who | Status |
| --- | --- | --- | --- |
| **Owner Console** (spending / revenue / all accounts) | `recruitersos.co/owner-login` → Owner Console (`/owner-console`) | neadusall@gmail.com; ryan@recruiters.co | Live |
| **Your Admin Portal** (house workspace) | `recruitersos.co/admin` | neadusall@gmail.com; ryan@recruiters.co | Live |
| **Recruiter Portal** (house) | `recruitersos.co/recruiter` | per invited recruiter (member role) | Live |
| **White-label Signup** (new customers) | `recruitersos.co/signup` | their own (corporate email) | Live |
| **LUME – Admin** | `app.lumesp.com/admin` | a @lumesp.com admin _(fill in)_ | Pending DNS + Caddy reload |
| **LUME – Signup** | `app.lumesp.com/signup` | their own | Pending DNS + Caddy reload |
| **LUME – Recruiter** | `app.lumesp.com/recruiter` | per LUME recruiter | Pending DNS + Caddy reload |
| OS Text (SMS engine) | `taltxt.recruitersos.co` | logged-in recruiting workspace | Live (embedded in the OS Text tab) |

Notes:
- **Owner Console** is gated by `OWNER_EMAIL` (non-owners get a 404). Sign in at
  `/owner-login`; the console itself is `/owner-console` (also reachable from the
  account menu → Owner console, or `/api/owner/enter`).
- The **house Admin Portal** never sees the 14-day trial paywall; white-label
  customer domains (e.g. lumesp.com) don't see it either.
- **LUME** goes Live once: DNS CNAME `app.lumesp.com → recruitersos.co`, the TXT
  verify in Setup → Custom domain, and a one-time Caddy reload on the server
  (`docker compose up -d --force-recreate`) so on-demand TLS serves the domain.

A machine-readable version of this table lives in
[`docs/access-reference.csv`](access-reference.csv).
