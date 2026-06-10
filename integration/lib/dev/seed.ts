/**
 * RecruiterOS · Dev seeder
 * Populates the in-memory stores so a freshly deployed instance shows a live
 * Overview, a full Response inbox, and a pipeline, without any external calls.
 * Safe to call repeatedly (idempotent per workspace via a guard).
 */

import { getCore } from "../core/repository";
import { rid, nowIso, today } from "../core/ids";
import { createCampaign } from "../campaigns";
import { addProspect } from "../prospects";
import { addLinkedInAccount, addDomain } from "../accounts";
import { seedGreen } from "../connected";
import { processInbound } from "../response";
import type { Campaign } from "../core/types";

const seeded = new Set<string>();

export async function seedWorkspace(workspaceId: string): Promise<{ seeded: boolean }> {
  if (seeded.has(workspaceId)) return { seeded: false };
  seeded.add(workspaceId);

  // Accounts + domains so Overview capacity is green.
  addLinkedInAccount(workspaceId, "jamie@recruitersos.co", "unipile");
  ["go-recruitersos.com", "try-recruitersos.com", "hey-recruitersos.com", "talk-recruitersos.com", "meet-recruitersos.com"]
    .forEach((d) => addDomain(workspaceId, d, 3));

  // Integrations -> green (demo seed; no live credentials needed).
  for (const id of ["unipile", "rapidapi", "fresh_linkedin", "loxo", "taltxt", "telnyx"] as const) {
    await seedGreen(workspaceId, id);
  }

  // Two campaigns (one per motion).
  const rec = await createCampaign({
    workspaceId, motion: "recruiting", name: "Senior React · Berlin",
    goal: "Source senior React engineers open to a greenfield staff role.",
    icp: { accountProfile: "Series A-C, EU", persona: "Senior React engineer", disqualifiers: [] },
    signals: ["hiring_velocity", "leadership_change"],
  });
  const bd = await createCampaign({
    workspaceId, motion: "bd", name: "Fintech VPs · DACH",
    goal: "Book discovery calls with VP Eng at recently funded fintechs.",
    icp: { accountProfile: "Funded fintech, DACH", persona: "VP Engineering", disqualifiers: ["has internal TA"] },
    signals: ["fundraising", "expansion"],
  });
  rec.status = bd.status = "active";
  await getCore().saveCampaign(rec);
  await getCore().saveCampaign(bd);

  await seedProspects(workspaceId, rec, bd);
  await seedResponses(workspaceId);

  return { seeded: true };
}

async function seedProspects(workspaceId: string, rec: Campaign, bd: Campaign) {
  const people = [
    { fullName: "Anja Köhler", email: "anja@n26.com", title: "VP Engineering", company: "N26", campaignId: bd.id, warmth: 72 },
    { fullName: "Marco Silva", email: "marco@wise.com", title: "Staff Engineer", company: "Wise", campaignId: rec.id, warmth: 88 },
    { fullName: "Liam O'Brien", email: "liam@revolut.com", title: "Head of Talent", company: "Revolut", campaignId: bd.id, warmth: 64 },
    { fullName: "Sofia Rossi", email: "sofia@scalable.capital", title: "Eng Manager", company: "Scalable", campaignId: rec.id, warmth: 55 },
  ];
  for (const p of people) {
    const saved = await addProspect({ workspaceId, ...p });
    saved.status = "in_sequence";
    saved.dripStage = 3;
    await getCore().saveProspect(saved);
  }
  // one booked, for Overview.
  const booked = await addProspect({ workspaceId, fullName: "Priya Desai", email: "priya@lumen.io", title: "Founder", company: "Lumen", campaignId: bd.id, warmth: 90 });
  booked.status = "booked"; booked.bookedAt = today(); booked.lastChannel = "email";
  await getCore().saveProspect(booked);
}

async function seedResponses(workspaceId: string) {
  // Feed the real pipeline so classification + routing actually run.
  const inbounds: { source: any; payload: Record<string, unknown> }[] = [
    { source: "unipile", payload: { event: "message_received", message_id: rid("m"), sender_name: "Marco Silva", sender_profile_url: "marco@wise.com", text: "Yeah, Thursday afternoon works.", timestamp: nowIso() } },
    { source: "instantly", payload: { event_type: "campaign.replied", message_id: rid("m"), lead_name: "Rahel Amanuel", lead_email: "rahel@klarna.com", reply_text: "Interesting, can you send the case study?", timestamp: nowIso() } },
    { source: "taltxt", payload: { event: "message_received", message_id: rid("m"), contact_name: "Jonas Keller", from: "+4915112345678", text: "Not now, maybe revisit in Q3.", received_at: nowIso() } },
    { source: "instantly", payload: { event_type: "campaign.replied", message_id: rid("m"), lead_name: "Oskar Wendt", lead_email: "oskar@trade.de", reply_text: "STOP", timestamp: nowIso() } },
  ];
  for (const i of inbounds) await processInbound(i.source, workspaceId, i.payload);
}
