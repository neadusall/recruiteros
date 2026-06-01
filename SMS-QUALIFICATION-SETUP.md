# SMS qualification setup, step by step (texting that qualifies leads for you)

Goal: turn on two-way texting so RecruiterOS can send a text, then on every
reply automatically **qualify** the person, opt-outs get suppressed, hot leads
get escalated to you, and everyone in between gets an on-brand AI reply that
nudges toward a booked call. Texting is the channel people actually answer, so
this is the money maker.

This doc is everything associated with the SMS qualification setup that has been
built into the code. You do not need to write any code; it is all here. You only
need to (1) get a Telnyx key, (2) put it on the server, (3) point Telnyx at one
webhook URL, and (4) send a test text.

---

## What has already been built (the moving parts)

You are wiring these together; they already exist in the repo:

| Piece | File | What it does |
|---|---|---|
| Provider abstraction | `integration/lib/sms/provider.ts` | Sends a text. Ships with **Telnyx** (default) and an **internal** gateway. Picked by `RECRUITEROS_SMS_PROVIDER`. |
| The qualifier | `integration/lib/sms/conversation.ts` | On each inbound text: classify intent, then **stop / escalate / auto-reply**. |
| Intent classifier | `integration/lib/linkedin/classify.ts` | Sorts a reply into positive / soft_yes / timing / fit / referral / not_interested / **stop**. Has a fast-path that catches opt-outs without an AI call. |
| Inbound webhook | `integration/app/api/sms/webhook/route.ts` | `POST /api/sms/webhook`. Telnyx calls this on every received text. |
| Outbound send API | `integration/app/api/sms/send/route.ts` | `POST /api/sms/send`. RecruiterOS (or you) fire a text from here. |
| Mobile vs landline gate | `TELNYX_NUMBER_LOOKUP` env (see `.env.example`) | Cheap line-type check so you only text mobiles. |

### How qualification actually decides (the logic, in plain English)

Every inbound text runs through `handleInbound` in `conversation.ts`:

1. **Opt-out** (`stop`, `unsubscribe`, `remove me`, `do not contact`, `opt out`)
   -> no reply is drafted. You should suppress the number. This is caught by a
   keyword fast-path first, so it is instant and never costs an AI call.
2. **Hot** (clear interest / wants to talk) -> **escalate**: no bot reply, hand
   the thread to a human (you) with full context. The bot deliberately steps
   back so it never talks over a live lead.
3. **Everything else** (warm, hedged, asking for comp/stack/details) -> the AI
   drafts the next SMS **in the recruiter's voice** (plain text, 1 to 3 short
   sentences, no emojis, no em dashes, always proposing a concrete next step)
   and the webhook sends it automatically.

The webhook returns `{ intent, escalate, replied, reason }` so RecruiterOS can
log the decision and ping you when something is hot.

---

## What you will do (4 parts)

  A. Get a Telnyx account + API key + a messaging-capable number
  B. Put the keys on the Hetzner server and redeploy
  C. Point your Telnyx number's inbound webhook at RecruiterOS
  D. Send a test text and watch it qualify

(Optional E: turn on the mobile-vs-landline lookup. Optional F: send from your
own app via the send API.)

================================================================
PART A, Telnyx account + API key + a number
================================================================
If you already set up Telnyx for the RecruiterOS phone project, you can reuse
the SAME account, key, and messaging profile, skip to step A5 to grab the
messaging profile ID.

1. Go to https://telnyx.com and sign up (free to start). Verify your email.
2. In the left sidebar open **API Keys** (under "Account" / "API Keys").
   - Click **Create API Key**. Name it `recruiteros`.
   - It shows the key ONCE, starting with `KEY...`. Copy it into Notepad.
     KEEP IT PRIVATE. Do NOT paste it into chat or commit it to GitHub.
3. Buy a number: **Numbers -> Buy Numbers**. Filter for **SMS** capability
   (and Voice too if you want calls). Buy one in your target area code.
4. Create a **Messaging Profile**: **Messaging -> Messaging Profiles ->
   Create**. Name it `recruiteros`. Open it and **assign your number** to it.
5. Copy the **Messaging Profile ID** (a UUID shown on the profile page) into
   Notepad next to your key. You now have three things:
       - API key            (KEY...)
       - Your SMS number     (E.164, e.g. +14155550123)
       - Messaging Profile ID (a UUID)

================================================================
PART B, Put the keys on the server + redeploy
================================================================
1. Open Windows PowerShell. Connect to the server:
       ssh root@178.156.170.244
   (enter your root password; nothing shows as you type, that is normal)

2. Go to the app folder and pull the latest code:
       cd /opt/recruiteros
       git pull

3. Open the production env file:
       nano .env.production

