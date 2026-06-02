# RecruiterOS — recruitersos.co

**The operating system for modern recruiting.** A cross between Clay.com (a programmable
data-enrichment spreadsheet) and Juicebox.ai (natural-language people search), reframed as
a campaign-centric command center where every revenue activity lives in one place.

> Built as a self-contained static site, **no build step, no Node required.** Just open it.

---

## Run it

Double-click **`index.html`**, or serve the folder:

```powershell
# Option A, just open the file
start index.html

# Option B, serve locally (if you have Python)
python -m http.server 8000
# then visit http://localhost:8000
```

The hero search on the landing page passes your query straight into the live app.

## What's inside

```
recruiteros/
├─ index.html          Landing page, the full product vision
├─ app.html            The command center (the actual product)
├─ assets/
│  ├─ css/styles.css   Design system + next-level FX (aurora, particles, shimmer)
│  ├─ css/app.css      Command-center UI
│  ├─ js/landing.js    Scroll reveals, animated counters, hero particle field
│  └─ js/app.js        Campaigns, AI search, enrichment, signals, SMS, reporting
└─ README.md
```

## The vision (what the product *is*)

The campaign is the atomic unit of work. Inside every campaign:

| Pillar | What it does |
|---|---|
| **📡 Signals** | Funding, new VPs, layoffs, hiring surges trigger every campaign, informed outreach, not cold spray |
| **🎯 Targets & Enrich** | Natural-language people search → a Clay-style grid where every cell can call an AI agent |
| **✉️ Outreach** | AI-drafted, multi-step sequences across email · LinkedIn · SMS |
| **💬 Conversations** | "The Money Maker", an AI SMS layer that replies, detects interest, and routes hot leads to humans |
| **📊 Reporting** | Live operational view: which signals book meetings, which campaigns create job orders |

Two revenue engines (Recruiting + Business Development) run on one shared infrastructure.

## Try this in the app

1. Open **`app.html`**
2. **Signals** tab → click *"Build campaign from signal"*
3. **Targets** tab → run a search → click **Enrich** on cells, or **＋ AI column**
4. Select rows → **Add to sequence** → see the AI-drafted **Outreach**
5. **Conversations** → send a message and watch the AI reply
6. **Reporting** → live operational dashboard

## Outreach Studio — the automation engine (`alfred.html`)

A MeetAlfred-style, multi-channel outreach **automation engine**, built into RecruiterOS.
Where the rest of the app is mock data, this is a **real engine** with persistence, a
scheduler, safety limits, and a simulation clock.

Open **`alfred.html`** and:

1. **Sequence** — build a multi-step drip (connect → wait → message → email…) across
   LinkedIn / Email / X. Edit any step with a live, personalized preview.
2. **Leads** — add/import prospects, select, **Enroll**.
3. Use the **sim clock** (sidebar: `+1 day`, `+1 week`, `+30 days`) to watch the campaign
   drip forward — connections get accepted, messages send only *after* acceptance, replies
   land in the **Inbox** and auto-pause that prospect's sequence.
4. **Analytics** — live funnel, accept/reply rates, activity by channel.
5. **Settings** — per-account daily caps, warm-up ramp, working hours, weekend pause,
   random delays, blacklist.

### Why it's faithful to MeetAlfred
- **Action surface:** LinkedIn view / follow / endorse / connect / message / InMail / like,
  Email send, X follow / like / retweet / DM, plus delays — any order, unlimited steps.
- **The core rule:** a connection-request step gates its follow-ups — messages only fire
  **after the invite is accepted** (enforced + unit-tested).
- **Safe-by-default limits:** ~20 connects/day, 30→50 messages, <100 views, pending-invite
  cap, warm-up ramping 30%→100% over 14 days, working-hours/weekend/timezone gating.

### Architecture (no build step, lifts to a backend later)
```
assets/js/alfred/
├─ alfred-core.js     UMD engine — data model, store, limits, channel adapters,
│                     personalization, sequence scheduler, analytics.
│                     Runs in the browser (window.Alfred) AND under Node (require).
├─ alfred-ui.js       Browser controller for the Studio.
└─ alfred.test.cjs    Node test harness — 30 assertions, run it below.
assets/css/alfred.css Studio styles (on the RecruiterOS design tokens).
alfred.html           The Outreach Studio page.
```

- **Storage**, **channel adapters**, and the **clock** are pluggable seams. Today it runs
  on `localStorage` + a **Simulated** adapter (zero account risk). Swap in a DB + real
  LinkedIn/Email/X adapters server-side to make it a live SaaS — *the engine code doesn't change.*

Run the engine tests (Node is the only requirement, just for tests):
```powershell
node assets/js/alfred/alfred.test.cjs   # → 30 passed, 0 failed
```

## Deploy

It's static, drop the folder on any host:

- **Vercel:** `vercel` (or drag-and-drop the folder at vercel.com/new)
- **Netlify:** drag the folder onto app.netlify.com/drop
- **GitHub Pages:** push the folder and enable Pages

Point **recruitersos.co** at whichever host you choose.

## Note

This is a front-end product prototype with realistic mock data, there's no backend yet.
The search, enrichment, signals, and SMS are simulated to demo the experience. Wiring it to
real data providers (LinkedIn, Apollo, enrichment APIs) and an LLM is the next step.
