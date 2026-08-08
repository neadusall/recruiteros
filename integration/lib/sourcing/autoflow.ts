/**
 * RecruitersOS · JD Sourcing · Server-side auto-send.
 *
 * THE GUARANTEE (user mandate): once a saved list's enrichment is done, the list
 * flows on to Candidates AND OS Text by itself — no button, no open browser tab.
 *
 * The hands-free chain in the JD Sourcing tab (command.js runAutoPipeline) already
 * does this live, but it runs in the browser: close the tab mid-chain, lose the
 * connection, or hit one failed request and the finished list just sits there
 * looking done while nothing was pushed. This sweeper is the server-side backstop
 * that makes the push unconditional (ticked from GET /api/sourcing/night by the ros
 * nightqueue timer every 2 minutes — see the note there on why not instrumentation):
 *
 *   every few minutes, for every saved recruiting list:
 *     - enrichment chain finished (laxisProgress.nextStart === null), settled a
 *       few minutes (so a live tab's own push wins the race), not yet sent  -> send
 *     - chain stalled/never ran (no jobs in flight) and the list has sat idle
 *       for IDLE_MS                                                          -> send what it has
 *     - already sent, but a later enrichment (Enrich resume, overnight queue)
 *       added phones                                                          -> send again (top-up)
 *
 * Double-sends are safe end to end: promote dedupes by LinkedIn URL against the
 * pipeline, and the OS Text engine's /api/import dedupes by (campaign, phone) —
 * so the worst case of racing the browser chain is an add of zero.
 *
 * Scope guards: recruiting-motion lists only (JD Sourcing candidate lists), and
 * only lists touched in the last FRESH_MS — the sweeper must never resurrect an
 * ancient list into a brand-new SMS campaign.
 */

import { nowIso } from "../core/ids";
import type { CandidateRow, SourcingRun } from "./types";
import { listAllSourcingRuns, saveSourcingRun, deleteSourcingRun } from "./store";
import { promoteSourcingRun } from "./promote";
import { listNightItems, addNightItem } from "./nightQueue";
import { mergeSourcingRuns } from "./mergeRuns";
import { enforceRunGeo } from "./geoEnforce";
import { combinableGroups } from "./sameRole";
import { deliverMinFit, qualifiedForOutreach, qualityBarNote } from "./qualityBar";
import {
  ostextImport, ostextStarterTemplate, ostextConfiguredFor, type OsTextContact,
} from "../ostextImport";
import { dedupeProspectLists } from "../prospect-lists";
import { preflightPush, reconcilePush, summarizePreflight } from "./preflight";

const SETTLE_MS = 5 * 60_000;      // chain-finished lists rest this long first (live tab pushes within seconds)
const IDLE_MS = 45 * 60_000;       // a stalled / never-started chain still flows on after this
const STUCK_MS = 60 * 60_000;      // a job ref idle this long = orphaned chain (tab died mid-job) -> resume it
const FRESH_MS = 7 * 24 * 3600_000; // only lists touched in the last 7 days are eligible
const MAX_ATTEMPTS = 20;           // ~1 hour of retries on a hard failure, then park with the error
const TOPUP_DEBOUNCE_MS = 10 * 60_000; // let a live Boost/gap-fill run accumulate finds between top-ups
const MAX_SENDS_PER_TICK = 3;      // bound one tick's work; the rest go next tick
const RESUME_REARM_MS = 60 * 60_000; // a resume that itself wedged becomes retryable again
const MAX_RESUMES = 6;             // ...but a chain that will never finish stops asking
const OUTAGE_GRACE_MS = 24 * 3600_000; // an engine down THIS long stops being "transient"

/**
 * Was this failure the OS Text ENGINE being unreachable, rather than anything
 * about this run?
 *
 * Matched on the bridge's own message (lib/ostextImport builds exactly this
 * prefix for both ostext_unreachable and ostext_timeout) rather than on the
 * error code, because only the MESSAGE is stamped onto the run — which also
 * means runs parked by an older build are recognized and healed.
 */
export function isEngineOutage(err: string | undefined): boolean {
  return Boolean(err && err.startsWith("Could not reach the OS Text engine"));
}

function phoneCount(run: SourcingRun): number {
  return run.candidates.reduce((n, c) => n + (c.phone ? 1 : 0), 0);
}