4. Set these (the first three already exist near the "Texting" comment):
       RECRUITEROS_SMS_PROVIDER=telnyx
       TELNYX_API_KEY=KEY_paste_your_key_here
       TELNYX_MESSAGING_PROFILE_ID=paste_the_uuid_here

   Make sure these are also set (they power the AI qualifier; you likely set
   them already for the rest of RecruiterOS):
       ANTHROPIC_API_KEY=...            # required for auto-replies + classify
       RECRUITEROS_LLM_MODEL=claude-sonnet-4-6

   If RecruiterOS will call the outbound send API (Part F), it also needs:
       RECRUITEROS_API_TOKEN=a_long_random_string   # bearer for /api/sms/send

5. Save and exit nano:
       Ctrl + O   (then Enter)   = save
       Ctrl + X                  = exit

6. Apply it (rebuild + restart). Wait a couple minutes:
       docker compose up -d --build

================================================================
PART C, Point Telnyx at the inbound webhook
================================================================
This is what makes texting two-way. Without it, you can send but replies go
nowhere and nothing gets qualified.

1. In Telnyx, open **Messaging -> Messaging Profiles -> your `recruiteros`
   profile -> Inbound** settings.
2. Set the **Webhook URL** to:
       https://recruitersos.co/api/sms/webhook
3. Webhook API version: **API v2** (the route expects Telnyx's v2
   `{ data: { event_type, payload } }` shape).
4. Save. (Leave the failover URL blank for now.)

================================================================
PART D, Test it (the moment of truth)
================================================================
1. From your own mobile, text anything to your Telnyx number, e.g. "hey, tell
   me more about the role".
2. Within a few seconds you should get an AI reply back in the recruiter's
   voice proposing a next step. That means the full loop works: Telnyx ->
   webhook -> classify -> qualify -> auto-reply -> Telnyx -> your phone.
3. Now test the two important edges:
   - Text **STOP**. You should get NO reply (opt-out is honored). Suppress
     that number in your store.
   - Text something clearly hot like "yes let's book a call tomorrow". The bot
     should go quiet (it escalated to you). Check the logs to confirm.

Watch the loop live on the server:
       cd /opt/recruiteros
       docker compose logs --tail 50 -f app

Common issues:
   - No reply at all -> webhook URL wrong/misversioned (redo Part C), or
     `ANTHROPIC_API_KEY` missing (auto-reply needs it). Check the logs.
   - "TELNYX_API_KEY not configured" -> key did not save; redo Part B.
   - Telnyx 401/403 in logs -> wrong/expired API key.
   - Reply sent from the wrong number -> the number is not assigned to the
     messaging profile (Part A4) or the profile ID is wrong (Part B4).

================================================================
PART E (optional), Only text mobiles (skip landlines)
================================================================
Texting a landline burns money and looks bad. Telnyx Number Lookup tells you
the line type cheaply (~$0.0025/query) and reuses your `TELNYX_API_KEY`.

1. On the server, in `.env.production`, add:
       TELNYX_NUMBER_LOOKUP=1
2. Redeploy (`docker compose up -d --build`).
3. RecruiterOS will gate sends to mobiles via:
       GET https://api.telnyx.com/v2/number_lookup/{phone}?type=carrier
   (See the note block in `.env.example` for the exact line.)

================================================================
PART F (optional), Send a text from your own app
================================================================
To fire a text yourself (or from a campaign step), call the send API. It is
auth-protected with `RECRUITEROS_API_TOKEN` (set in Part B):

       POST https://recruitersos.co/api/sms/send
       Authorization: Bearer <RECRUITEROS_API_TOKEN>
       Content-Type: application/json

       {
         "from": "+14155550123",        // your Telnyx number (E.164)
         "to":   "+447700900123",       // recipient (E.164)
         "text": "Hi Sam, quick one about a Senior React role in Berlin...",
         "ref":  { "campaignId": "c1", "prospectId": "p9" }   // optional
       }

Replies to that text flow straight back into the qualifier from Part C. The
same Telnyx provider powers both your manual sends and the AI auto-replies, so
there is nothing else to wire up.

================================================================
NOTES
================================================================
- All keys live ONLY in `/opt/recruiteros/.env.production` on the server. That
  file is gitignored, never committed, never shown to anyone.
- To swap Telnyx for your own SMS gateway, set
  `RECRUITEROS_SMS_PROVIDER=internal` and fill `RECRUITEROS_SMS_URL` +
  `RECRUITEROS_SMS_TOKEN`. The qualifier and webhook do not change; only the
  send transport does (see `internalSms` in `provider.ts`).
- Opt-outs are honored automatically by the classifier's keyword fast-path, so
  STOP works even if the AI is down. You are still responsible for suppressing
  the number in your store so you never text it again.
- The auto-reply style (plain text, no emojis, no em dashes, always proposes a
  next step) is enforced by the `SYSTEM` prompt in `conversation.ts`. Edit that
  one string to change the voice; no other change needed.
- The inbound webhook does not yet verify a Telnyx signature. If you want to
  reject spoofed inbound calls, add an HMAC check (the pattern already exists
  as `verifyProviderSignature` in `integration/lib/linkedin/auth.ts`).
