# `docs/` — all project documentation

Everything that explains *how RecruitersOS works and how to run it* lives here. (Code-level docs
that belong next to their code — like `integration/BACKEND.md` — stay with the code.)

**Start with [STRUCTURE.md](STRUCTURE.md)** — the full project map: every top-level folder, what it
does, and where to develop each feature.

## What's in each folder

| Folder | What it's for | Go here when… |
|---|---|---|
| **[platform/](platform/)** | Per-category reference for the **backend** (`integration/lib/` domains). | You're about to build/change a backend feature and want to know which folder + files to touch. |
| **[setup/](setup/)** | How to **stand up and configure** the app: server, each outreach channel, and the DEPLOY-* runbooks (clients / email / video). | You're deploying, or turning on email / SMS / LinkedIn. |
| **[playbooks/](playbooks/)** | Reference **playbooks** (copywriting voice, full website map, BD outreach model). | You need the "how we do it" reference, not a setup step. |
| **[runbooks/](runbooks/)** | **Operational runbooks** for specific campaigns/go-lives + their data files. | You're executing a specific named campaign/run. |
| **[design/](design/)** | **Design & planning** docs for in-flight features. | You're planning or picking up a feature that's still being built. |
| **[integrations/](integrations/)** | External-tool integrations (n8n outreach router). | You're wiring RecruitersOS to an outside automation tool. |
| **[changelog/](changelog/)** | **Dated session logs**: what changed, why, where it lives. | You're catching up on recent work or recording a session. |

> Each subfolder has its own `README.md` explaining it in more detail — open the folder to see it.
