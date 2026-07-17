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
import { listAllSourcingRuns, saveSourcingRun } from "./store";
import { promoteSourcingRun } from "./promote";
import { listNightItems, addNightItem } from "./nightQueue";
import { workspaceOwner } from "../auth";
import {
  ostextImport, ostextStarterTemplate, ostextPushConfigured, type OsTextContact,
} from "../ostextImport";

const SETTLE_MS = 5 * 60_000;      // chain-finished lists rest this long first (live tab pushes within seconds)
const IDLE_MS = 45 * 60_000;       // a stalled / never-started chain still flows on after this
const STUCK_MS = 60 * 60_000;      // a job ref idle this long = orphaned chain (tab died mid-job) -> resume it
const RESUME_GRACE_MS = 2 * 3600_000; // a resumed chain gets this long to land before we force-send as-is
const FRESH_MS = 7 * 24 * 3600_000; // only lists touched in the last 7 days are eligible
const MAX_ATTEMPTS = 20;           // ~1 hour of retries on a hard failure, then park with the error
const MAX_SENDS_PER_TICK = 3;      // bound one tick's work; the rest go next tick

function phoneCount(run: SourcingRun): number {
  return run.candidates.reduce((n, c) => n + (c.phone ? 1 : 0), 0);
}

function enrichmentInFlight(run: SourcingRun): boolean {
  return Boolean(run.koldJob || run.koldDbJob || run.laxisJob);
}

/** Should the sweeper act on this run right now? */
function due(run: SourcingRun, now: number): "send" | "topup" | "resume" | null {
  if (!run.candidates.length) return null;
  if (run.motion === "bd") return null; // undefined motion (pre-field runs) counts as recruiting
  const touched = Date.parse(run.updatedAt);
  if (!Number.isFinite(touched) || now - touched > FRESH_MS) return null;

  if (enrichmentInFlight(run)) {
    // A LIVE chain updates the run on every submit/merge; a job ref that has sat
    // untouched for STUCK_MS is an orphan (the driving tab died mid-job). Hand it
    // to the overnight queue's resume machinery once — it polls, merges, clears
    // the refs and finishes the chain server-side. If even that hasn't landed the
    // chain after RESUME_GRACE_MS, the list flows on with what it already has.
    if (now - touched < STUCK_MS) return null;
    if (run.autoflow?.sentAt) return null; // already sent; a landed resume re-triggers via top-up
    const resumedAt = run.autoflow?.resumedAt ? Date.parse(run.autoflow.resumedAt) : NaN;
    if (!Number.isFinite(resumedAt)) return "resume";
    return now - resumedAt >= RESUME_GRACE_MS ? "send" : null;
  }

  if (run.autoflow?.sentAt) {
    // Already sent: only a later enrichment that found MORE phones re-sends (top-up).
    return phoneCount(run) > run.autoflow.phonesAtSend ? "topup" : null;
  }
  if ((run.autoflow?.attempts ?? 0) >= MAX_ATTEMPTS) return null;

  // Born-finished runs (a "Combine lists" merge of already-enriched lists) skip the
  // settle/idle waits: the merge handler fires a send in-request, and this branch is
  // the sweeper backstop in case that process died before the send landed.
  if (run.sendAsap) return "send";

  const chainDone = run.laxisProgress?.nextStart === null;
  if (chainDone && now - touched >= SETTLE_MS) return "send";
  if (now - touched >= IDLE_MS) return "send"; // stalled or never-started: flow on with what it has
  return null;
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

async function sendRun(run: SourcingRun): Promise<void> {
  const ws = run.workspaceId;
  const stamp = run.autoflow ?? { phonesAtSend: 0, attempts: 0 };
  stamp.attempts++;
  try {
    // 1) Candidates. promoteSourcingRun stamps promotedListId back on the run, so a
    //    push the browser chain already made is never repeated (and re-promoting on a
    //    top-up only adds the people enrichment newly reached — dedupe by LinkedIn URL).
    const phonesNow = phoneCount(run);
    const topup = Boolean(stamp.sentAt);
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

    // 2) OS Text. Zero phones is not a failure: the list is stamped sent with
    //    phonesAtSend 0, so the moment a later enrichment finds phones the top-up
    //    rule fires and the campaign gets built then.
    const contacts = toOsTextContacts(run);
    if (contacts.length && ostextPushConfigured()) {
      const owner = await workspaceOwner(ws);
      try {
        await ostextImport({
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
      } catch (e) {
        // Everyone on the list being protected is the guard WORKING, not a failure.
        if ((e as Error & { code?: string }).code !== "all_contacts_protected") throw e;
      }
    } else if (contacts.length && !ostextPushConfigured()) {
      stamp.error = "ostext_not_connected: sent to Candidates only";
    }

    stamp.sentAt = nowIso();
    stamp.phonesAtSend = phonesNow;
    if (stamp.error?.startsWith("ostext_not_connected") !== true) stamp.error = undefined;
    console.log(`[sourcing-autoflow] "${run.name}" (${run.id}) sent on: ${run.candidates.length} to Candidates, ${contacts.length} phone(s) to OS Text${topup ? " (top-up)" : ""}`);
  } catch (e) {
    stamp.error = (e as Error).message?.slice(0, 300) || "send failed";
    console.error(`[sourcing-autoflow] "${run.name}" (${run.id}) attempt ${stamp.attempts} failed: ${stamp.error}`);
  }
  run.autoflow = stamp;
  await saveSourcingRun(ws, { ...run });
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
    const runs = await listAllSourcingRuns();
    if (now - lastBeat > 3600_000) {
      lastBeat = now;
      console.log(`[sourcing-autoflow] sweeping ${runs.length} saved run(s) (hourly heartbeat)`);
    }
    for (const run of runs) {
      if (sent >= MAX_SENDS_PER_TICK) break;
      const what = due(run, now);
      if (!what) continue;
      if (what === "resume") { await resumeRun(run); continue; }
      await sendRun(run);
      sent++;
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
