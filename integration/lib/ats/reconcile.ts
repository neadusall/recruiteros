/**
 * RecruitersOS · Daily Loxo reconciliation (the crossover audit)
 *
 * The 15-minute sync keeps things fresh; THIS pass, once a day per workspace,
 * proves the two systems actually agree so no one gets double-contacted from
 * either side:
 *
 *   1. DEEP RESCAN (Loxo -> here): re-reads the last RECONCILE_LOOKBACK_DAYS of
 *      Loxo activity ignoring the incremental cursor, so backdated entries (a
 *      recruiter logging yesterday's call today) still land on lastContactedAt.
 *   2. TOUCH RE-MIRROR (here -> Loxo): finds our recent sends whose Loxo
 *      write-back failed (no atsEventId on the ActivityEvent) and re-posts
 *      them as person_events. A durable ledger dedupes, so a touch is mirrored
 *      at most once no matter how many times the audit runs.
 *   3. DNC MIRROR (here -> Loxo): opt-outs recorded here (STOP replies, manual
 *      suppressions) are logged into Loxo as a person_event, so recruiters
 *      working inside Loxo see the stop too. Same ledger, same idempotency.
 *
 * The last report is persisted per workspace and surfaced in the ATS settings
 * UI, so "is the crossover check running?" is answerable at a glance.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { getCore } from "../core/repository";
import { getVendorConfig, type AtsVendorConfig } from "./credentials";
import { LoxoClient } from "./loxoClient";
import { syncLoxoActivity, logTouchToAts } from "./activity";

const KEY = "loxo_reconcile_v1";

/** How far back the deep rescan + audits look. */
const RECONCILE_LOOKBACK_DAYS = envInt("LOXO_RECONCILE_LOOKBACK_DAYS", 35);
/** Only sends within this window are re-mirror candidates (older gaps are stale). */
const RESEND_WINDOW_DAYS = envInt("LOXO_RECONCILE_RESEND_DAYS", 7);
/** Cadence: a workspace reconciles when its last run is older than this. */
export const RECONCILE_EVERY_MS = envInt("LOXO_RECONCILE_EVERY_HOURS", 24) * 3600_000;
/**
 * Deep-scan page budget. Bigger than the 15-min tick's cap on purpose: the
 * audit must be able to exhaust the whole lookback window (a busy agency can
 * log >10k activities in 35 days), and once a day we can afford the requests.
 */
const RECONCILE_MAX_PAGES = envInt("LOXO_RECONCILE_MAX_PAGES", 400);

export interface ReconcileReport {
  at: string;
  ok: boolean;
  /** Deep rescan results (Loxo -> warehouse). */
  deepScanned: number;
  deepTouches: number;
  peopleUpdated: number;
  /** Our sends re-posted into Loxo after a failed first mirror. */
  touchesResent: number;
  /** Opt-outs newly logged into Loxo. */
  dncMirrored: number;
  /** Opt-outs we could not key to a Loxo person yet (retried tomorrow). */
  dncPending: number;
  errors: string[];
}

interface WorkspaceLedger {
  lastRunAt?: string;
  lastReport?: ReconcileReport;
  /** ActivityEvent ids already re-mirrored into Loxo (dedupe across runs). */
  mirroredEventIds: string[];
  /** Suppression-entry keys already logged into Loxo. */
  mirroredDncKeys: string[];
}

let store: Record<string, WorkspaceLedger> = {};
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => store);

async function ledger(workspaceId: string): Promise<WorkspaceLedger> {
  if (!hydrating) {
    hydrating = loadSnapshot<Record<string, WorkspaceLedger>>(KEY)
      .then((snap) => { if (snap && typeof snap === "object") store = snap; })
      .catch(() => { /* memory-only until the store is reachable */ });
  }
  await hydrating;
  if (!store[workspaceId]) store[workspaceId] = { mirroredEventIds: [], mirroredDncKeys: [] };
  const l = store[workspaceId];
  if (!Array.isArray(l.mirroredEventIds)) l.mirroredEventIds = [];
  if (!Array.isArray(l.mirroredDncKeys)) l.mirroredDncKeys = [];
  return l;
}

/** When did this workspace last complete the daily audit? (null = never) */
export async function lastReconcile(workspaceId: string): Promise<{ at: string | null; report: ReconcileReport | null }> {
  const l = await ledger(workspaceId);
  return { at: l.lastRunAt ?? null, report: l.lastReport ?? null };
}

/** Is this workspace due for its daily audit? */
export async function reconcileDue(workspaceId: string): Promise<boolean> {
  const l = await ledger(workspaceId);
  if (!l.lastRunAt) return true;
  return Date.now() - Date.parse(l.lastRunAt) >= RECONCILE_EVERY_MS;
}

/**
 * Run the full crossover audit for one workspace. Idempotent and safe to run
 * more often than daily; each side's work is deduped by the durable ledger.
 */
