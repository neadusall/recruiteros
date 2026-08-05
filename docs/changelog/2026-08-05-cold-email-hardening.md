# 2026-08-05 - Cold-email hardening pass (Anevo-study alignment)

One coordinated pass closing every remaining gap between the sending stack and
cold-email best practice (benchmarked against the Anevo 650k-email sequencer
study: list quality, infra hygiene, and reply follow-up speed decide results,
not the platform).

## Send-path gates (every path, no exceptions)

- Pre-send verification at the dispatch chokepoint (`lib/sending/verify`):
  syntax + cached MX + stored-verdict check. Provable garbage never leaves;
  dead addresses park the prospect as do_not_contact.
- BD Bulk, nurture and booking sends now run the same suppression contract as
  the pooled path via `mta.sendEmail`'s `coldOutreach` flag: workspace DNC/STOP
  list + bounce list + List-Unsubscribe headers + CAN-SPAM footer. BD Bulk also
  verifies + dedupes every recipient against the contact ledger before sending.
- Email-level contact ledger (`lib/outreach/contactLedger`): the 14-day
  no-double-contact rule now works for cold prospects with no ATS record
  (previously a silent no-op for exactly that population).
- The Instantly fallback fails loudly (`email_no_provider`) instead of
  dry-running and "looking sent".

## Deliverability infrastructure

- Hard/soft bounce classification (`lib/sending/bounces`); `MessageHeld` is no
  longer counted as a bounce; soft bounces suppress for 30 days instead of
  forever; hard bounces + complaints stay permanent.
- Pool bounce ingest: SMTP recipient rejections and IMAP DSNs now increment
  `SenderInbox.bounced` (arming the health guard's bounce rule, previously dead
  code), suppress the recipient, and park the prospect.
- SMTP failure accounting: 3 consecutive transport failures flip an inbox to
  "error" so the rotation stops picking a dead login (it used to be re-picked
  first); any clean send resets the streak.
- Warm-up ramp date guard: ramp days now advance once per calendar day (the 6h
  tick + hourly cron used to burn ~4 ramp days/day). Young inboxes (< 3 days,
  env `SENDING_COLD_MIN_AGE_DAYS`) send no cold mail on either stack.
- Send window now holds on US holidays (+ `OUTREACH_HOLIDAYS` extras).
- True daily enrollment caps: `campaign.dailyCap` is enforced per calendar day
  via a persisted counter (was per 30-minute tick, a silent 48x multiplier).
- Threshold unification (`lib/sending/policy`): warn 1%, pause 2%, complaint
  0.1%, spam 0.3%, inbox hold 5%; governor, health score, capacity model and
  health guard all read the same numbers now.

## Reply pipeline (the follow-up-speed lever)

- NEW `lib/senders/replySync`: IMAP poller over the pool's own inboxes.
  Replies to pool/MTA cold sends are now ingested (previously invisible):
  classified, routed, sequences stopped, humans notified. DSN bounce mail feeds
  the suppression + inbox bounce counters. Driven by the `reply_sync` scheduler
  tick (5 min) and `/api/sending/cron` (hourly server timer).
- NEW `auto_reply` class (header- and phrase-detected): OOO/bot mail no longer
  pauses live sequences, never notifies, and is excluded from reply stats.
- `soft_yes` now notifies a human and pauses the sequence (it used to keep
  robo-touching someone who asked a question).
- Stats truth: `nurture` (= sequence finished, zero replies) and
  `do_not_contact` no longer count as "replied".

## Hire Signals sequence: 2 touches -> 3, threaded

- Day 0 text intro, Day 1 video follow-up, NEW Day 5 direct-ask closer
  (4 spintax-heavy variants x 2 branches). Watch-aware branching: prospects
  whose watch-page telemetry shows a view get the warm variant; lookup failure
  downgrades safely to the standard copy.
- Real email threading: the first email mints an RFC Message-ID; every later
  touch rides `In-Reply-To`/`References` + "Re: <original subject>" so the
  sequence is ONE conversation (no more fake "re:" heuristics).

## Monitoring + security

- SNDS parsing is content-located and color-mapped (a malformed feed can no
  longer silently rate every domain "high"); Google Postmaster is a real client
  (service-account JWT via `POSTMASTER_SA_JSON`) feeding domain reputation.
- Postal webhook fails closed without `SENDING_WEBHOOK_SECRET`
  (escape hatch: `SENDING_WEBHOOK_ALLOW_UNSIGNED=1`); response webhooks log a
  loud once-per-source warning when signature secrets are unset; unknown
  webhook sources are rejected.
- DNS scoring: an unprobed domain no longer outranks a confirmed-broken one.
- Go-live readiness gained deliverability rows: CAN-SPAM postal address,
  unsubscribe signing secret, pool health holds.
- Scheduler ticks added: `reply_sync` (5 min), `smtp_auth` sweep (6h),
  `warmup_engage` (5 min, no-op unless `SENDING_WARMUP_ENGAGE=1`).
- MTA tracking flags are env-controlled: opens default ON
  (`SENDING_TRACK_OPENS=0` to disable), click-rewriting defaults OFF
  (`SENDING_TRACK_CLICKS=1` to enable) since rewritten URLs are a cold spam
  signal.

## Doc corrections

- `daily-bd-operating-model.md` hardening list marked CLOSED with pointers.
- `RECRUITEROS-BACKEND.md` no longer claims Smartlead/Zapmail are dropped.
- `cold-email.md` + `billing/rates.ts` describe the real 9-class classifier;
  the cost model's per-inbox volume now matches the enforced caps.
