# RecruiterOS — Multi-Channel Outreach Router (n8n)

An importable n8n workflow that takes **one person** (with an industry + job title),
classifies them, routes them into **one of four outreach scenarios**, couples the
right **content** and the right **multi-channel sequence** to them, and enrolls them
into RecruiterOS — which then runs the actual email / voice-drop / LinkedIn
connect / LinkedIn message / LinkedIn voice-note cadence.

- Workflow file: [`recruiteros-outreach-router.json`](recruiteros-outreach-router.json) — import this into n8n.
- Generator (edit + regenerate): [`build-workflow.cjs`](build-workflow.cjs) — `node docs/integrations/n8n/build-workflow.cjs`.

The **send path is RecruiterOS** (your decision): n8n classifies + selects content +
selects the sequence, then hands off to RecruiterOS's cadence/sequence engine. That
keeps compliance windows, warmup, mobile-strip, A/B, and activity logging in one
place. n8n never touches Telnyx / Unipile / Instantly directly.

---

## The 4 scenarios (seniority × warmth)

Routing happens in the **Classify & Route** node. Branches:

| # | Trigger condition | Playbook | Channels (in order) | Methodology |
|---|---|---|---|---|
| **1** | Decision-maker **and** warmth ≥ threshold (default 80) | Voice-first, fastest, highest-touch | LinkedIn connect → voicemail drop → LinkedIn voice note → email → DM | `voice_first` |
| **2** | Decision-maker, cold | Full 28-day multi-channel drip | 7 email + 6 LinkedIn touches; voice note unlocks when warmth ≥ threshold | `seven_touch_drip` |
| **3** | Manager / senior / IC (eng, product, sales) | LinkedIn-led, email fallback | LinkedIn connect → engage → DM, email fallback. No voicemail drop. | `hiring_manager_outreach` |
| **4** | Cold / low-warmth, everyone else | Email-only nurture | 7-touch email drip → break-up → 90-day nurture | `seven_touch_drip` |

"Decision-maker" = seniority is `manager | director | vp | c_level | founder`
(same `classifyTitle` logic as `integration/lib/signals/filters.ts`).

### Best practices baked in
- **Connect before you DM** — LinkedIn DM steps require an accepted connection (enforced by RecruiterOS's sequence engine).
- **Warmth-gated voice** — voicemail drop / LinkedIn voice note only fire at/above the voice threshold, the single highest-converting touch reserved for HOT prospects.
- **Signal-anchored opener** — first email/DM hooks the trigger event and asks "worth sending?", not "book a call".
- **Reciprocity before the ask** — value drop / case study before any calendar link.
- **Reply on any channel pauses all** — handled by RecruiterOS, not duplicated in n8n.

To change any branch's channels, content, or which sequence it uses, edit the
**Scenario N Playbook** node (or `scenarioPlans` in the generator).

---

## One-time setup

### 1. Create the n8n credential
In n8n: **Credentials → New → Header Auth**, name it exactly **`RecruiterOS API`**.
- **Name:** `Authorization`
- **Value:** `Bearer <your-session-token>`

Get a token by calling `POST /api/auth/login` (email + password) and copying the
returned token, or reuse a long-lived session token. Every `/api/*` route used here
is workspace-scoped to that token.

> After importing, open each HTTP Request node once and re-select the `RecruiterOS API`
> credential (the import ships a placeholder credential id).

### 2. Set your defaults
Open the **Classify & Route** node and edit the `CONFIG` block at the top:
```js
const CONFIG = {
  baseUrl: 'https://YOUR-RECRUITEROS-HOST',  // your app origin, no trailing slash
  defaultCampaignId: 'CHANGE_ME',            // fallback campaign id
  voiceNoteThreshold: 80,                     // warmth gate for voice
};
```

### 3. Create the segment campaigns, sequences, and content
The router routes people *to things that must already exist* in RecruiterOS:

**a) Sequences** — one multi-channel ("multi") sequence per scenario, **tagged** so
the router can find it. In Campaigns → Sequences, create and tag:

| Scenario | Tag the sequence with |
|---|---|
| 1 | `scenario-1-voicefirst` |
| 2 | `scenario-2-multichannel` |
| 3 | `scenario-3-linkedin-led` |
| 4 | `scenario-4-email-nurture` |

Each sequence's steps carry the per-touch channel + copy (email subject/body,
LinkedIn `connect`/`message`/`voice_note`, `voice` drop script id). Use the 28-day
anatomy in `integration/lib/campaigns/sequence.ts` as the template.