export async function dailyLoxoReconcile(workspaceId: string): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    at: new Date().toISOString(),
    ok: true,
    deepScanned: 0,
    deepTouches: 0,
    peopleUpdated: 0,
    touchesResent: 0,
    dncMirrored: 0,
    dncPending: 0,
    errors: [],
  };
  const cfg = await getVendorConfig(workspaceId, "loxo");
  if (!cfg || !cfg.domain || !cfg.slug || !cfg.apiKey) {
    report.ok = false;
    report.errors.push("missing_credentials");
    return report;
  }
  const client = new LoxoClient({ domain: cfg.domain, slug: cfg.slug, apiKey: cfg.apiKey });
  const l = await ledger(workspaceId);
  const lookbackIso = new Date(Date.now() - RECONCILE_LOOKBACK_DAYS * 24 * 3600_000).toISOString();

  // 1) Deep rescan: Loxo -> warehouse, cursor ignored, catches backdated activity.
  const scan = await syncLoxoActivity(workspaceId, client, cfg, { sinceOverride: lookbackIso, maxPages: RECONCILE_MAX_PAGES });
  report.deepScanned = scan.scanned;
  report.deepTouches = scan.touches;
  report.peopleUpdated = scan.peopleUpdated;
  if (!scan.ok && scan.error) { report.ok = false; report.errors.push(`deep_scan: ${scan.error}`); }

  // 2) Touch re-mirror: our sends that never landed in Loxo.
  try {
    const resendSince = Date.now() - RESEND_WINDOW_DAYS * 24 * 3600_000;
    const events = await getCore().listAllActivity(workspaceId);
    const mirrored = new Set(l.mirroredEventIds);
    for (const ev of events) {
      if (!/_sent$/.test(ev.type)) continue;
      if (ev.atsEventId && !/^loxo_event_/.test(ev.atsEventId)) continue; // real Loxo id already
      if (mirrored.has(ev.id)) continue;
      const ts = Date.parse(ev.at);
      if (!Number.isFinite(ts) || ts < resendSince) continue;
      // Dry-run/simulated sends never mirror (summary carries the marker).
      if (/dry-run/i.test(ev.summary || "")) { mirrored.add(ev.id); continue; }
      const p = await getCore().getProspect(ev.prospectId).catch(() => null);
      if (!p) { mirrored.add(ev.id); continue; }
      const eventId = await logTouchToAts(workspaceId, {
        personRef: p.atsPersonId,
        email: p.email,
        phone: p.phone,
        linkedinUrl: p.linkedinUrl,
        fullName: p.fullName,
        company: p.company,
        channel: ev.channel,
        note: ev.summary || `${ev.channel} sent`,
        at: ev.at,
      });
      if (eventId) { report.touchesResent++; mirrored.add(ev.id); }
      // No id: person isn't keyed to Loxo yet; retry on tomorrow's audit.
    }
    l.mirroredEventIds = [...mirrored].slice(-5000);
  } catch (e: any) {
    report.ok = false;
    report.errors.push(`touch_mirror: ${e?.message ?? "failed"}`);
  }

  // 3) DNC mirror: opt-outs recorded here -> a person_event in Loxo.
  try {
    const { listSuppression } = await import("../response/suppression");
    const { findRecordForPerson } = await import("../data");
    const entries = await listSuppression(workspaceId);
    const done = new Set(l.mirroredDncKeys);
    // The agency's "Note" activity type (ids are per-agency; resolve by name).
    let noteTypeId: string | undefined;
    if (entries.some((e) => !done.has(`${e.at}|${e.handles.join(",")}`))) {
      const types = await client.listActivityTypes();
      const note = types.find((t) => /note/i.test(String(t?.name || ""))) || types[0];
      noteTypeId = note?.id != null ? String(note.id) : undefined;
    }
    for (const entry of entries) {
      const key = `${entry.at}|${entry.handles.join(",")}`;
      if (done.has(key)) continue;
      if (Date.now() - Date.parse(entry.at) > RECONCILE_LOOKBACK_DAYS * 24 * 3600_000 * 3) {
        done.add(key); // too old to chase; the suppression list itself still blocks sends
        continue;
      }
      // Loxo-sourced DNC came FROM Loxo; nothing to mirror back.
      if (/^loxo_/.test(entry.reason || "")) { done.add(key); continue; }
      const email = entry.handles.find((h) => h.includes("@"));
      const phone = entry.handles.find((h) => /^\+?\d{6,}$/.test(h));
      const linkedin = entry.handles.find((h) => !h.includes("@") && !/^\+?\d{6,}$/.test(h));
      const rec = await findRecordForPerson(workspaceId, { email, phone, linkedinUrl: linkedin });
      if (!rec || !rec.providerId || rec.source !== "loxo") { report.dncPending++; continue; }
      const res = await client.createPersonEvent({
        personId: rec.providerId,
        activityTypeId: noteTypeId,
        notes: `[RecruitersOS] Do not contact: ${entry.reason || "opt-out"} (${entry.at.slice(0, 10)}). Outreach from RecruitersOS is blocked on every channel.`,
        createdAt: entry.at,
      });
      if (res.ok) { report.dncMirrored++; done.add(key); }
      else report.dncPending++;
    }
    l.mirroredDncKeys = [...done].slice(-5000);
  } catch (e: any) {
    report.ok = false;
    report.errors.push(`dnc_mirror: ${e?.message ?? "failed"}`);
  }

  l.lastRunAt = report.at;
  l.lastReport = report;
  save();
  console.info(
    `[loxo:reconcile] ws=${workspaceId} ok=${report.ok} deepScanned=${report.deepScanned} peopleUpdated=${report.peopleUpdated} resent=${report.touchesResent} dncMirrored=${report.dncMirrored} dncPending=${report.dncPending}${report.errors.length ? " errors=" + report.errors.join("; ") : ""}`,
  );
  return report;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