/** Stable per-candidate key — the same one mergeRuns dedupes on. */
function personKey(c: CandidateRow): string {
  return (c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`).toLowerCase().replace(/\/+$/, "");
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * The rows a delivery would actually carry — the SAME two exclusions both legs
 * apply (promote skips out-of-area and below-bar; toOsTextContacts skips the
 * identical pair). Measuring the gap against the raw candidate count instead
 * would read every held-back row as "missing" and top up forever chasing people
 * the bar is deliberately keeping out of outreach.
 */
function deliverableRows(run: SourcingRun): CandidateRow[] {
  const bar = deliverMinFit();
  return run.candidates.filter((c) => !c.outOfArea && qualifiedForOutreach(c, bar));
}

/**
 * Order-independent signature of WHO a delivery would carry right now, and which
 * of them hold a phone. Summed (not sequenced) on purpose: every merge re-ranks
 * the rows verified-first, and a reorder must not read as a membership change.
 * Built from the stable person key, so enrichment filling in an email or a phone
 * doesn't move the people half of it.
 */
function deliverySignature(run: SourcingRun): string {
  let people = 0, phones = 0, n = 0, p = 0;
  for (const c of deliverableRows(run)) {
    const h = hash32(personKey(c));
    people = (people + h) >>> 0; n++;
    if (c.phone) { phones = (phones + h) >>> 0; p++; }
  }
  return `${n}.${people.toString(36)}.${p}.${phones.toString(36)}`;
}

/**
 * Is what we DELIVERED behind what the list holds right now?
 *
 * The phonesAtSend/peopleAtSend triggers are aggregates, and aggregates go blind
 * in two ways that both cost a real recruiter real candidates (2026-08-07: a
 * combined list showed 1,892 candidates against 1,762 delivered and sat there
 * saying "campaign ready to launch"):
 *
 *  - a stamp carried across a combine that LOST peopleAtSend fell back to
 *    "people can't have grown", so a list that grew by 130 never topped up;
 *  - a merge that swaps members 1-for-1 leaves both counters identical while the
 *    set underneath is different.
 *
 * These two reads don't care about the counters. promotedCount is what promote
 * actually delivered to Candidates, and the signature is who the last push
 * carried — either falling behind the DELIVERABLE set means someone is missing,
 * and one top-up (which re-promotes and re-sends the full contact set) puts them
 * back. Both converge: the top-up rewrites both stamps.
 *
 * Both reads measure against deliverableRows(), never the raw list, so the rows
 * the quality bar and the radius hold back on purpose are not mistaken for a
 * shortfall. Raising the bar can only shrink the target (promotedCount ends up
 * ahead, which is not "behind"); lowering it grows the target and correctly tops
 * up the people who just became eligible.
 */
export function deliveryBehind(run: SourcingRun): boolean {
  // An ABSENT promotedCount means "never recorded", not "delivered nobody" — a
  // run predating the stamp must not read as behind and drag every old list into
  // a re-send. Only a number we actually have gets compared.
  if (typeof run.promotedCount === "number" && run.promotedCount < deliverableRows(run).length) return true;
  const sig = run.autoflow?.sentSignature;
  return Boolean(sig) && sig !== deliverySignature(run);
}

function enrichmentInFlight(run: SourcingRun): boolean {
  return Boolean(run.koldJob || run.koldDbJob || run.laxisJob);
}

/**
 * Rows the enrichment chain would still act on. Matters when a run has NO chunk
 * ledger at all — either the chain never started (tab died right after save) or
 * a Sales Nav / pasted-search merge wiped the ledger to re-open the chain for
 * its new rows and the driving tab died before restarting it. Ledger presence
 * alone can't distinguish "never ran" from "nothing to do", so ask the rows.
 */
function hasEnrichableRows(run: SourcingRun): boolean {
  return run.candidates.some((c) => !c.email || !c.phone);
}

/** Is the enrichment chain unfinished? With a ledger, trust it; without one,
 *  unfinished means there are rows the chain would still fill. */
function chainUnfinished(run: SourcingRun): boolean {
  if (run.laxisProgress) return run.laxisProgress.nextStart !== null;
  return hasEnrichableRows(run);
}

/**
 * Is this run's server-side resume still "in hand" — i.e. one was queued recently enough
 * that we should wait for it rather than queue another?
 *
 * The stamp used to be permanent, which made the one-resume rule a one-resume-EVER rule:
 * when the resume itself wedged (2026-08-06 — a KoldInfo DB pass stopped answering after
 * its single resume), the job refs stayed in flight, `due()` returned null on every sweep
 * from then on, and the list's card spun "Enriching now" forever with nothing behind it.
 * Now the stamp expires: after RESUME_REARM_MS with the chain STILL in flight, the resume
 * is treated as spent-and-failed and one more is allowed — up to MAX_RESUMES, so a chain
 * that genuinely cannot finish stops re-queueing instead of retrying hourly forever.
 *
 * Callers only reach this while `enrichmentInFlight(run)` holds, so "still in flight an
 * hour later" really does mean the resume didn't take: a resume that worked clears the
 * refs, and the whole branch stops applying.
 */
function resumeInHand(run: SourcingRun, now: number): boolean {
  const at = run.autoflow?.resumedAt ? Date.parse(run.autoflow.resumedAt) : NaN;
  if (!Number.isFinite(at)) return false;                       // never resumed: go
  if ((run.autoflow?.resumes ?? 1) >= MAX_RESUMES) return true;  // out of retries: hold
  return now - at < RESUME_REARM_MS;                             // recent: let it work
}

/** Should the sweeper act on this run right now? (exported for the regression suite) */
export function due(run: SourcingRun, now: number): "send" | "topup" | "resume" | "resume-send" | "ostext-retry" | null {
  if (!run.candidates.length) return null;
  if (run.motion === "bd") return null; // undefined motion (pre-field runs) counts as recruiting
  const touched = Date.parse(run.updatedAt);
  if (!Number.isFinite(touched) || now - touched > FRESH_MS) return null;

  if (enrichmentInFlight(run)) {
    if (now - touched < STUCK_MS) {
      // A LIVE chain updates the run on every submit/merge — leave it alone…
      // except FIRST-SIGHT DELIVERY (user mandate 2026-07-21: "why hasn't every
      // search been pushed to OS Text"): a NEVER-SENT list ships what it already
      // holds right now, so its Candidates list and OS Text campaign exist
      // minutes after the search finishes, not hours later when enrichment
      // ends. Everything the chain finds afterwards rides the top-up rule.
      if (!run.autoflow?.sentAt && (run.autoflow?.attempts ?? 0) < MAX_ATTEMPTS) return "send";
      return null;
    }
    // Job refs untouched past STUCK_MS = orphaned chain (the driving tab died
    // mid-job). Hand it to the overnight queue's resume machinery once — it
    // polls, merges, clears the refs and finishes the chain server-side. A SENT
    // list needs that resume too: with first-sight delivery every list is sent
    // almost immediately, and an orphaned chain would otherwise never finish
    // (top-up only fires on finds, and a dead chain finds nothing).
    // ...and if that resume wedged too, resumeInHand lets the next sweep queue another
    // (bounded) instead of parking the list on a dead chain for good.
    if (run.autoflow?.sentAt) return resumeInHand(run, now) ? null : "resume";
    if ((run.autoflow?.attempts ?? 0) >= MAX_ATTEMPTS) return null;
    return resumeInHand(run, now) ? "send" : "resume-send";
  }

  if (run.autoflow?.sentAt) {
    // Already sent: a later enrichment that found MORE phones re-sends (top-up),
    // and so does a merge that added MORE PEOPLE — a Sales Nav / pasted-search
    // merge can add people who hold no phone yet, and they still belong in
    // Candidates (older stamps lack peopleAtSend; they fall back to the
    // phones-only trigger). Debounced: a live Boost run finds numbers
    // continuously, and without the wait every 2-minute tick re-pushed the
    // WHOLE list for one or two new phones (a real list hit 35 attempts in a
    // day). Nothing is lost by waiting: the finds sit on the run and ride the
    // next top-up.
    const morePhones = phoneCount(run) > run.autoflow.phonesAtSend;
    const morePeople = run.candidates.length > (run.autoflow.peopleAtSend ?? run.candidates.length);
    if (morePhones || morePeople || deliveryBehind(run)) {
      const sentAt = Date.parse(run.autoflow.sentAt);
      if (Number.isFinite(sentAt) && now - sentAt < TOPUP_DEBOUNCE_MS) return null;
      return "topup";
    }
    // A sent list whose enrichment chain never FINISHED (it was force-sent while the
    // worker was down mid-run) still deserves its enrichment: queue ONE server-side
    // resume; the top-up rule above then re-sends if the finished chain finds more
    // phones. Without this, a force-sent list stays "enrichment unfinished" forever.
    // Covers the wiped-ledger case too (a Sales Nav merge re-opened the chain for
    // its new rows and the driving tab died): the merge clears resumedAt, so the
    // one-resume rule re-arms for every reopen.
    const sentPartial = chainUnfinished(run);
    if (sentPartial && !run.autoflow.resumedAt && now - touched >= SETTLE_MS) return "resume";
    // A send that reached Candidates but SKIPPED OS Text because the workspace had
    // no engine (ostext_not_connected) heals itself: the moment the workspace gets
    // an engine (own keys saved under Setup, or the owner grants the house one) its
    // phones flow on without anyone re-arming the list. The tick loop acts on this
    // only after ostextConfiguredFor(ws) turns true, so it never spins while
    // unconnected (2026-07-20 incident: Lume lists silently stamped sent-with-error).
    if (run.autoflow.error?.startsWith("ostext_not_connected") && phoneCount(run) > 0) return "ostext-retry";
    // ...and so does ANY other failed OS Text leg. A transient engine outage (the
    // taltxt container restarting through a deploy — 2026-08-07) stamps a generic
    // error, and NOTHING re-armed it: the Candidates leg had already succeeded so
    // promotedCount is caught up, sentSignature never gets stamped because the send
    // threw before reaching it, and phonesAtSend can even sit ABOVE the current
    // deliverable phone count once the quality bar and the radius exclude some
    // phone-holders — which kills the morePhones trigger too. The list was left
    // holding a campaign that never received its contacts, with no lane able to see
    // it. Bounded by MAX_ATTEMPTS, so an engine that is genuinely broken parks with
    // its reason instead of retrying forever.
    if (run.autoflow.error && run.autoflow.attempts < MAX_ATTEMPTS &&
        deliverableRows(run).some((c) => c.phone)) return "ostext-retry";
    return null;
  }
  if ((run.autoflow?.attempts ?? 0) >= MAX_ATTEMPTS) return null;

  // Never sent, no job in flight: FIRST-SIGHT DELIVERY — ship what it has NOW.
  // A chain that stopped PARTWAY with nothing driving it (the worker failed
  // between chunks, or the driving tab died between submit cycles) also queues
  // ONE server-side resume to finish the chain, whose finds then flow on via the
  // top-up rule — but only once the list has sat quiet for IDLE_MS, so a live
  // tab about to fire the next chunk isn't double-driven by the night queue.
  if (chainUnfinished(run) && now - touched >= IDLE_MS) {
    const resumedAt = run.autoflow?.resumedAt ? Date.parse(run.autoflow.resumedAt) : NaN;
    return Number.isFinite(resumedAt) ? "send" : "resume-send";
  }
  return "send";
}

/** Queue an orphaned chain for the overnight processor to finish (once per run). */
async function resumeRun(run: SourcingRun): Promise<void> {
  const stamp = run.autoflow ?? { phonesAtSend: 0, attempts: 0 };
  try {
    // If the queue already holds an unfinished item for this run, just stamp and wait.
    const items = await listNightItems(run.workspaceId);
    const active = items.some((i) => i.runId === run.id && i.stage !== "done" && i.stage !== "error");
    if (!active) {
      await addNightItem(run.workspaceId, { kind: "enrich", name: run.name, runId: run.id });
      console.log(`[sourcing-autoflow] "${run.name}" (${run.id}) chain orphaned mid-job — queued a server-side resume`);
    }
    stamp.resumedAt = nowIso();
    stamp.resumes = (stamp.resumes ?? 0) + 1;
    run.autoflow = stamp;
    await saveSourcingRun(run.workspaceId, { ...run });
  } catch (e) {
    console.error(`[sourcing-autoflow] resume of "${run.name}" failed: ${(e as Error).message}`);
  }
}

/** Mirror of the sourcing route's "ostext" contact mapping — full merge-column set. */
function toOsTextContacts(run: SourcingRun): OsTextContact[] {
  const out: OsTextContact[] = [];
  for (const c of run.candidates) {
    if (!c.phone) continue;
    // The radius is a promise about who gets CONTACTED. A row the list marked as
    // outside it never rides the texting lane, whichever route put it on the list
    // (out-of-area appendix, never-empty rescue, a folded wider duplicate search, a
    // Sales Nav URL). It stays on the saved list to be looked at; it does not get a
    // text (owner mandate 2026-08-06).
    if (c.outOfArea) continue;
    // THE QUALITY BAR, the same promise about who gets contacted, made about fit
    // instead of distance: someone the scorer already judged the wrong role family
    // stays on the list to be looked at but does not get a text. Before this, every
    // row on the list was texted, and a third of them scored under 40 (see
    // lib/sourcing/qualityBar.ts for the measurement that prompted it).
    if (!qualifiedForOutreach(c, deliverMinFit())) continue;
    const parts = (c.fullName || "").trim().split(/\s+/);
    const custom: Record<string, string> = {};
    if (c.headline) custom.headline = c.headline;
    if (typeof c.verifiedScore === "number") custom.tag = `vetted-${c.verdict ?? "scored"}`;
    // Provenance for the phone-accuracy metric: the engine tallies validation,
    // delivery, and wrong-number outcomes per phone source.
    if (c.phoneSource) custom.phone_source = c.phoneSource;
    out.push({
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" "),
      company: c.company || "",
      jobTitle: c.title || c.headline || "",
      phone: c.phone,
      email: c.email || "",
      linkedinUrl: c.linkedinUrl || "",
      location: c.location || "",
      customFields: custom,
    });
  }
  return out;
}

async function sendRun(run: SourcingRun, opts?: { notify?: boolean }): Promise<void> {
  const ws = run.workspaceId;
  const stamp = run.autoflow ?? { phonesAtSend: 0, attempts: 0 };
  stamp.attempts++;
  try {
    // 1) Candidates. promoteSourcingRun stamps promotedListId back on the run, so a
    //    push the browser chain already made is never repeated (and re-promoting on a
    //    top-up only adds the people enrichment newly reached — dedupe by LinkedIn URL).
    // Snapshot WHAT THIS SEND CARRIES before any leg runs. The run object is the
    // shared store entry, so a live enrichment tick can grow it mid-send; stamping
    // the post-send set would mark people as delivered that this push never saw.
    // Snapshotting first leaves them behind by exactly what arrived late, and the
    // next top-up collects them.
    const phonesNow = phoneCount(run);
    const peopleNow = run.candidates.length;
    const signatureNow = deliverySignature(run);
    const topup = Boolean(stamp.sentAt);
    // A stale outcome must not outlive this attempt: without this, a retry that
    // SUCCEEDS still carries the old ostext_not_connected stamp (the clear below
    // deliberately preserves it), leaving the list flagged and re-sent forever.
    stamp.error = undefined;
    if (!run.promotedListId || topup) {
      // Reuse the campaign a prior promote created — promote with no campaignId
      // always creates a new one, and a top-up must never duplicate the campaign.
      // Combined lists retag: everyone the merge holds gets the combined list's
      // name as their tag, even people the source lists promoted earlier.
      const promoted = await promoteSourcingRun(ws, run.id, {
        listName: run.name, tag: "", campaignId: run.promotedCampaignId,
        retag: Boolean(run.combinedFrom?.length),
      });
      // Remember what the quality bar held back so the card can say it plainly. A
      // delivered count smaller than the list must always carry its own explanation.
      stamp.belowBarHeld = promoted.belowBarHeld ?? 0;
      stamp.barUsed = deliverMinFit();
      if (promoted.belowBarHeld) {
        console.log(`[sourcing-autoflow] "${run.name}" (${run.id}) ${qualityBarNote(promoted.belowBarHeld, deliverMinFit())}`);
      }
    }

    // 2) OS Text. Zero phones is not a failure — the campaign is still created
    //    (empty, draft) so every search is VISIBLE in OS Text the moment it
    //    lands, and the top-up rule fills it as enrichment finds phones.
    const contacts = toOsTextContacts(run);
    // Per-workspace: only push if THIS workspace has an OS Text engine (its own
    // or, for house/granted, the shared one).
    const ostextReady = await ostextConfiguredFor(ws);
    if (ostextReady) {
      // The campaign belongs to whoever RAN the search (run.createdBy), never the
      // workspace owner: owner-fallback stamped every auto-pushed campaign (and
      // its "this is <name>" starter text) with the owner's name (user report
      // 2026-07-21). A creator-less legacy run lands Unassigned; the admin ping
      // in notifyNewCandidates covers it and the owner chip reassigns.
      const recruiter = run.createdBy;
      const template = ostextStarterTemplate(recruiter?.name || "", run.name);

      // PREFLIGHT: check the exact payload against the exact template BEFORE it
      // leaves. A blocking verdict means this push would text nobody for a
      // fixable reason, so it is not sent — the run keeps its retry budget and
      // the reason is stamped where a human can read it, instead of the campaign
      // quietly reporting 0 sent an hour later.
      const pre = preflightPush(run, contacts, template);
      run.preflight = pre;
      console.log(summarizePreflight(run, pre));
      if (!pre.ok) {
        stamp.error = `preflight: ${pre.issues.find((i) => i.severity === "block")?.message ?? "blocked"}`;
        run.autoflow = stamp;
        await saveSourcingRun(ws, { ...run });
        console.error(`[sourcing-autoflow] "${run.name}" (${run.id}) push BLOCKED by preflight — ${stamp.error}`);
        return;
      }

      try {
        // The engine get-or-creates its campaign BY EXACT NAME, so a renamed run
        // pushes top-ups under the name its campaign was created with (pinned in
        // ostextName by the rename) — otherwise the rename would fork a second,
        // near-empty campaign and split the same list's texts across two.
        const pushName = run.ostextName || run.name;
        const imported = await ostextImport({
          name: pushName,
          template,
          positionSummary: `Pushed from JD Sourcing list "${run.name}" (${contacts.length} contacts, server auto-send).`,
          recruiterName: recruiter?.name || "",
          recruiterEmail: recruiter?.email || "",
          contacts,
          // SAFEGUARD (user mandate): Telnyx cell-line confirmation on every push.
          validate: true,
          // NO-DOUBLE-CONTACT GUARD: DNC + recent-communication cooldown.
          workspaceId: ws,
          // The searching recruiter's assigned phone line (Numbers page) becomes
          // the campaign's SMS from-number: same number for their calls and texts.
          fromUserId: recruiter?.userId,
        });
        // Keep the engine's answer on the run: "list shows N phones but the
        // campaign holds fewer" is almost always knownNonMobile (Telnyx already
        // judged those numbers not cells), and this stamp makes that checkable.
        // Remember the name the campaign actually lives under, so a later rename
        // keeps topping THAT campaign up (the engine answers with its own name,
        // which is authoritative when it reused an existing campaign).
        run.ostextName = (typeof imported.campaignName === "string" && imported.campaignName) || pushName;
        stamp.lastImport = {
          at: nowIso(),
          added: Number(imported.added) || 0,
          knownNonMobile: Number(imported.knownNonMobile) || 0,
          confirmedCell: Number(imported.confirmedCell) || 0,
        };
        // RECONCILE: every contact we sent must come back accounted for. A gap
        // between "sent" and "added + judged non-mobile" is the exact shape of
        // silent loss, so it is recorded on the run rather than averaged away.
        const gap = reconcilePush(pre, stamp.lastImport);
        if (gap) {
          pre.issues.push(gap);
          run.preflight = pre;
          console.warn(`[sourcing-autoflow] "${run.name}" (${run.id}) ${gap.message}`);
        }
      } catch (e) {
        // Everyone on the list being protected is the guard WORKING, not a failure.
        if ((e as Error & { code?: string }).code !== "all_contacts_protected") throw e;
      }
    } else if (contacts.length && !ostextReady) {
      stamp.error = "ostext_not_connected: sent to Candidates only";
    }

    // 3) Resume-request email (flag-gated: RESUME_REQUEST_AUTO=on). Every
    //    candidate on the list with an email gets ONE ask for their current
    //    resume, sent from the workspace's own brand mailbox. Replies land in
    //    the resume inbox, which files the resume, pairs the JD, and opens the
    //    vetting loop by itself. Per-candidate stamps make top-up re-runs free;
    //    a failure here never fails the send that already happened.
    try {
      const { autoRequestResumesForRun } = await import("../vetting/resumeRequest");
      const rr = await autoRequestResumesForRun(run);
      if (rr.enabled && (rr.sent || rr.skipped)) {
        console.log(`[sourcing-autoflow] "${run.name}" resume requests: ${rr.sent} asked, ${rr.skipped} skipped`);
      }
    } catch (e) {
      console.error(`[sourcing-autoflow] "${run.name}" resume-request leg failed: ${(e as Error).message}`);
    }

    stamp.sentAt = nowIso();
    stamp.phonesAtSend = phonesNow;
    stamp.peopleAtSend = peopleNow;
    stamp.sentSignature = signatureNow;
    if (stamp.error?.startsWith("ostext_not_connected") !== true) stamp.error = undefined;
    stamp.outageSince = undefined; // a send got through: whatever outage there was is over
    // A CLEAN SEND CLEARS THE RECORD. The attempt counter measures one run of bad
    // luck, not a permanent mark: leaving it at 20 after a send that WORKED left
    // the list classified as parked forever (observed on this list 2026-08-07,
    // attempts=20 with a fresh sentAt and no error). Parked is not cosmetic — the
    // fresh lane's error-retry is gated on attempts < MAX_ATTEMPTS, so the next
    // outage could never be retried there, and parityDue()'s staleOrParked test
    // stayed true for good, permanently handing a healthy list to the slow lane.
    stamp.attempts = 0;
    console.log(`[sourcing-autoflow] "${run.name}" (${run.id}) sent on: ${run.candidates.length} to Candidates, ${contacts.length} phone(s) to OS Text${topup ? " (top-up)" : ""}`);
    // Tell the desk that owns this list RIGHT NOW: new candidates just landed and
    // are waiting for their first outreach. Recipient = the recruiter who ran the
    // search (else the promoted campaign's recruiter); with nobody assigned, every
    // admin hears it instead. Best-effort: a notification failure must never fail
    // the send.
    try {
      if (opts?.notify !== false) await notifyNewCandidates(run, contacts.length, topup);
    } catch { /* delivery is best-effort */ }
  } catch (e) {
    stamp.error = (e as Error).message?.slice(0, 300) || "send failed";
    // AN OUTAGE IS NOT AN ATTEMPT. The retry budget exists to stop a run whose
    // OWN push keeps failing; an engine that is down fails every run equally and
    // has nothing to do with this one. Counting it burned all 20 attempts of
    // three healthy lists during a routine ~15-minute taltxt restart and parked
    // them (2026-08-07), so a failure that never reached the engine refunds the
    // attempt it just spent. Bounded by OUTAGE_GRACE_MS measured from the FIRST
    // failure of the outage: a container restart never costs a list its budget,
    // while an engine that has been unreachable for a day resumes burning
    // attempts and parks with its reason, as it should.
    if (isEngineOutage(stamp.error)) {
      stamp.outageSince = stamp.outageSince || nowIso();
      const since = Date.parse(stamp.outageSince);
      if (!Number.isFinite(since) || Date.now() - since < OUTAGE_GRACE_MS) {
        stamp.attempts = Math.max(0, stamp.attempts - 1);
      }
    }
    console.error(`[sourcing-autoflow] "${run.name}" (${run.id}) attempt ${stamp.attempts} failed: ${stamp.error}`);
  }
  run.autoflow = stamp;
  await saveSourcingRun(ws, { ...run });
}

/**
 * "New candidates on your desk" ping, fired the moment a list lands in
 * Candidates/OS Text (first send AND every top-up). Rides the Outbound
 * notification stack (in-app inbox + email + optional SMS, per user prefs).
 * Capped at ONE per list per recipient per day via the notify sent-guard: an
 * enrichment chain that tops up chunk after chunk must read as one event, not
 * a ping per chunk (2026-07-20: six pings in six minutes for one list).
 */
async function notifyNewCandidates(run: SourcingRun, phonesPushed: number, topup: boolean): Promise<void> {
  const ws = run.workspaceId;
  const n = run.candidates.length;
  if (!n) return;
  const { pushNotification } = await import("../outbound/notify");
  const { getCore } = await import("../core/repository");
  const { listMembers } = await import("../auth/team");
  const campaign = run.promotedCampaignId ? await getCore().getCampaign(run.promotedCampaignId) : null;
  const members = listMembers(ws);
  // The recruiter who ran the search hears first; a campaign-level assignment is
  // the fallback for legacy runs. Neither -> every admin hears it.
  const owner = (run.createdBy && members.find((m) => m.userId === run.createdBy!.userId))
    || (campaign?.recruiterId ? members.find((m) => m.userId === campaign.recruiterId) : undefined);
  const recipients = owner ? [owner] : members.filter((m) => m.role === "owner" || m.role === "admin");
  if (!recipients.length) return;
  const title = topup
    ? `More candidates just landed on "${run.name}"`
    : `New candidate list ready: "${run.name}"`;
  const body = [
    `${n} candidate${n === 1 ? "" : "s"} are in Candidates under "${run.name}"` +
      (phonesPushed ? `, ${phonesPushed} with a texting-ready phone in its OS Text campaign.` : "."),
    owner ? "" : "This list's campaign has no recruiter assigned yet, so you are receiving this as an admin.",
    "They are waiting for their first outreach: open Candidates, filter to Uncontacted, and work the list.",
  ].filter(Boolean).join("\n");
  const { alreadySent, markSent } = await import("../outbound/notify");
  const day = new Date().toISOString().slice(0, 10);
  const guardKind = `new_candidates_${run.id}`;
  for (const r of recipients) {
    try {
      if (await alreadySent(ws, r.userId, day, guardKind)) continue;
      await pushNotification(ws, { userId: r.userId, category: "campaign", severity: "opportunity", title, body });
      await markSent(ws, r.userId, day, guardKind);
    } catch { /* one recipient's delivery */ }
  }
}

/**
 * Push one run to Candidates + OS Text right now, in-request. Used by the merge
 * handler so a combined list lands everywhere within seconds of combining; the
 * sweeper's sendAsap branch backstops it if this process dies mid-send. Safe to
 * race the sweeper: promote dedupes by LinkedIn URL and stamps promotedListId,
 * and the OS Text engine dedupes contacts by (campaign, phone).
 */
export async function sendRunNow(run: SourcingRun): Promise<void> {
  await sendRun(run);
}

/* --- Parity backfill lane ---------------------------------------------------
 * THE PARITY GUARANTEE (user mandate 2026-07-20): EVERYTHING in JD Sourcing ends
 * up in Candidates + OS Text — including what the fresh-window sweeper above will
 * never touch: lists idle past FRESH_MS (pre-autoflow-era lists, or ones whose
 * sends kept failing until they aged out) and runs parked by MAX_ATTEMPTS.
 *
 * Safe on old lists by construction: the engine's /api/import creates campaigns
 * as DRAFT (nothing texts until a recruiter activates), Telnyx cell validation +
 * the DNC/recent-contact guard still screen every contact, promote dedupes by
 * LinkedIn URL, and the engine dedupes by (campaign, phone). Backfill sends are
 * quiet (no "new candidates" ping) — these aren't fresh arrivals.
 */
const PARITY_EVERY_MS = 6 * 3600_000;   // one parity pass per process every 6h
const PARITY_RETRY_MS = 20 * 3600_000;  // at most one attempt per run per ~day
const PARITY_SENDS_PER_PASS = 5;        // backlog drains over passes, not in one

/** Is this run out of parity in a way the fresh-window lane won't fix?
 *  (exported for the regression suite) */
export function parityDue(run: SourcingRun, now: number): boolean {
  if (!run.candidates.length) return false;
  if (run.motion === "bd") return false; // BD lists ride the email belt, not OS Text
  const touched = Date.parse(run.updatedAt);
  const staleOrParked =
    !Number.isFinite(touched) || now - touched > FRESH_MS ||
    (run.autoflow?.attempts ?? 0) >= MAX_ATTEMPTS;
  if (!staleOrParked) return false; // the fresh-window lane owns this run
  const parityAt = run.autoflow?.parityAt ? Date.parse(run.autoflow.parityAt) : NaN;
  // The once-per-day stamp rate-limits REAL attempts. A parity send that died
  // because the engine was unreachable was never an attempt at all — it could
  // not have worked for any run — so it must not spend the whole day's rescue.
  // Without this, a rescue pass that happened to land inside a 15-minute taltxt
  // restart stamped parityAt, failed, and locked the ONLY lane that re-opens a
  // parked run out for 20 hours, leaving the list stranded long after the engine
  // was healthy again (2026-08-07: three lists parked at 20/20 while the card
  // said "retrying" and the log said "all runs in parity"). What that costs is
  // not the contacts an earlier push already delivered — it is every top-up from
  // then on: a parked run is unreachable by both lanes, so newly-enriched phones
  // never reach the campaign again. The lane stays bounded by PARITY_EVERY_MS.
  const lockedOut = Number.isFinite(parityAt) && now - parityAt < PARITY_RETRY_MS;
  if (lockedOut && !isEngineOutage(run.autoflow?.error)) return false;
  if (!run.autoflow?.sentAt) return true;                       // never sent at all
  if (phoneCount(run) > run.autoflow.phonesAtSend) return true; // phones OS Text never got
  // People a later merge added who never reached Candidates (no phone required).
  if (run.candidates.length > (run.autoflow.peopleAtSend ?? run.candidates.length)) return true;
  // ...and the counter-blind cases: Candidates short of the list, or a set that
  // changed membership without changing the totals.
  if (deliveryBehind(run)) return true;
  if (run.autoflow.error?.startsWith("ostext_not_connected") && phoneCount(run) > 0) return true;
  // A push that failed for ANY reason, on a run that still has someone textable,
  // is out of parity too. Parking at MAX_ATTEMPTS is precisely how such a run
  // arrives in this lane, and this lane is the one that re-opens the attempt
  // budget — without this, the fresh lane's bounded retries were the only ones
  // that ever ran, so an engine outage that outlasted 20 attempts stranded the
  // list for good (2026-08-07: a parked list read "all runs in parity" while its
  // campaign held none of its contacts).
  return Boolean(run.autoflow.error) && deliverableRows(run).some((c) => c.phone);
}

let lastParity = 0;

/** Drain a slice of the parity backlog. Caller holds the sweep mutex. */
async function parityPass(runs: SourcingRun[], now: number): Promise<number> {
  let sent = 0;
  const due = runs.filter((r) => parityDue(r, now))
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  // Heartbeat even when clean: "parity ran and found nothing" must be
  // distinguishable from "parity never ran" in the ops log.
  if (!due.length) {
    console.log(`[sourcing-autoflow] parity: all ${runs.length} saved run(s) in parity`);
    return 0;
  }
  console.log(`[sourcing-autoflow] parity: ${due.length} run(s) out of parity, sending up to ${PARITY_SENDS_PER_PASS}`);
  for (const run of due) {
    if (sent >= PARITY_SENDS_PER_PASS) break;
    // Skip (do not burn the per-day stamp) while the workspace has no engine:
    // the send would only re-stamp ostext_not_connected. Promote-only parity is
    // pointless here — an unsent run in this state already failed on promote too.
    if (!(await ostextConfiguredFor(run.workspaceId))) continue;
    const stamp = run.autoflow ?? { phonesAtSend: 0, attempts: 0 };
    stamp.parityAt = nowIso();
    // Parity retries must not stay parked behind old failures forever, but one
    // pass per day keeps a hard-failing run from looping: re-open the attempt
    // budget just enough for this one send.
    if (stamp.attempts >= MAX_ATTEMPTS) stamp.attempts = MAX_ATTEMPTS - 1;
    run.autoflow = stamp;
    await sendRun(run, { notify: false });
    sent++;
  }
  return sent;
}

/* --- Same-role auto-combine lane ---------------------------------------------
 * USER MANDATE (2026-07-21): searches for the SAME open role must converge into
 * ONE list — never ship as parallel lists that fan out into duplicate Candidates
 * lists and duplicate OS Text campaigns ("VP of Operations - Howell, New Jersey,
 * United States" next to its "+50mi" and "(combined)" variants was three lists,
 * three campaigns, and the same people queued for the same text twice).
 *
 * Every sweep, saved recruiting runs whose names collapse to the same role+place
 * key (lib/sourcing/sameRole) are folded IN-PLACE into the group's master — the
 * run whose Candidates list / OS Text campaign already exists keeps its id and
 * name, so every later push TOPS UP that one campaign (the engine keys campaigns
 * by exact name) instead of creating a sibling. Donor runs are deleted once the
 * master holds their people; the merge itself is the regression-tested
 * mergeSourcingRuns (dedupe by person, stronger row wins, blanks filled both
 * ways), so nothing a donor found is lost.
 *
 * Safety: a group is skipped while ANY of its runs has an enrichment/vet job in
 * flight, is being worked by the overnight queue, or was touched in the last few
 * minutes (a live tab saves on every chain step). Merging wipes the chunk ledger
 * — same move the Sales Nav merge makes — so ONE server-side resume re-enriches
 * only what the union still misses, and the top-up rule delivers donor phones to
 * the master's campaign on the next tick.
 */
const MAX_COMBINES_PER_TICK = 2; // folds are cheap but each triggers a resend cycle

/** Fold every safe same-role duplicate group; returns the deleted donor ids so
 *  the caller's tick loop never acts on a run that no longer exists. */
async function autoCombinePass(runs: SourcingRun[], now: number): Promise<Set<string>> {
  const dropped = new Set<string>();
  // Which runs is the overnight queue actively working? (per workspace, fetched once)
  const busy = new Set<string>();
  try {
    const workspaces = new Set(runs.map((r) => r.workspaceId));
    for (const ws of workspaces) {
      for (const item of await listNightItems(ws)) {
        if (item.runId && item.stage !== "done" && item.stage !== "error") busy.add(item.runId);
      }
    }
  } catch (e) {
    // Can't see the queue -> can't prove a run is quiet -> fold nothing this tick.
    console.error(`[sourcing-autoflow] combine: queue check failed, skipping pass: ${(e as Error).message}`);
    return dropped;
  }
  let folds = 0;
  for (const g of combinableGroups(runs, now, busy)) {
    if (folds >= MAX_COMBINES_PER_TICK) break;
    try {
      const master = g.master;
      const { candidates, overlap } = mergeSourcingRuns([master, ...g.donors]);
      master.candidates = candidates;
      // THE MASTER'S MILEAGE WINS. The same-role key deliberately ignores radius tokens,
      // so "VP Ops - Howell NJ" and its "+100mi" twin are one role and DO fold together
      // — but folding them used to hand the master every one of the wider search's
      // people, which is precisely how a +25mi list ended up full of candidates two
      // hours away. Re-measure the whole union against the master's own location and
      // radius: donor rows outside it are marked out-of-area, so they stay visible in
      // the list and stay out of the delivery lane (owner mandate 2026-08-06).
      const geo = enforceRunGeo(master);
      if (geo.enforced && geo.marked) {
        console.log(`[sourcing-autoflow] combine: ${geo.marked} merged row(s) fell outside the master's ${geo.radiusMi}mi radius and were marked out-of-area`);
      }
      master.queries = master.queries.concat(g.donors.flatMap((d) => d.queries));
      master.combinedFrom = [...new Set([...(master.combinedFrom ?? []), ...g.donors.map((d) => d.id)])];
      // The union may hold rows the master's enrichment never saw: wipe the chunk
      // ledger so one server-side resume enriches exactly the gaps (blank-fill
      // only, no double spend), and re-arm the one-resume rule for this reopen.
      master.laxisProgress = undefined;
      master.laxisSkipped = undefined;
      if (master.autoflow) master.autoflow.resumedAt = undefined;
      // A donor that was promoted when the master wasn't donates its Candidates
      // campaign/list so the promote leg reuses instead of re-creating. (When the
      // master was already sent, its own ids win — that campaign has the history.)
      if (!master.promotedCampaignId) {
        const promoted = g.donors.find((d) => d.promotedCampaignId);
        if (promoted) {
          master.promotedCampaignId = promoted.promotedCampaignId;
          master.promotedListId = master.promotedListId || promoted.promotedListId;
        }
      }
      await saveSourcingRun(master.workspaceId, { ...master });
      for (const d of g.donors) {
        if (await deleteSourcingRun(d.workspaceId, d.id)) dropped.add(d.id);
      }
      folds++;
      console.log(
        `[sourcing-autoflow] auto-combined ${g.donors.length + 1} same-role lists into "${master.name}" ` +
        `(${candidates.length} people, ${overlap} duplicate row(s) folded, donors: ${g.donors.map((d) => `"${d.name}"`).join(", ")})`);
    } catch (e) {
      console.error(`[sourcing-autoflow] combine of "${g.master.name}" group failed: ${(e as Error).message}`);
    }
  }
  return dropped;
}

