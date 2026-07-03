# 2026-07-03: Repo organization pass 2 (branches, root docs, stale maps)

Second housekeeping pass (the first was 2026-06-18). Goal: cut branch sprawl, get loose
docs out of the repo root, and bring the structure docs back in line with reality.

## Branch cleanup

New convention (now in STRUCTURE.md): superseded/backup work is preserved as an
**annotated `archive/*` tag** pushed to origin, never a parked branch.

Tags created (each preserves the exact tip commit of the branch it replaces):

| Tag | Was branch | Why archived |
|---|---|---|
| `archive/pip-local-20260623` | `backup-pip-local-20260623` | PiP Studio backup; PiP has since shipped to prod. |
| `archive/feat-video-studio-polish` | `feat/video-studio-polish` | Superseded by later shipped video work. |
| `archive/save-wip-command-previews` | `save/wip-command-previews` | Explicit WIP save from 2026-06-27. |
| `archive/feat-senders` | `feat/senders` | Senders polish; Send Queue + Sending.ac go-live shipped to main 2026-07-03. |
| `archive/hire-signals-clean-ui` | `hire-signals-clean-ui` | Fully merged into main (shipped 2026-07-03). |

Local branches deleted (all were merged or exact duplicates of remote refs):
`deploy/roleurl`\*, `feat/email-prep-tool`, `hire-signals-clean-ui`, `ship/hire-signals-ui`
(same commit as `origin/hire-signals-aggressive-rewrite-REJECTED-backup`),
`wip/hire-signals-snapshot-20260703` (same commit as `origin/inmarket-role-split`),
`backup-pip-local-20260623` (tagged). Local `white-label-edge` fast-forwarded to origin.

\* `deploy/roleurl` was KEPT: its worktree (`recruiteros-wt-roleurl`) holds uncommitted
per-role job-URL work in `integration/lib/inmarket/{accumulator,curation}.ts`.

Remote branches queued for deletion once approved (each already merged or tag-archived):
`hire-signals-clean-ui`, `feat/video-studio-polish`, `save/wip-command-previews`, `feat/senders`.
Command: `git push origin --delete hire-signals-clean-ui feat/video-studio-polish save/wip-command-previews feat/senders`

Deliberately kept: `origin/hire-signals-aggressive-rewrite-REJECTED-backup` (documented
rejection backup), `white-label-edge`, `inmarket-role-split`, `live-enrichment-feed`,
`ship/hire-signals-ui-clean` (active MPC engine branch).

## Root declutter

Moved out of the repo root (nothing references them by path; the portal UI mentions
"DEPLOY-EMAIL.md" by name only, findable by filename search):

- `DEPLOY-CLIENTS.md`, `DEPLOY-EMAIL.md`, `DEPLOY-VIDEO.md` → `docs/setup/`
- `RecruiterOS_Outreach_Engine_TODO.xlsx` → `docs/design/`

Root HTML, `assets/`, and all shell scripts stay put: they are pinned by the build sync,
the live server's systemd units, and worker-box bootstrap paths (see the expanded
"Don't move these" table in STRUCTURE.md, which now covers every `set-*.sh` / `setup-*.sh`).

## Docs refreshed

- **README.md**: rewritten. It still described the project as a static front-end prototype
  "with no backend yet"; it now reflects the deployed Next.js platform, the root-HTML
  source-of-truth rule, both local dev loops, the auto-deploy flow, and branch conventions.
- **docs/STRUCTURE.md**: removed the deleted `scraper/` + `linkedin_scraper/` rows; added
  `laxis-worker/`, `lume-jobs/`, `lumesp-web/`, `searxng/`; refreshed the docs tree;
  expanded the pinned-files table; added the branch-conventions section.
- **docs/README.md**: added the missing `integrations/` and `changelog/` rows.
