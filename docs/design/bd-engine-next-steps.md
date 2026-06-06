# BD Engine — Next Steps (start here tomorrow)

This is your walk-through. Do the steps **in order**. Each one says what to do,
what command to run, and how you know it worked. Stop at any "✅ Done when…" line
and confirm before moving on.

The backend lives in `integration/` (Next.js). All commands below assume you're
in that folder unless noted.

---

## TODAY'S GOAL: get the direct-dial finder working end-to-end

Everything for the voicemail loop is already built **except** the part that finds a
person's direct phone number — that's what we just wired (the Apify "Direct Dials"
actor). Get that one piece live and tested first. The bigger items (Winnr email,
database) come after and are separate tracks.

---

## STEP 1 — Set up your local env file (5 min)

The app reads secrets from a `.env` file that is NOT committed (safe). Create it
from the example:

```powershell
# from the integration/ folder
Copy-Item .env.example .env
```

Then open `integration/.env` and you'll fill in keys as you go. You do **not** need
every key — only the ones for the feature you're testing.

✅ **Done when:** `integration/.env` exists on your machine.

---

## STEP 2 — Turn on the Apify direct-dial finder (15 min)

This is the new piece. It looks up a person's direct line (~$0.03 per number found).

1. **Get your Apify token.** Log in at https://apify.com → Settings → Integrations →
   API token. Copy it.

2. **Confirm the actor name.** In Apify, find the **ryanclinton "Phone Number Finder
   — Direct Dials"** actor (Apify Store). Open it and look at the actor ID — it looks
   like `username~actor-name`. I defaulted it to
   `ryanclinton~phone-number-finder-direct-dials`. If the real one is different, you'll
   correct it in the next step.

3. **Fill these two lines in `integration/.env`:**
   ```
   APIFY_TOKEN=apify_api_xxxxxxxx        # paste your token
   APIFY_DIRECT_DIAL_ACTOR=ryanclinton~phone-number-finder-direct-dials
   ```
   (Only change the second line if the actor ID was different in step 2.)

✅ **Done when:** both lines have real values in `.env`.

> ⚠️ One thing I couldn't verify for you: the actor's exact ID and the field names it
> returns. If the test in Step 4 finds nothing, that's almost certainly why — see
> "If the lookup finds nothing" at the bottom.

---

## STEP 3 — Start the app (2 min)

```powershell
# from integration/
npm run dev
```

Leave it running. It serves at http://localhost:3000.

✅ **Done when:** the terminal shows "ready" and the page loads in your browser.

---

## STEP 4 — Test a real direct-dial lookup (10 min)

Pick a prospect that has a **name + company** but no phone yet, then trigger the
"Enrich phone" action on them (in the Prospects UI, the enrich/phone button).

What should happen behind the scenes:
1. The Apify actor looks up the direct dial.
2. Telnyx confirms whether it's a landline/VoIP or mobile (line-type check).
3. The number lands on the prospect as `landlinePhone`.
4. A `$0.03` cost is logged to the billing ledger.

✅ **Done when:** the prospect shows a phone number after enriching, and it's tagged
as landline/voip (mobiles are expected to be filtered out by design).

> Note: Step 4 also needs `TELNYX_API_KEY` set in `.env` for the line-type confirm
> step. If Telnyx isn't configured yet, the number will still be found and saved — it
> just won't be line-type-verified until you add the Telnyx key.

---

## STEP 5 — Confirm the full voicemail loop still works (your existing setup)

The voice drop itself (Telnyx AMD → play your cloned voice → hang up) was already
built and working. Once Step 4 gives you a verified landline, the only missing link
is the automatic trigger (see "Bigger tracks" below). To test a drop manually today,
use the existing **voice test-drop** flow to your own phone (this is the same thing
you tested before — it hasn't changed).

✅ **Done when:** you can find a number (Step 4) AND drop a voicemail to your own
phone (existing flow). That proves both halves of the loop.

---

# Bigger tracks (decide when you're ready — not needed for Step 1–5)

These are the two larger decisions you made. They're real projects, not quick
toggles. Tackle them one at a time, and tell me when you want to start one — I'll
build it in small slices and stop for you to test each.

### Track A — The automatic "email sent → voicemail" trigger
Right now voicemail is scheduled as part of a sequence. The spec wants it to fire
automatically the moment an email is sent. This is the **one genuine functional gap**
left in the core loop — the voice machinery already works, nothing just *fires* it on
send yet. **This is the smallest of the big items and the highest payoff.** Good one
to do first.

### Track B — Winnr + Mailivery email
Today email runs through Instantly. You chose to build the Winnr (50 mailboxes, your
own tracking pixel, IMAP reply reading) + Mailivery (warmup) stack instead. This is a
large net-new build. You'll need: Winnr API/SMTP creds and a Mailivery API key.

### Track C — Move data into a real database
Today data is stored as JSON snapshots. You chose to migrate to proper SQL tables
(contacts / campaigns / messages / events / voice_drops). This is a rewrite of
working storage — biggest of the three, no new user-facing feature, but it's the
foundation the spec assumes. Best done last, or when something forces it.

**My suggestion for sequencing:** finish Steps 1–5 (direct-dial live) → Track A
(auto trigger) → then decide between B and C based on what's more urgent for the
business.

---

## If the lookup finds nothing (Step 4 troubleshooting)

The Apify actor ID or its return field names may differ from my best guess. To fix:
1. Run the actor once manually in the Apify console with a test name+company and look
   at the JSON it returns.
2. Tell me what the actual actor ID is and what the phone field is called in that
   JSON. It's a one-line change in `integration/lib/signals/apify.ts` (the actor ID is
   just the `.env` value; the field name is in the `pick([...])` list).

That's the only part of this that I couldn't verify against the live service, so it's
the most likely thing to need a small correction.
