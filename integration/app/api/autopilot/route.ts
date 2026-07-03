/**
 * Autopilot command center API.
 *
 * GET  /api/autopilot  -> everything the Autopilot dashboard renders:
 *   engine on/off + armed, the configured ticks, every campaign with its model
 *   status + live prospect counts, the BD hiring-signal pool stats + breakdown,
 *   and the recent send/activity feed.
 *
 * POST /api/autopilot { action, ... }:
 *   estimate        { count, directDial? }                    -> push cost estimate
 *   create-campaign { name, motion, goal?, icp?, methodology?, dailyCap?, voiceNoteThreshold? }
 *   draft-model     { campaignId }                            -> LLM-draft the outreach model (resets approval)
 *   update-model    { campaignId, touches, summary? }         -> save edits to the model
 *   approve-model   { campaignId }                            -> approve the model (the one-time gate)
 *   set-autorun     { campaignId, autoRun }                   -> arm/disarm hands-off (needs an approved model)
 *   pull            { campaignId, limit?, signalTypes?, industries?, query?, findDirectDial?, contactsPerCompany? }
 *                                                             -> pull hiring signals, enrich, stage onto the campaign
 *   run-now         {}                                        -> run the Autopilot loop for this workspace now
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import { getCore } from "../../../lib/core/repository";
import { automationEnabled, automationArmed, automationTicks } from "../../../lib/automation/scheduler";
import { draftCampaignModel } from "../../../lib/automation/model";
import { createCampaign, runAutopilot } from "../../../lib/campaigns";
import { poolStats, queryPool } from "../../../lib/inmarket/pool";
import { signalBreakdown, hiringManagersFor, promoteLead, type InMarketLead, type HiringManagerLead } from "../../../lib/inmarket";
import { resolveDecisionMaker, type DecisionMaker } from "../../../lib/inmarket/decisionMaker";
import { estimatePushCost } from "../../../lib/inmarket/launch";
import type { Campaign, Motion } from "../../../lib/core/types";

/**
 * Flatten a resolved decision-maker (the role-owner + the economic BUYERS found in the SAME free
 * research pass) into named HiringManagerLead entries. This is how the pull path gets 2+ REAL,
 * distinct people per company — the role-owner PLUS the Head of People / C-suite — instead of one
 * person shown at several title rungs. Deduped by name; unnamed entries are dropped so we never
 * promote a title-only ghost. Each becomes its own prospect → its own diversified video + email.
 */
