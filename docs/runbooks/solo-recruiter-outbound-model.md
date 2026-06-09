# Solo Recruiter Outbound Model — 40 mailboxes

The standing outbound model for **one recruiter** running BD on RecruiterOS's owned
email stack (self-hosted Postal MTA, not Google/M365 seats, not Instantly). Built for
40 mailboxes out of the gate. Pairs with `docs/design/self-hosted-email-infrastructure.md`
(cost model §4) and the live Sending → Deliverability dashboard.

---

## The build (infrastructure)

| Layer | This model | Notes |
|---|---|---|
| Domains | **10** (lookalike, never the corp domain) | ~$10/yr each at Cloudflare/Porkbun |
| Mailboxes | **40** — 4 per domain | self-hosted on Postal = **$0 each** |
| Postal MTA | **1–2 VPS** (Hetzner CX22, ~$5 ea) | one box is plenty for the volume; a 2nd only to host a 2nd IP |
| Dedicated IPv4 | **2** (~$2 ea) | split 20 mailboxes / 5 domains per IP, so one bad list can't sink both pools |
| Monitoring | Postmaster + SNDS + EasyDMARC | free tiers cover this scale |

Why 2 IPs at 40 mailboxes: a single well-warmed IP comfortably carries ~1,000–1,500
sends/day. At full tilt 40 mailboxes can push ~1,600–2,000/day, which is over one IP's
comfort line. Two IPs keep each pool at ~700–900/day — safe, with room to grow.

---

## Capacity vs. what a solo recruiter actually sends

The 40-mailbox build is deliberately **larger than a solo recruiter's daily prospect
flow** — that gap is the point.

| | Number |
|---|---|
| Per-mailbox mature cap | 40–50/day (ramps from 10, +5/day; ceiling `SENDING_MAILBOX_CEILING=50`) |
| **Peak capacity** | 40 × 40 ≈ **1,600/day** (~30,000–35,000/mo) |
| **Realistic solo throughput** | **~75–150 new prospects/day** from signals |
| Steady-state email volume at that pace | ~300–600/day → **~8–15 per mailbox/day** |

So a solo recruiter runs each mailbox at **well under a third of its cap**. That is
exactly what you want: low per-mailbox volume = best-in-class inbox placement, and you
can 3–5× the prospect flow (or add a teammate) before touching the infrastructure.

---

## Warm-up schedule (the first ~4 weeks — do not skip)

A self-hosted IP starts at zero reputation. Warm the IP and the mailboxes in waves;
never launch all 40 cold on day one.

| Phase | Mailboxes live | Per-mailbox/day | Pool/day | Gate |
|---|---|---|---|---|
| **Week 1–2** | 15 (warming) | 10 → 25 | ~150–375 | Run seed tests; placement must pass (~90%+ inbox) before scaling |
| **Week 3–4** | 30 | 25 → 40 | ~750–1,200 | Watch bounce/complaint; keep both green |
| **Week 5+** | all 40 | 40 → 50 | ~1,600 | Mature; volume now follows real prospect flow |

The system runs the ramp automatically on the daily tick (`/api/sending/cron` →
`runSendingDaily`): it advances each warming mailbox, graduates it at the ceiling,
refreshes reputation, and runs the governor. You just watch the warmth/health scores.

---

## Daily operating rhythm (the funnel, end to end)

Everything below already runs in code; the recruiter's job is the 8:30 approval + watching the dashboard.

```
 signals hit  → enrichment (real person + contact) → persona LLM drafts content per channel
      → confidence gate (>= 0.7): enroll "active" + de-dupe ledger; below: hold "needs_review"
      → n8n pulls GET /api/prospects/queue (finished content attached)
          ├─ ① EMAIL via owned MTA (POST /api/email/send) — picks a warmed mailbox under cap, checks suppression
          │      └─ auto-fires ② AMD voicemail to landline (drained by /api/voice/cron, inside the lead's window)
          ├─ ③ LinkedIn connect + accept-gated note
          └─ ④ LinkedIn voice note (connected prospects only)
      → any reply / opt-out → sequence pauses, prospect suppressed
      → 6-month nurture keeps non-responders warm
```

Per-mailbox rotation is automatic (`pickMailbox`): the system always sends from the
healthiest mailbox with the most remaining cap on an active domain, spreading load so
no single mailbox or domain burns.

---

## Cost for this model

| | Realistic solo use (~100 prospects/day) | Full capacity (~30K emails/mo) |
|---|---|---|
| Domains (10) | ~$10/mo | ~$10/mo |
| Mailboxes (40, self-hosted) | $0 | $0 |
| Postal VPS (1–2) | ~$5–15/mo | ~$10–15/mo |
| Dedicated IPv4 (2) | ~$4/mo | ~$4/mo |
| Monitoring | $0 | $0 |
| **Infra subtotal** | **~$20–30/mo** | **~$25–30/mo** |
| Enrichment + LLM content (~$0.011/prospect) | ~$25–35/mo | ~$80–110/mo |
| **All-in** | **≈ $50–70/mo** | **≈ $110–140/mo** |

For comparison, 40 Google reseller inboxes + Instantly ≈ $140–200/mo in seats + platform
*before* enrichment. Self-hosted is cheaper and fully owned.

---

## What to watch (the dashboard + fail-safes)

Sending → Deliverability shows, live:
- **Mailbox warmth** (per mailbox): ramp progress 0–100, warmup day, today's send/cap.
- **Domain health** (per domain): 0–100 from bounce/complaint/delivery + reputation + inbox-placement, with ⚠ early warnings before a limit trips.
- **Roll-up**: overall health, overall warmth, "sending now?", sends-left-today, mailboxes warmed, paused domains.

**Fail-safes (automatic):** the governor pauses a domain and its mailboxes at bounce >2%,
complaint >0.1%, spam >0.3%, or a "bad" reputation tier — before the pool burns. Hard
bounces and complaints auto-suppress the address forever. Keep every domain green; if one
trips, the rest keep sending.

**The one ongoing job:** ~10 minutes/day on the dashboard. Keep lists clean (verify before
send), keep one-click unsubscribe honored (it is, automatically), and never scale a domain
the governor flagged.
