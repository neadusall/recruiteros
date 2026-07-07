/**
 * RecruitersOS · Prospects
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
  /** Pairs the person to their company so outreach enrichment can resolve contact. */
  companyDomain?: string;
  title?: string;
  photoUrl?: string;
  location?: string;
  headline?: string;
  category?: string;
  motion?: Motion;
  /** The recruiter who owns this prospect (the creating user). */
  ownerId?: string;
  warmth?: number;
  /** Hiring/buying signal that surfaced this prospect (carried into outreach). */
  signalType?: string;
  signalReason?: string;
  /** Recruiter-side MPC personalization ({{Your_Name}}, placement city/role), stamped from the
   *  campaign at enrollment so the Day-0 templates render fully personal. */
  mpcContext?: Prospect["mpcContext"];
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
    companyDomain: input.companyDomain ?? p.companyDomain,
    title: input.title ?? p.title,
    photoUrl: input.photoUrl ?? p.photoUrl,
    location: input.location ?? p.location,
    headline: input.headline ?? p.headline,
    category: input.category ?? p.category,
    motion: input.motion ?? p.motion,
    ownerId: p.ownerId ?? input.ownerId,
    signalType: input.signalType ?? p.signalType,
    signalReason: input.signalReason ?? p.signalReason,
    mpcContext: input.mpcContext ?? p.mpcContext,
  });

  // Free first pass: backfill missing email/phone from the Data warehouse (a record
  // we already own) before any paid enrichment runs. Best-effort; never blocks an add.
  if (!p.email || !p.phone) {
    try {
      const { backfillFromWarehouse } = await import("../data");
      const hit = await backfillFromWarehouse(input.workspaceId, {
        fullName: p.fullName, company: p.company, linkedinUrl: p.linkedinUrl, email: p.email, phone: p.phone,
      });
      if (hit.email && !p.email) p.email = hit.email;
      if (hit.phone && !p.phone) p.phone = hit.phone;
    } catch { /* warehouse empty or unavailable — leave gaps for paid enrichment */ }
  }

  if (p.email) {
    p.atsPersonId = await getAts().upsertPersonByEmail(p.email, {
      name: p.fullName,
      company: p.company,
      title: p.title,
      source: "outbound",
    });
  }
  await core.saveProspect(p);
  return p;
}

/**
 * Research the actual hiring manager behind a role — a REAL person, never invented.
 *
 * Drives the workspace's connected LinkedIn account to search "<title> <company>" and
 * returns the best-matching member (name + profile). With no connected account it
 * returns null (the prospect stays a role placeholder until a research source exists).
 * This is the only honest way to resolve a name: from a live people lookup, not a guess.
 */
export async function findHiringManager(
  workspaceId: string,
  q: { company?: string; title?: string },
): Promise<{ fullName: string; title?: string; linkedinUrl?: string } | null> {
  if (!q.company || !q.title) return null;
  try {
    const { listLinkedInAccounts } = await import("../accounts");
    const { getProvider } = await import("../linkedin/provider");
    const { toEngineAccount } = await import("../linkedin/console");
    const core = listLinkedInAccounts(workspaceId).find((a) => a.active && a.warmup !== "flagged");
    if (!core) return null;
    const account = toEngineAccount(core, core.id);
    const url =
      "https://www.linkedin.com/search/results/people/?keywords=" +
      encodeURIComponent(`${q.title} ${q.company}`);
    const profiles = await getProvider().searchProfiles({ account, url, limit: 5 });
    if (!profiles?.length) return null;
    const co = q.company.toLowerCase();
    const best = profiles.find((pr) => (pr.company ?? "").toLowerCase().includes(co)) ?? profiles[0];
    if (!best?.fullName) return null;
    return { fullName: best.fullName, title: best.title ?? q.title, linkedinUrl: best.publicProfileUrl };
  } catch {
    return null;
  }
}

/** True when the prospect is still a role placeholder (no researched person yet). */
function needsHiringManager(p: Prospect): boolean {
  return !p.linkedinUrl && (/ [—–] /.test(p.fullName || "") || /hiring manager/i.test(p.fullName || ""));
}

/**
 * Enrich one prospect — first RESEARCH the hiring manager's real name (if the prospect
 * is still a role placeholder), then resolve company email + phone, cheapest-first.
 *
 * Name research drives the connected LinkedIn account; contact enrichment uses the
 * waterfall over the company domain. Both no-op safely without a connected source, so
 * this is always safe to call. Returns `{ prospect, found }` describing what was resolved.
 */