function decisionMakerManagers(dm: DecisionMaker, role: string): HiringManagerLead[] {
  const out: HiringManagerLead[] = [];
  const seen = new Set<string>();
  for (const d of [dm, ...(dm.others ?? [])]) {
    if (!d.fullName) continue;
    const k = d.fullName.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({
      role,
      function: d.function as HiringManagerLead["function"],
      managerTitle: d.title || d.targetTitle,
      managerName: d.fullName,
      likelyEmail: d.email?.email,
      emailVerified: !!d.emailConfirmed,
      why: d.why,
    });
  }
  return out;
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const core = getCore();

  const campaignsRaw = await core.listCampaigns(ws);
  const campaigns = await Promise.all(
    campaignsRaw.map(async (c) => {
      const ps = await core.listProspects(ws, { campaignId: c.id });
      const count = (s: string) => ps.filter((p) => p.status === s).length;
      return {
        id: c.id, name: c.name, motion: c.motion, status: c.status,
        autoRun: !!c.autoRun, outreachApproved: !!c.outreachApproved, hasModel: !!c.model,
        methodology: c.methodology, dailyCap: c.dailyCap, voiceNoteThreshold: c.voiceNoteThreshold,
        modelSummary: c.model?.summary, modelEngine: c.model?.engine, modelTouches: c.model?.touches?.length ?? 0,
        counts: { total: ps.length, queued: count("queued"), inSequence: count("in_sequence"), replied: count("replied"), nurture: count("nurture"), won: count("won") },
      };
    }),
  );

  // BD hiring-signal pool: stats + signal-type breakdown (best-effort; empty without a DB).
  let signals: unknown = null;
  try {
    const stats = await poolStats();
    const leads = await queryPool({}, 5000);
    signals = { ...stats, breakdown: signalBreakdown(leads) };
  } catch { /* no pool yet */ }

  const activity = (await core.listAllActivity(ws)).slice(0, 40);

  return ok({
    enabled: automationEnabled(),
    armed: automationArmed(),
    ticks: automationTicks(),
    campaigns,
    signals,
    activity,
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const core = getCore();
  const b = await body<any>(req);

  // Look up + ownership-check a campaign for any action that names one.
  async function owned(id: string): Promise<Campaign | { err: Response }> {
    const c = await core.getCampaign(id);
    if (!c) return { err: fail("not_found", 404) };
    if (c.workspaceId !== ws) return { err: fail("forbidden", 403) };
    return c;
  }

  try {
    switch (b?.action) {
      case "estimate": {
        const count = Number(b.count) || 0;
        return ok({ estimate: estimatePushCost(count, { directDial: b.directDial === true }) });
      }

      case "create-campaign": {
        if (!b?.name) return fail("missing_fields", 422, { detail: "name is required" });
        const motion: Motion = b.motion === "recruiting" ? "recruiting" : "bd";
        const c = await createCampaign({
          workspaceId: ws,
          motion,
          name: String(b.name),
          goal: String(b.goal || (motion === "bd" ? "Win meetings with companies that are actively hiring." : "Open strong candidates to an active role.")),
          icp: b.icp || { accountProfile: "", persona: "", disqualifiers: [] },
          signals: Array.isArray(b.signals) ? b.signals : [],
          methodology: b.methodology,
          voiceNoteThreshold: Number(b.voiceNoteThreshold) || undefined,
          dailyCap: Number(b.dailyCap) || undefined,
        });
        return ok({ campaign: c }, 201);
      }

      case "get-model": {
        const c = await owned(String(b.campaignId || ""));
        if ("err" in c) return c.err;
        return ok({ model: c.model || null, outreachApproved: !!c.outreachApproved });
      }

      case "draft-model": {
        const c = await owned(String(b.campaignId || ""));
        if ("err" in c) return c.err;
        const model = await draftCampaignModel(c);
        c.model = model;
        c.outreachApproved = false; // a fresh draft must be re-approved
        c.updatedAt = new Date().toISOString();
        await core.saveCampaign(c);
        return ok({ model });
      }

      case "update-model": {
        const c = await owned(String(b.campaignId || ""));
        if ("err" in c) return c.err;
        if (!c.model) return fail("no_model", 409, { detail: "draft a model first" });
        if (Array.isArray(b.touches)) {
          c.model.touches = b.touches
            .filter((t: any) => t && String(t.body || "").trim())
            .map((t: any, i: number) => ({
              key: t.key || "t" + i,
              day: Number.isFinite(+t.day) ? Math.max(0, Math.round(+t.day)) : i,
              channel: t.channel === "linkedin" || t.channel === "voice" ? t.channel : "email",
              action: t.action || undefined,
              label: String(t.label || `Touch ${i + 1}`).slice(0, 60),
              subject: t.subject ? String(t.subject).slice(0, 160) : undefined,
              body: String(t.body).slice(0, 2000),
            }))
            .sort((a: any, z: any) => a.day - z.day);
        }
        if (typeof b.summary === "string") c.model.summary = b.summary.slice(0, 280);
        c.outreachApproved = false; // edits reset approval
        c.updatedAt = new Date().toISOString();
        await core.saveCampaign(c);
        return ok({ model: c.model });
      }

      case "approve-model": {
        const c = await owned(String(b.campaignId || ""));
        if ("err" in c) return c.err;
        if (!c.model || !(c.model.touches?.length)) return fail("no_model", 409, { detail: "draft a model first" });
        c.model.approvedAt = new Date().toISOString();
        c.outreachApproved = true;
        c.updatedAt = c.model.approvedAt;
        await core.saveCampaign(c);
        return ok({ campaign: c });
      }

      case "set-autorun": {
        const c = await owned(String(b.campaignId || ""));
        if ("err" in c) return c.err;
        const on = b.autoRun === true;
        if (on && !c.outreachApproved) return fail("not_approved", 409, { detail: "approve the outreach model before turning Autopilot on" });
        c.autoRun = on;
        if (on && c.status !== "active") c.status = "active";
        c.updatedAt = new Date().toISOString();
        await core.saveCampaign(c);
        return ok({ campaign: c });
      }

      case "pull": {
        const c = await owned(String(b.campaignId || ""));
        if ("err" in c) return c.err;
        if (c.motion !== "bd") return fail("bd_only", 422, { detail: "Hiring-signal pull is BD. For Recruiting, source candidates in JD Sourcing — Autopilot then sequences them." });
        const limit = Math.min(Math.max(Number(b.limit) || 25, 1), 500);
        // Default to THREE decision-makers per company (was 1): the first DM plus two more, so each
        // gets their own diversified video + email. Hire Signals returns up to 3 real people; caller
        // can still override (1–5).
        const perCompany = Math.min(Math.max(Number(b.contactsPerCompany) || 3, 1), 5);
        const findDirectDial = b.findDirectDial === true;
        const leads = await queryPool(
          { signalTypes: b.signalTypes, industries: b.industries, query: b.query },
          limit,
        );
        let promoted = 0, withEmail = 0, withPhone = 0, errors = 0, realDmCompanies = 0;
        for (const lead of leads as InMarketLead[]) {
          let managers: Array<HiringManagerLead | undefined> = [];
          // When more than one contact per company is requested, resolve REAL distinct people (the
          // role-owner + the Head of People / C-suite buyers) via free research, so DM #2 and #3 are
          // genuinely different humans — not the same person at another title rung. Any miss (no
          // domain, research failure, only one name found) falls back to the title-ladder below.
          if (perCompany > 1) {
            try {
              const role = lead.roles?.[0] || "the open role";
              const dm = await resolveDecisionMaker(lead.company, role, {
                domain: lead.domain, companySize: lead.employeeCount, sourceUrl: lead.sourceUrl,
              });
              const real = decisionMakerManagers(dm, role);
              if (real.length > 1) { managers = real.slice(0, perCompany); realDmCompanies++; }
            } catch { /* fall back to the title-ladder */ }
          }
          if (!managers.length) {
            managers = (lead.hiringManagers?.length ? lead.hiringManagers : hiringManagersFor(lead.roles, lead.raw?.person)).slice(0, perCompany);
          }
          const picks = managers.length ? managers : [undefined];
          for (const m of picks) {
            try {
              const p = await promoteLead(ws, c.id, lead, m as any, { findDirectDial });
              promoted++;
              if (p.email) withEmail++;
              if (p.phone) withPhone++;
            } catch { errors++; }
          }
        }
        return ok({ pulled: leads.length, promoted, withEmail, withPhone, errors, realDmCompanies });
      }

      case "run-now": {
        const summary = await runAutopilot(ws);
        return ok({ ran: true, ...summary });
      }

      default:
        return fail("unknown_action", 400);
    }
  } catch (e: any) {
    return fail(e?.message ?? "autopilot_failed", e?.status ?? 400);
  }
}
