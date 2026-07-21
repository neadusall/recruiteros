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
import type { SourcingRun } from "./types";
import { listAllSourcingRuns, saveSourcingRun, deleteSourcingRun } from "./store";
import { promoteSourcingRun } from "./promote";
import { listNightItems, addNightItem } from "./nightQueue";
import { mergeSourcingRuns } from "./mergeRuns";
import { combinableGroups } from "./sameRole";
import { workspaceOwner } from "../auth";
import {
  ostextImport, ostextStarterTemplate, ostextConfiguredFor, type OsTextContact,
} from "../ostextImport";
import { dedupeProspectLists } from "../prospect-lists";

const SETTLE_MS = 5 * 60_000;      // chain-finished lists rest this long first (live tab pushes within seconds)
const IDLE_MS = 45 * 60_000;       // a stalled / never-started chain still flows on after this
const STUCK_MS = 60 * 60_000;      // a job ref idle this long = orphaned chain (tab died mid-job) -> resume it
const FRESH_MS = 7 * 24 * 3600_000; // only lists touched in the last 7 days are eligible
const MAX_ATTEMPTS = 20;           // ~1 hour of retries on a hard failure, then park with the error
const TOPUP_DEBOUNCE_MS = 10 * 60_000; // let a live Boost/gap-fill run accumulate finds between top-ups
const MAX_SENDS_PER_TICK = 3;      // bound one tick's work; the rest go next tick

function phoneCount(run: SourcingRun): number {
  return run.candidates.reduce((n, c) => n + (c.phone ? 1 : 0), 0);
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
    const resumedAt = run.autoflow?.resumedAt ? Date.parse(run.autoflow.resumedAt) : NaN;
    if (run.autoflow?.sentAt) return Number.isFinite(resumedAt) ? null : "resume";
    if ((run.autoflow?.attempts ?? 0) >= MAX_ATTEMPTS) return null;
    return Number.isFinite(resumedAt) ? "send" : "resume-send";
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
    if (morePhones || morePeople) {
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
    const phonesNow = phoneCount(run);
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
      await promoteSourcingRun(ws, run.id, {
        listName: run.name, tag: "", campaignId: run.promotedCampaignId,
        retag: Boolean(run.combinedFrom?.length),
      });
    }

    // 2) OS Text. Zero phones is not a failure — the campaign is still created
    //    (empty, draft) so every search is VISIBLE in OS Text the moment it
    //    lands, and the top-up rule fills it as enrichment finds phones.
    const contacts = toOsTextContacts(run);
    // Per-workspace: only push if THIS workspace has an OS Text engine (its own
    // or, for house/granted, the shared one).
    const ostextReady = await ostextConfiguredFor(ws);
    if (ostextReady) {
      const owner = await workspaceOwner(ws);
      try {
        const imported = await ostextImport({
          name: run.name,
          template: ostextStarterTemplate(owner?.name || "", run.name),
          positionSummary: `Pushed from JD Sourcing list "${run.name}" (${contacts.length} contacts, server auto-send).`,
          recruiterName: owner?.name || "",
          recruiterEmail: owner?.email || "",
          contacts,
          // SAFEGUARD (user mandate): Telnyx cell-line confirmation on every push.
          validate: true,
          // NO-DOUBLE-CONTACT GUARD: DNC + recent-communication cooldown.
          workspaceId: ws,
          // The owner's assigned phone line (Numbers page) becomes the
          // campaign's SMS from-number: same number for their calls and texts.
          fromUserId: owner?.userId,
        });
        // Keep the engine's answer on the run: "list shows N phones but the
        // campaign holds fewer" is almost always knownNonMobile (Telnyx already
        // judged those numbers not cells), and this stamp makes that checkable.
        stamp.lastImport = {
          at: nowIso(),
          added: Number(imported.added) || 0,
          knownNonMobile: Number(imported.knownNonMobile) || 0,
          confirmedCell: Number(imported.confirmedCell) || 0,
        };
      } catch (e) {
        // Everyone on the list being protected is the guard WORKING, not a failure.
        if ((e as Error & { code?: string }).code !== "all_contacts_protected") throw e;
      }
    } else if (contacts.length && !ostextReady) {
      stamp.error = "ostext_not_connected: sent to Candidates only";
    }

    stamp.sentAt = nowIso();
    stamp.phonesAtSend = phonesNow;
    stamp.peopleAtSend = run.candidates.length;
    if (stamp.error?.startsWith("ostext_not_connected") !== true) stamp.error = undefined;
    console.log(`[sourcing-autoflow] "${run.name}" (${run.id}) sent on: ${run.candidates.length} to Candidates, ${contacts.length} phone(s) to OS Text${topup ? " (top-up)" : ""}`);
    // Tell the desk that owns this list RIGHT NOW: new candidates just landed and
    // are waiting for their first outreach. Recipient = the promoted campaign's
    // recruiter; with nobody assigned, every admin hears it instead. Best-effort:
    // a notification failure must never fail the send.
    try {
      if (opts?.notify !== false) await notifyNewCandidates(run, contacts.length, topup);
    } catch { /* delivery is best-effort */ }
  } catch (e) {
    stamp.error = (e as Error).message?.slice(0, 300) || "send failed";
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
  const owner = campaign?.recruiterId ? members.find((m) => m.userId === campaign.recruiterId) : undefined;
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
  if (Number.isFinite(parityAt) && now - parityAt < PARITY_RETRY_MS) return false;
  if (!run.autoflow?.sentAt) return true;                       // never sent at all
  if (phoneCount(run) > run.autoflow.phonesAtSend) return true; // phones OS Text never got
  // People a later merge added who never reached Candidates (no phone required).
  if (run.candidates.length > (run.autoflow.peopleAtSend ?? run.candidates.length)) return true;
  return Boolean(run.autoflow.error?.startsWith("ostext_not_connected") && phoneCount(run) > 0);
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
