# Comment Posting

Reaching hiring managers whose LinkedIn profile is **closed** by commenting on their hiring post
instead of messaging them. Built, tested, and **deliberately parked**: this is not on `main` and
nothing is live.

Status: **built, held (2026-08-14)**. Owner decision was to sit on it rather than ship. See
[Why this is parked](#why-this-is-parked) before picking it back up, and
[Before shipping](#before-shipping) before merging.

---

## The problem it solves

The Role Hunter finds decision makers posting roles they need filled. Before this branch, a poster
whose profile was closed was a dead end: one profile read spent, the lead dropped, the person
cached as unreachable for 30 days. Only open profiles and existing 1st-degree connections could be
messaged at all.

Their **post** is public even when their profile is not. Commenting on it notifies the author with
no open profile and no connection required. The "Reads saved" and closed-found counters on the Role
Hunter card are the volume this recovers.

---

## How it works

### Lane selection

At the point of the profile read in `scanPosters`:

| Poster | Lane | Action |
|---|---|---|
| Open profile, or 1st-degree | DM | Private direct message (unchanged) |
| Closed profile, lane on | Comment | Public comment on their hiring post |
| Closed profile, lane off | none | Skipped and cached, the old behaviour |

Closed profiles clear **every wall an open profile clears**: the recruiter wall, the decision-maker
title check, and DNC/recency. A public comment is seen by more people than a DM, not fewer, so the
gates get stricter here, never looser.

### The closed-profile cache learned to tell two things apart

`state.closedProfiles` was conflating two different facts:

- **`wall:<iso>`** — a recruiter or staffing peer. Always skipped, lane on or off. Never wanted.
- **`<iso>`** (no prefix) — "cannot receive a DM". Ignored while the comment lane is on, because
  that stopped being a dead end.

Entries written by older builds have no prefix and are therefore treated as plain closed profiles,
which is the intended migration: the backlog those entries were suppressing comes back into play
the moment the lane is switched on.

### The throttle

Three walls, all sitting **under** the engine's existing `interactions` category cap in
`os/policy.ts` (balanced preset: 15/day target, 30 hard, 80/week). The engine can still refuse
after this lane says yes.

| Wall | Default | Behaviour |
|---|---|---|
| Per day | 8 base | Jittered **plus or minus 40%** (so 5 to 11), seeded on workspace + date |
| Per week | 35 | Hard rolling 7-day ceiling, no jitter |
| Spacing | 24 to 95 min | Randomized gap after each comment |

The jitter is the point, not decoration. A desk that posts exactly 8 comments every single day is
itself a pattern. The day seed is workspace + date, so the number holds all day (the card does not
flap) and differs tomorrow.

A throttle refusal **leaves the draft open**, not skipped. The comment is still worth posting, just
not this minute. Both hand-approval and autopilot re-read the throttle every time.

Only sends the engine **accepted** are logged against the day and the week.

### Copy: no template bank, on purpose

The MPC DM bank is 15 templates. That is safe in a private inbox and dangerous in public, where the
same fifteen sentences appearing under hundreds of posts is exactly what gets comments silently
hidden. So this lane has **no bank**. Every comment is written per post under `POST_COMMENT_RULES`,
which bans pitching outright: no services, no bench, no "DM me", no links.

If the model is unavailable, or the draft reads too close to something already posted, **the lead
is dropped** rather than filled with something repeatable.

The near-duplicate guard compares content-word overlap (>60% of the shorter text) against both what
has been posted and what is still sitting in the approval queue. A single tick drafting eight
comments that rhyme with each other is the same tell as posting eight that do.

---

## Where the code is

| File | What changed |
|---|---|
| `integration/lib/linkedin/commentWatch.ts` | Lane routing, throttle, copy rules, approve/edit/skip |
| `integration/app/api/linkedin/comments/route.ts` | `comment_approve`, `comment_skip`, `comment_edit`, `comment_limits_set` |
| `assets/js/command.js` | Limits section + comments tile on the Role Hunter card, comment block in the feed |
| `integration/scripts/test-comment-throttle.mts` | 11 checks over the throttle and the duplicate guard |

Frontend source of truth is root `assets/`; `integration/public/assets` is a build artifact synced
by the Dockerfile prebuild.

The plumbing underneath was already there and untouched: `unipile.commentOnPost()` posts to
`/api/v1/posts/{id}/comments`, and `os/executor.ts` has handled `comment_post` all along. Only the
Role Hunter's closed-profile branch was missing.

---

## LinkedIn limitations that shaped the design

1. **Comments are public.** Every competitor watching that post sees it, and so does the poster's
   team. This is why the comment cannot be the pitch.
2. **A comment does not open a channel.** They can reply in-thread, but a closed profile still
   cannot be DMed afterwards. Comment is a door-knock, not a delivery mechanism.
3. **Spam filtering is silent.** LinkedIn can auto-hide a comment with no signal back through the
   API: the call returns success and nobody ever sees it. Nothing in the stack can currently detect
   this.
4. **Shared risk pool.** Unipile acts as the logged-in member, so comments spend the same account
   trust as connects and DMs, and public comments are reportable by anyone.
5. **Author controls.** The poster can restrict commenting or delete/report the comment.
6. **Unverified.** Whether `@`-mentioning the author is supported in the plain `text` body has not
   been confirmed against the live Unipile API. Comment length ceiling is ~1,250 characters, well
   above the 400 this lane allows.

### Profile visibility, for the record

There is **no way to hide your comments**. Not from the post (anyone who can see the post sees the
comment), and not from your profile's activity feed, which has no hide-my-comments toggle for
logged-in members. Public-profile settings only affect logged-out visitors and search engines.
Blocking is one member at a time and capped.

The mitigation is not concealment, it is that the comment is unremarkable. Verify LinkedIn's
current settings paths before relying on any of this; they move.

---

## Why this is parked

The lane works. The hesitation was never the code.

At 8/day this operates **inside organic human range** (an engaged salesperson or creator comments
10 to 20 times a day without anyone blinking), and commenting is the least policed action on the
platform: enforcement concentrates on connection requests and scraping. So the volume is not the
exposure.

What determines whether this survives is whether the comments read like a peer or like an ad. That
is a judgement call on real output, not something to settle in advance. The plan is to run the lane,
read what actually goes out, and decide from there.

A rejected idea, recorded so it does not come back around: **deleting comments on a timer, or when
the poster views your profile.** Delete-on-view has no data source (nothing in this stack reads who
viewed your profile, and LinkedIn's own who-viewed-me data is structurally incomplete). A fixed
24-hour TTL is its own machine signature, strands anyone who clicks the notification later, risks
killing live threads, and hides a trail that good comments would rather have visible. If a TTL is
ever built it must be jittered, must never touch a comment with a reply or reaction, and must space
its deletions.

---

## Open work, in priority order

1. **Reply when replied to.** The loudest tell in the current design and the biggest wasted
   opportunity: the lane comments and never engages in-thread. Real people answer.
2. **Desk coherence.** The hunter runs multiple scenarios across multiple roles, so the comment
   trail can read as scattershot markets. Specialists cluster; scattershot is what looks industrial.
3. **Mixed activity.** An activity feed that is 100% cold comments reads worse to a human reviewer
   than a normal messy one.
4. **Jittered TTL**, only if still wanted after 1 to 3.
5. **Confirm `@`-mention support** in the Unipile comment body.

Comment deletion is **not currently possible through the client**: `unipile.ts` has create, list,
and react, but no delete. The comment id does come back from the create call as
`providerMessageId`, but is never persisted onto the item, so today there is nothing to delete by.
Both would need doing first.

---

## Before shipping

- **The lane defaults to enabled** (`commentLimitsFor` returns `enabled: true` when unset). If any
  industry is on set-and-forget autopilot, comments start posting publicly with no approval step the
  moment this deploys. Decide this deliberately, and flip the default first if that is not wanted.
- Deploy path: pushing to `origin/main` auto-deploys to the box within ~2 minutes.
- Existing `interactions` caps in `os/policy.ts` apply on top and may bind before this lane's own
  limits do.