let sweeping = false;
let lastBeat = 0;

/** One sweep over every saved run. Cheap when nothing is due; a mutex makes
 *  overlapping timer hits harmless. */
export async function tickSourcingAutoflow(): Promise<{ sent: number }> {
  if (sweeping) return { sent: 0 };
  sweeping = true;
  let sent = 0;
  try {
    const now = Date.now();
    const allRuns = await listAllSourcingRuns();
    if (now - lastBeat > 3600_000) {
      lastBeat = now;
      console.log(`[sourcing-autoflow] sweeping ${allRuns.length} saved run(s) (hourly heartbeat)`);
    }
    // SELF-HEALING LIST DEDUPE (user mandate: "no duplicates ever"): fold any
    // same-name Candidates lists that slipped in from any source — members are
    // unioned into the newest referenced copy, so nothing saved is ever lost,
    // and a run's promotedListId is never deleted out from under it. Runs every
    // tick; a clean store costs one in-memory group-by.
    try {
      const referenced = new Set<string>();
      for (const r of allRuns) if (r.promotedListId) referenced.add(r.promotedListId);
      const folded = await dedupeProspectLists(referenced);
      if (folded) console.log(`[sourcing-autoflow] folded ${folded} duplicate Candidates list(s) into their originals`);
    } catch (e) {
      console.error(`[sourcing-autoflow] list dedupe failed: ${(e as Error).message}`);
    }
    // Fold same-role duplicate lists FIRST, so the send loop below only ever acts
    // on the surviving master — a donor sent seconds before its fold would have
    // opened exactly the duplicate campaign this lane exists to prevent.
    const foldedAway = await autoCombinePass(allRuns, now);
    const runs = foldedAway.size ? allRuns.filter((r) => !foldedAway.has(r.id)) : allRuns;
    for (const run of runs) {
      if (sent >= MAX_SENDS_PER_TICK) break;
      const what = due(run, now);
      if (!what) continue;
      if (what === "resume") { await resumeRun(run); continue; }
      // Parity first: queue the chain-finishing resume AND deliver what the
      // list already holds in the same tick (top-up re-sends the rest later).
      if (what === "resume-send") await resumeRun(run);
      if (what === "ostext-retry" && !(await ostextConfiguredFor(run.workspaceId))) continue;
      await sendRun(run);
      sent++;
    }
    if (now - lastParity >= PARITY_EVERY_MS) {
      lastParity = now;
      sent += await parityPass(runs, now);
    }
  } catch (e) {
    console.error(`[sourcing-autoflow] sweep failed: ${(e as Error).message}`);
  } finally {
    sweeping = false;
  }
  return { sent };
}

// No self-arming timer on purpose: arming from instrumentation.ts gave this module
// a SEPARATE bundle instance whose hydrated store copy went stale (and whose saves
// could clobber the live one). GET /api/sourcing/night fire-and-forgets the tick on
// every hit of the ros nightqueue timer (every 2 min), inside the request graph.
