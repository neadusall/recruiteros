# Deploying RecruiterOS (getting a live URL)

The portal (login, Command Center, sessions) is a **server app**. It cannot run
from a double-clicked file, it must be hosted. Everything below hosts the
marketing pages AND the real backend from one origin, so login works and the
plan shows correctly (enterprise for corporate emails, not "Trial").

## Run it locally (works now)

```bash
cd integration
npm install
npm run build      # also syncs ../*.html + ../assets into public/
npm run start      # serves everything at http://localhost:3000
```

Open http://localhost:3000/login.html , create an account with a work email,
and you land in a real Command Center backed by the live API.

## Host it publicly (Vercel, ~2 minutes)

The repo already has `vercel.json` and the prebuild sync wired.

1. Push to GitHub (already at github.com/neadusall/recruiteros).
2. Go to vercel.com/new and import the `recruiteros` repo.
3. Vercel reads `vercel.json` and builds the Next app in `integration/`.
4. You get a live URL like `https://recruiteros.vercel.app`.
5. Add your domain `recruiteros.co` in Vercel → Project → Domains.

### CLI alternative

```bash
npm i -g vercel
cd C:\Users\rrnea\recruiteros
vercel            # first run links the project
vercel --prod     # ships to the public URL
```

## Environment variables (set in Vercel → Project → Settings → Env)

These are optional for the demo, required to send for real:

- `ANTHROPIC_API_KEY` — AI personalization / reply classification
- `RECRUITEROS_OUTREACH_PROVIDER` — `internal` or `unipile`
- `RECRUITEROS_SMS_PROVIDER` — `telnyx` or `internal`
- `LOXO_API_KEY` — go-live ATS sync

## Note on data persistence

The backend ships with an in-memory reference store, great for demos, but it
resets when the server restarts. For production multi-user accounts, swap the
in-memory stores for a database (the repositories are isolated for exactly this:
`integration/lib/*/repository.ts`).