export async function enrichProspect(
  workspaceId: string,
  prospectId: string,
  field?: "email" | "phone",
): Promise<{ prospect: Prospect; found: { name: boolean; email: boolean; phone: boolean } }> {
  const core = getCore();
  const p = await core.getProspect(prospectId);
  if (!p || p.workspaceId !== workspaceId) throw Object.assign(new Error("not_found"), { status: 404 });

  // Step 1: resolve the actual hiring manager (real person), if not already known.
  let nameResolved = false;
  if (needsHiringManager(p)) {
    const hm = await findHiringManager(workspaceId, { company: p.company, title: p.title });
    if (hm?.fullName) {
      p.fullName = hm.fullName;
      p.firstName = hm.fullName.trim().split(/\s+/)[0];
      if (hm.title) p.title = hm.title;
      if (hm.linkedinUrl) p.linkedinUrl = hm.linkedinUrl;
      nameResolved = true;
    }
  }

  const domain = p.companyDomain;
  const [first, ...rest] = (p.fullName || "").trim().split(/\s+/);
  let email = p.email;
  let phone = p.phone;

  try {
    const { cheapFirstContactWaterfall, enrich, classifyLine } = await import("../signals");
    // Resolve a direct dial (Apify ryanclinton actor → landlinePhone) whenever we're
    // after a phone — this is the lazy direct-dial lookup the Voice-Drop rule depends on.
    const wantPhone = field !== "email";
    const report = await enrich(
      cheapFirstContactWaterfall({ includeLandline: wantPhone }),
      {
        name: p.company,
        companyName: p.company,
        domain,
        fullName: p.fullName,
        firstName: first,
        lastName: rest.join(" "),
        linkedinUrl: p.linkedinUrl,
        title: p.title,
      },
      { now: nowIso() },
    );
    const e = report.subject.email;
    if (typeof e === "string") email = e;

    // A resolved direct dial gets confirmed by Telnyx (carrier line type) before the
    // voice channel trusts it, and the find is metered to the cost ledger.
    const dial = report.resolved.landlinePhone;
    const dialNumber = typeof dial?.value === "string" ? dial.value : undefined;
    if (dialNumber) {
      // Meter ONLY a person-direct find, by the actual provider that found it, and only
      // when that provider carries a known cost rate. A cheap RapidAPI rung with no rate
      // is per-call infra cost, not a per-find charge — so it records nothing. A no-find
      // never reaches here, so we never pay for a miss or a company switchboard.
      const provId = dial?.providerId ?? "";
      const { rateCost } = await import("../billing/rates");
      const unitCostUsd = rateCost(provId);
      if (unitCostUsd > 0) {
        const { recordUsage } = await import("../billing/ledger");
        recordUsage({
          workspaceId,
          motion: p.motion ?? "bd",
          category: "enrichment",
          type: provId,
          source: provId.startsWith("apify") ? "apify" : "rapidapi",
          quantity: 1,
          unitCostUsd,
          meta: { prospectId, number: dialNumber },
        });
      }
      const cls = await classifyLine(dialNumber, { workspaceId, motion: p.motion ?? "bd" });
      if (cls.landlinePhone) p.landlinePhone = cls.landlinePhone;
      else if (cls.mobilePhone) p.mobilePhone = cls.mobilePhone;
      phone = cls.landlinePhone ?? cls.mobilePhone ?? dialNumber;
    } else if (typeof report.subject.phone === "string") {
      phone = report.subject.phone;
    }
  } catch {
    /* leave unresolved; the recruiter can retry or add manually */
  }

  const found = {
    name: nameResolved,
    email: field !== "phone" && !!email && email !== p.email,
    phone: field !== "email" && !!phone && phone !== p.phone,
  };

  // Update the existing record in place (don't route through addProspect — its
  // email-dedupe would fork a second prospect when the original had no email yet).
  // Honor the requested field so "Enrich email" / "Enrich phone" stay individual.
  if (field !== "phone") p.email = email ?? p.email;
  if (field !== "email") p.phone = phone ?? p.phone;
  if (p.email) {
    p.atsPersonId = await getAts().upsertPersonByEmail(p.email, {
      name: p.fullName,
      company: p.company,
      title: p.title,
      source: "outbound",
    });
    // Verify the resolved email so the pipeline only ever sends to deliverable addresses —
    // "enriched" should always mean "checked", not just "found". Best-effort: re-verify when
    // the email changed or was never checked; a verifier hiccup leaves it for Clients → Verify.
    if (found.email || !p.emailVerification) {
      try {
        const { verifyEmailDetailed } = await import("../inmarket/emailVerify");
        const v = await verifyEmailDetailed(p.email);
        p.emailVerification = { status: v.status, reason: v.reason, source: v.source, checkedAt: nowIso() };
      } catch { /* leave unverified; the Clients tab can retry */ }
    }
  }
  await core.saveProspect(p);
  return { prospect: p, found };
}

export interface VerifyEmailsResult {
  checked: number;
  summary: { valid: number; deliverable: number; risky: number; invalid: number; unknown: number };
  /** Whether a mailbox-level verifier (Reoon / opt-in SMTP) is configured. When false, the
   *  best attainable verdict is the domain-level "deliverable" — the UI surfaces a setup hint. */
  mailboxVerifier: boolean;
  prospects: Prospect[];
}

/**
 * Verify the email deliverability of a workspace's prospects and STAMP each record with its
 * verdict (persisted). With no `ids`, verifies every prospect that has an email; pass `ids` to
 * verify a subset (e.g. only the not-yet-checked ones). Mailbox-level confirmation needs
 * REOON_API_KEY (recommended; cloud, no port 25) or opt-in SMTP; with neither it still returns a
 * real DNS/domain-level verdict so junk/dead addresses are dropped out of the box.
 */
export async function verifyProspectEmails(workspaceId: string, ids?: string[]): Promise<VerifyEmailsResult> {
  const core = getCore();
  const all = await core.listProspects(workspaceId);
  const idSet = ids && ids.length ? new Set(ids) : null;
  const targets = all.filter((p) => p.email && (!idSet || idSet.has(p.id)));

  const { verifyDetailedBatch, reoonEnabled, smtpEnabled } = await import("../inmarket/emailVerify");
  const verdicts = await verifyDetailedBatch(targets.map((p) => ({ id: p.id, email: p.email! })));

  const summary = { valid: 0, deliverable: 0, risky: 0, invalid: 0, unknown: 0 };
  const prospects: Prospect[] = [];
  for (const p of targets) {
    const v = verdicts.get(p.id);
    if (!v) continue;
    p.emailVerification = { status: v.status, reason: v.reason, source: v.source, checkedAt: nowIso() };
    summary[v.status]++;
    await core.saveProspect(p);
    prospects.push(p);
  }
  return { checked: prospects.length, summary, mailboxVerifier: reoonEnabled() || smtpEnabled(), prospects };
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
