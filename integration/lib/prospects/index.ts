/**
 * RecruiterOS · Prospects
 * Pipeline lifecycle + the automation rules that move prospects between stages.
 *
 * The status lifecycle is shared across both motions (BD labels: Discovery
 * booked / Mandate signed; Recruiting labels: Submitted / Placed). Bidirectional
 * Loxo sync: every add/edit upserts the Person; every status flip logs a
 * person_event.
 */

import { getCore } from "../core/repository";
import { getAts } from "../ats";
import { rid, nowIso, today } from "../core/ids";
import type { Prospect, ProspectStatus, Motion } from "../core/types";

/** Lifecycle stages in order, with the per-motion display labels. */
export const LIFECYCLE: { status: ProspectStatus; bd: string; recruiting: string }[] = [
  { status: "queued", bd: "Queued", recruiting: "Queued" },
  { status: "in_sequence", bd: "In sequence", recruiting: "In sequence" },
  { status: "replied", bd: "Replied", recruiting: "Replied" },
  { status: "booked", bd: "Discovery booked", recruiting: "Submitted" },
  { status: "won", bd: "Mandate signed", recruiting: "Placed" },
  { status: "nurture", bd: "Nurture", recruiting: "Nurture" },
  { status: "closed_lost", bd: "Closed lost", recruiting: "Closed lost" },
  { status: "do_not_contact", bd: "Do not contact", recruiting: "Do not contact" },
];

export function statusLabel(status: ProspectStatus, motion: Motion): string {
  const row = LIFECYCLE.find((l) => l.status === status);
  return row ? row[motion] : status;
}

export interface NewProspectInput {
  workspaceId: string;
  campaignId: string;
  fullName: string;
  email?: string;
  linkedinUrl?: string;
  phone?: string;
  company?: string;
  title?: string;
  category?: string;
  warmth?: number;
}

/** Manual add or bulk-upload row -> creates/updates the ATS Person too. */
export async function addProspect(input: NewProspectInput): Promise<Prospect> {
  const core = getCore();
  const existing = input.email
    ? await core.findProspectByEmail(input.workspaceId, input.email)
    : null;

  const p: Prospect = existing ?? {
    id: rid("pros"),
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    fullName: input.fullName,
    firstName: input.fullName.trim().split(/\s+/)[0],
    status: "queued",
    dripStage: null,
    warmth: input.warmth ?? 50,
    createdAt: nowIso(),
  };

  Object.assign(p, {
    email: input.email ?? p.email,
    linkedinUrl: input.linkedinUrl ?? p.linkedinUrl,
    phone: input.phone ?? p.phone,
    company: input.company ?? p.company,
    title: input.title ?? p.title,
    category: input.category ?? p.category,
  });

  if (input.email) {
    p.atsPersonId = await getAts().upsertPersonByEmail(input.email, {
      name: p.fullName,
      company: p.company,
      title: p.title,
      source: "outbound",
    });
  }
  await core.saveProspect(p);
  return p;
}

/** Bulk CSV import with dedupe (one Person upsert per row). */
export async function bulkUpload(rows: NewProspectInput[]): Promise<{ added: number; deduped: number }> {
  let added = 0;
  let deduped = 0;
  for (const row of rows) {
    const before = row.email ? await getCore().findProspectByEmail(row.workspaceId, row.email) : null;
    await addProspect(row);
    before ? deduped++ : added++;
  }
  return { added, deduped };
}

/** Move a prospect to a new status and log the activity (booked stamps booked_at). */
export async function transition(prospectId: string, status: ProspectStatus): Promise<Prospect | null> {
  const core = getCore();
  const p = await core.getProspect(prospectId);
  if (!p) return null;
  p.status = status;
  if (status === "booked" && !p.bookedAt) p.bookedAt = today();
  await core.saveProspect(p);

  const ref = p.atsPersonId ?? p.email ?? p.id;
  const eventId = await getAts().pushPersonEvent({
    personRef: ref,
    activityType: statusLabel(status, "bd"),
    channel: "system",
    note: `Status -> ${status}`,
    at: nowIso(),
  });
  await core.recordActivity({
    id: rid("act"), workspaceId: p.workspaceId, prospectId: p.id,
    channel: "system", type: `status_${status}`, summary: `Status -> ${statusLabel(status, "bd")}`,
    at: nowIso(), atsEventId: eventId,
  });
  return p;
}

/**
 * The lifecycle automation rules (run by the cadence / a sweeper). Returns the
 * prospects it moved and why, so the Overview / Response feed can show it.
 */
export async function applyLifecycleRules(workspaceId: string): Promise<{ prospectId: string; rule: string }[]> {
  const core = getCore();
  const moved: { prospectId: string; rule: string }[] = [];
  const now = Date.now();

  for (const p of await core.listProspects(workspaceId)) {
    const ageDays = (now - Date.parse(p.createdAt)) / 86_400_000;
    // Day 28 no reply -> 90-day nurture.
    if (p.status === "in_sequence" && ageDays >= 28) {
      await transition(p.id, "nurture");
      moved.push({ prospectId: p.id, rule: "day-28 no reply -> 90-day nurture" });
    }
  }
  return moved;
}
