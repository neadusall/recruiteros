/**
 * RecruitersOS · Loxo activity sync (the "have we talked to this person?" layer)
 *
 * Pulls the agency's COMMUNICATION history out of Loxo and stamps it onto the
 * warehouse records, so every outbound path can refuse to double-contact a
 * candidate or client the agency is already talking to. Three Loxo sources,
 * all incremental (created_at_start window + scroll cursor):
 *
 *   person_events   - the unified activity log (calls, emails, meetings, texts, notes)
 *   email_tracking  - emails sent through Loxo campaigns/tracking
 *   sms             - texts sent/received through Loxo
 *
 * Only REAL communication types advance `lastContactedAt` (an internal note or
 * a pipeline drag is not a touch). Classification is by activity-type NAME
 * because Loxo type ids are per-agency and customizable.
 *
 * The reverse direction lives here too: `logTouchToAts` posts every RecruitersOS
 * send into Loxo as a person_event (form-encoded, real activity_type_id), so
 * recruiters working inside Loxo see the touch and don't double-contact from
 * their side either.
 */

import { applyContactActivity, findRecordForPerson, saveRecord } from "../data";
import { getVendorConfig, markActivitySynced, type AtsVendorConfig } from "./credentials";
import { LoxoClient } from "./loxoClient";

const MAX_ACTIVITY_PAGES = envInt("LOXO_ACTIVITY_MAX_PAGES", 100);
/** First pass has no cursor; look back this far instead of scanning all history. */
const LOOKBACK_DAYS = envInt("LOXO_ACTIVITY_LOOKBACK_DAYS", 365);

export interface ActivityReport {
  ok: boolean;
  scanned: number;      // events read across all three sources
  touches: number;      // events classified as real communication
  peopleUpdated: number; // warehouse records whose lastContactedAt moved
  error?: string;
}

/* ---------------- classification ---------------- */

/** Activity-type names that are REAL communication, mapped to our channel vocab. */
const CHANNEL_RULES: Array<{ rx: RegExp; channel: string }> = [
  { rx: /in[\s_-]?mail|e-?mail/i, channel: "email" },
  { rx: /text|sms/i, channel: "sms" },
  { rx: /call|dial|phone|voicemail|vm\b/i, channel: "call" },
  { rx: /linked[\s_-]?in|connection|connect request|dm\b/i, channel: "linkedin" },
  { rx: /meeting|interview|zoom|teams|screen/i, channel: "meeting" },
  { rx: /message|outreach|contacted|follow[\s_-]?up/i, channel: "message" },
];

/** Classify an activity-type name; undefined = not communication (note, pipeline move, task...). */
export function classifyActivityName(name?: string): string | undefined {
  const n = (name || "").trim();
  if (!n) return undefined;
  for (const r of CHANNEL_RULES) if (r.rx.test(n)) return r.channel;
  return undefined;
}

/* ---------------- the pull: Loxo -> warehouse ---------------- */

/**
 * Incremental pull of communication history for one workspace. Safe to run
 * repeatedly: timestamps only move forward and the window advances only after
 * a clean pass. Call with the same client the record sync used so the shared
 * rate gate stays adaptive across the whole run.
 *
 * `opts.sinceOverride` (ISO) forces a wider window regardless of the cursor:
 * the daily reconcile uses it to re-scan the recent past and catch BACKDATED
 * activity (a recruiter logging "called them last week") that a cursor-only
 * incremental poll would never see.
 */
export async function syncLoxoActivity(
  workspaceId: string,
  client: LoxoClient,
  cfg: AtsVendorConfig | null,
  opts: { sinceOverride?: string; maxPages?: number } = {},
): Promise<ActivityReport> {
  const maxPages = opts.maxPages ?? MAX_ACTIVITY_PAGES;
  const report: ActivityReport = { ok: true, scanned: 0, touches: 0, peopleUpdated: 0 };
  const since =
    opts.sinceOverride || cfg?.activityCursor || new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600_000).toISOString();
  // Advance the next window to "now minus a day" of overlap so clock skew or a
  // partially-indexed page can never permanently drop an event.
  const nextCursor = new Date(Date.now() - 24 * 3600_000).toISOString();

  // person_id -> newest communication seen this pass
  const latest = new Map<string, { at: string; channel?: string }>();
  const note = (personId: unknown, at: unknown, channel?: string) => {
    const pid = personId != null ? String(personId) : "";
    const ts = typeof at === "string" ? at : "";
    if (!pid || !ts) return;
    report.touches++;
    const cur = latest.get(pid);
    if (!cur || ts > cur.at) latest.set(pid, { at: ts, channel });
  };

  try {
    // 1) The unified activity log, filtered to communication types by name.
    const types = await client.listActivityTypes();
    const typeChannel = new Map<string, string | undefined>();
    for (const t of types) {
      const id = t?.id != null ? String(t.id) : "";
      if (id) typeChannel.set(id, classifyActivityName(t?.name));
    }
    await scroll(
      (scrollId) => client.listPersonEvents({ scrollId, createdAtStart: since }),
      (ev) => {
        report.scanned++;
        const typeId = ev?.activity_type_id != null ? String(ev.activity_type_id) : "";
        const channel = typeId && typeChannel.has(typeId)
          ? typeChannel.get(typeId)
          : classifyActivityName(ev?.activity_type?.name || ev?.activity_type_name);
        if (!channel) return; // notes / pipeline moves / unknown types are not touches
        note(ev?.person_id ?? ev?.person?.id, ev?.created_at ?? ev?.updated_at, channel);
      },
      maxPages,
    );

    // 2) Emails sent through Loxo (campaign / tracked email).
    await scroll(
      (scrollId) => client.listEmailTracking({ scrollId, createdAtStart: since }),
      (em) => {
        report.scanned++;
        note(em?.person_id ?? em?.person?.id ?? firstId(em?.person_ids), em?.created_at ?? em?.sent_at, "email");
      },
      maxPages,
    );

    // 3) Texts through Loxo.
    await scroll(
      (scrollId) => client.listSms({ scrollId, createdAtStart: since }),
      (m) => {
        report.scanned++;
        note(m?.person_id ?? m?.person?.id, m?.created_at ?? m?.sent_at, "sms");
      },
      maxPages,
    );

    report.peopleUpdated = await applyContactActivity(
      workspaceId,
      new Map([...latest].map(([pid, v]) => [pid, { at: v.at, channel: v.channel }])),
    );
    await markActivitySynced(workspaceId, "loxo", nextCursor);
    return report;
  } catch (e: any) {
    const detail = e?.detail ? String(e.detail).replace(/\s+/g, " ").trim() : "";
    const msg = e?.message ?? "activity_sync_failed";
    // A 404 here means the account's API plan doesn't expose an activity
    // resource; report it but don't fail the record sync that ran before us.
    return { ...report, ok: false, error: detail ? `${msg}: ${detail}` : msg };
  }
}