**b) Content** — handled automatically by the **parameterized content library**
(`integration/lib/content/library`, see its README). The **Craft Preview** node calls
`GET /api/content/craft` with this lead's function / seniority / industry / signal /
motion and returns the exact targeted, multi-channel copy that will be sent — rendered
instantly from the pre-authored pool, no per-asset naming required. The same library
also feeds the RecruiterOS cadence drafter, so the copy in the preview is the copy that
gets enqueued for approval. (The legacy per-campaign asset library at `/api/content`
still exists for hand-written one-offs, but is no longer required for targeting.)

**c) Campaigns** — point each scenario at the campaign that owns that segment's
content. The simplest setup is one campaign per scenario (or per scenario × industry)
with the matching content assets attached; set the id in the **Scenario N Playbook**
node's `campaignId` (defaults to `defaultCampaignId`).

---

## How to trigger it

POST a person to the webhook (**Person In**). Minimum useful payload:
```json
{
  "person": {
    "fullName": "Marcus Webb",
    "title": "Chief Operating Officer",
    "company": "Meridian Health Partners",
    "industry": "healthcare",
    "email": "marcus@meridianhealth.com",
    "linkedinUrl": "https://linkedin.com/in/marcuswebb",
    "phone": "+1...",
    "warmth": 82,
    "motion": "bd"
  }
}
```
`industry` and `warmth` are optional — the router infers industry from
company/headline and defaults warmth to 50 if absent. `motion` defaults from the
job function.

### Response
```json
{
  "ok": true,
  "scenario": 1,
  "scenarioName": "Decision-maker - warm: voice-first multi-channel",
  "classification": { "function": "operations", "seniority": "c_level", "isDecisionMaker": true, "industry": "healthcare", "warmth": 82, "hot": true, "motion": "bd" },
  "routedTo": { "campaignId": "...", "methodology": "voice_first", "channels": "linkedin_connect, linkedin_voice_note, voice_drop, email, linkedin_message" },
  "prospectId": "...",
  "sequence": { "id": "...", "name": "..." },
  "content": [ { "id": "...", "name": "healthcare - operations - value_prop", "type": "value_prop" } ],
  "warnings": []
}
```

---

## What the workflow does, node by node

1. **Person In (Webhook)** — receives the person.
2. **Classify & Route** — computes function / seniority / industry / warmth / motion and picks scenario 1–4.
3. **Route by Scenario** — 4-way switch.
4. **Scenario N Playbook** — merges that scenario's playbook (campaign, tagged sequence, content types, channel order).
5. **Assemble Plan** — single consolidation point so downstream nodes don't care which branch fired.
6. **Fetch Sequences** → **Pick Sequence** — `GET /api/sequences?motion=…`, then pick the sequence tagged for this scenario.
7. **Upsert Prospect** — `POST /api/prospects` (creates/updates the prospect + ATS person).
8. **Enroll in Sequence** — `POST /api/prospects {action:"bulk-update", sequenceId, status:"in_sequence"}`.
9. **Craft Preview** — `GET /api/content/craft` renders this lead's exact targeted, multi-channel copy from the content library (the same copy the cadence drafter will enqueue).
10. **Trigger Cadence Draft** — `POST /api/campaigns/cadence` drafts the prospect into the approval queue. **Safe — it does not auto-send.** Remove this node if you run the daily cadence cron instead.
11. **Respond** — returns the routing summary, including the crafted preview.

The actual sends (email via Instantly, voice drop via Telnyx, LinkedIn via Unipile)
happen inside RecruiterOS on the sequence's schedule, after the approval-queue review.

---

## Spanning your campaigns (batch mode)

To sweep existing prospects instead of webhook-per-person, replace **Person In** with
a **Schedule Trigger** → **HTTP Request** `GET /api/prospects?status=queued`, then a
**Split Out** node over `prospects`, feeding **Classify & Route**. Everything
downstream is unchanged. (Left as a one-line swap so the default workflow stays
single-purpose and easy to read.)

---

## Extending

- **More than 4 scenarios / different cutoffs:** edit the routing block at the bottom of **Classify & Route**, add a Switch output, add a Playbook node.
- **Industry-specific channel mixes:** branch inside the relevant **Scenario N Playbook** node on `inb.classification.industry`.
- **Direct-send variant:** swap **Enroll in Sequence** for direct provider HTTP calls if you ever move off the RecruiterOS send path (not recommended — you'd re-implement compliance gating).
