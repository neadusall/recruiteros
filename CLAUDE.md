# RecruitersOS - rules for AI-assisted changes

## Data scoping (hard rules)

1. **Tenant wall**: every read/write is scoped by workspace. The HOST decides the company;
   nothing crosses workspaces, ever.

2. **Personal artifacts are per-recruiter, not per-workspace.** Anything that carries a
   specific person's face, voice, name, or authored content (webcam recordings, cloned
   voices, PiP composites, signatures, greetings) MUST store the owning recruiter's email
   and MUST be filtered to the requester on every portal list/stream/delete route.
   Workspace owner/admin may keep a full-workspace view; plain members see only their own.
   `integration/lib/inmarket/ownership.ts` is the reference implementation - reuse it.
   Workspace-wide is correct only for genuinely shared things (brand kit, page captures,
   curated leads, settings).

3. **New stores declare ownership on day one.** When adding any user-generated-content
   store, include `ownerEmail` in the record shape from the first commit. Retrofitting
   ownership later requires backfills on prod snapshots (see the hydration-trap note
   below).

## Outreach content

4. **No fabricated-looking content in recipient-facing assets.** Video backgrounds must be
   REAL page captures (`company_site`). The typeset role-card fallback is opt-in only
   (`INMARKET_ROLE_CARD=1`) per owner mandate 2026-08-14.

5. No em-dashes in copy/UI/email. No unsubscribe links or open-tracking pixels in cold
   email. Email creation and meeting summaries stay pinned to claude-haiku-4-5.

## Sending safety (receiver-side truth beats vendor dashboards)

9. **Never hardcode a receiver block in routing code.** Which providers reject which
   sending fleet is DATA: the host NDR sweeps detect block signatures across every
   bounce notice (campaign AND warm-up) and persist fleet x provider pairs to
   `snap_provider_blocks_v1`. Routers (`lib/senders/recipientGuard.ts`, batch.mjs)
   read that ledger and steer; a healed provider ages out on its own. To cover a new
   rejection pattern, extend the sweep's signature table, never a router's if-branch.

10. **Every new Email ID passes the onboarding audit before it is relied on.**
    `lib/senders/onboarding.ts` vets imports (SMTP login, live SPF/DMARC/MX,
    blocklists, mail-server rDNS) on the maintenance tick, stamps
    `onboardAuditAt`/`onboardProblems`, and alerts the owner on new failures. New
    import paths need NO extra wiring (the tick audits anything unstamped), but they
    must never pre-stamp `onboardAuditAt`.

11. **Warm-up vendor metrics are never sufficient proof of health.** Activation and
    graduation decisions must consult real bounce notices (the NDR sweeps' snapshots);
    the guard's graduation veto (`SENDER_GRADUATE_MAX_NDR`) exists because a fleet ran
    "reputation 100%" for weeks while Gmail rejected every message.

## Prod snapshots (hydration trap)

In-memory stores backed by `/data/snap_*.json` are re-saved by the running app. Never
edit a snapshot file while the app runs and expect it to stick: write the file, then
rebuild/restart the app so a fresh boot hydrates it (or do the change through an API).

## Sending capacity (single source of truth)

Owner mandate 2026-08-19, after two portal surfaces showed 2,150/day and ~100/day for
the same fleet on the same afternoon:

6. **Every number that claims to be sending capacity comes from
   `lib/senders/store.ts sendCapacity()` (or `stats()` beside it).** Never sum per-box
   caps in a route, tool, or UI yourself. If a surface needs a new slice of capacity,
   extend sendCapacity() and read the new field.

7. **Capacity math is domain-rest aware.** A mailbox whose domain is resting in
   `snap_mpc_domain_rest_v1` contributes ZERO to today's capacity; it is reported
   separately as benched (benchedInboxes / benchedCapacity), shown, never blended in.

8. **Status surfaces must degrade honestly.** A panel that cannot reach its data says
   so; it never falls back to a theoretical ceiling that reads like live capacity.
