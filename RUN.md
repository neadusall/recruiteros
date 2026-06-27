# Run the RecruitersOS Portal locally

## Easiest: double-click
Double-click **`START-PORTAL.cmd`** in this folder.

- The first run installs dependencies (a few minutes, one time only).
- It then starts the Portal and opens your browser to the Clients page automatically.
- Keep the black window open while you use it. Press **Ctrl+C** in that window to stop.

Open URL: **http://localhost:3040/command** → switch to **Business Development** → **Clients**.

## From a terminal
```
cd integration
npm run portal
```
Then open http://localhost:3040/command.

## Notes
- Email verification (Reoon) is already configured in `integration/.env.local` — no setup needed.
- Data you enrich is saved automatically and persists between restarts.
- This runs the local build. The live site is https://recruitersos.co (deployed separately).