/** Walk a scroll-paginated Loxo resource to the end (bounded). */
async function scroll(
  fetchPage: (scrollId?: string) => Promise<{ items: any[]; scrollId?: string }>,
  each: (item: any) => void,
  maxPages: number = MAX_ACTIVITY_PAGES,
): Promise<void> {
  let scrollId: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(scrollId);
    if (!res.items.length) break;
    for (const item of res.items) each(item);
    if (!res.scrollId) break;
    scrollId = res.scrollId;
  }
}

function firstId(v: any): string | undefined {
  return Array.isArray(v) && v.length ? String(v[0]) : undefined;
}

/* ---------------- the push: RecruitersOS touch -> Loxo ---------------- */

/** Per-workspace activity-type cache so every send doesn't refetch the vocabulary. */
const typeCache = new Map<string, { at: number; types: any[] }>();
const TYPE_TTL_MS = 15 * 60_000;

async function activityTypesFor(workspaceId: string, client: LoxoClient): Promise<any[]> {
  const hit = typeCache.get(workspaceId);
  if (hit && Date.now() - hit.at < TYPE_TTL_MS) return hit.types;
  const types = await client.listActivityTypes().catch(() => []);
  typeCache.set(workspaceId, { at: Date.now(), types });
  return types;
}

/** Pick the agency's activity type that best matches our channel. */
function pickTypeId(types: any[], channel: string): string | undefined {
  const wanted =
    channel === "sms" ? /text|sms/i
    : channel === "voice" ? /call|voicemail|vm\b/i
    : channel === "linkedin" ? /linked[\s_-]?in|inmail|message/i
    : /e-?mail/i;
  let fallback: string | undefined;
  for (const t of types) {
    const name = String(t?.name || "");
    const id = t?.id != null ? String(t.id) : "";
    if (!id) continue;
    if (wanted.test(name)) return id;
    if (!fallback && /note/i.test(name)) fallback = id;
  }
  return fallback;
}

export interface TouchLog {
  /** Loxo person id when known, else an email/phone/linkedin handle to resolve. */
  personRef?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  fullName?: string;
  company?: string;
  channel: string; // email | sms | voice | linkedin
  note: string;
  at: string;
}

/**
 * Record a RecruitersOS outbound touch both locally (warehouse lastContactedAt,
 * so the guard sees it immediately) and in Loxo (person_event, so recruiters in
 * the ATS see it). Best-effort by design: a logging failure must never fail the
 * send that already happened. Returns the Loxo event id when one was created.
 */
export async function logTouchToAts(workspaceId: string, t: TouchLog): Promise<string | undefined> {
  // 1) Local stamp first: find the warehouse record for this person.
  let providerId: string | undefined;
  try {
    const rec = await findRecordForPerson(workspaceId, {
      email: t.email,
      phone: t.phone,
      linkedinUrl: t.linkedinUrl,
      fullName: t.fullName,
      company: t.company,
    });
    if (rec) {
      if (!rec.lastContactedAt || t.at > rec.lastContactedAt) {
        rec.lastContactedAt = t.at;
        rec.lastContactChannel = t.channel === "voice" ? "call" : t.channel;
        await saveRecord(rec);
      }
      if (rec.source === "loxo" && rec.providerId) providerId = rec.providerId;
    }
  } catch { /* local stamp is best-effort */ }

  // 2) Mirror to Loxo when this workspace has a live connection and we can key the person.
  if (!providerId && t.personRef && /^\d+$/.test(t.personRef)) providerId = t.personRef;
  if (!providerId) return undefined;
  try {
    const cfg = await getVendorConfig(workspaceId, "loxo");
    if (!cfg || !cfg.domain || !cfg.slug || !cfg.apiKey) return undefined;
    const client = new LoxoClient({ domain: cfg.domain, slug: cfg.slug, apiKey: cfg.apiKey });
    const types = await activityTypesFor(workspaceId, client);
    const res = await client.createPersonEvent({
      personId: providerId,
      activityTypeId: pickTypeId(types, t.channel),
      notes: `[RecruitersOS ${t.channel}] ${t.note}`.slice(0, 500),
      createdAt: t.at,
    });
    return res.ok ? res.id : undefined;
  } catch {
    return undefined;
  }
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
