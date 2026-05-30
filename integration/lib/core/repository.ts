/**
 * RecruiterOS · Core
 * Platform repository: the single persistence boundary for every module.
 *
 * Ships an in-memory reference implementation so the whole engine runs end to
 * end with no database. In production, implement `CoreRepository` against your
 * store (Prisma/Postgres) and return it from `getCore()`. Every module
 * (response, campaigns, prospects, accounts, ...) reads/writes through this.
 */

import type {
  ActivityEvent,
  Campaign,
  Prospect,
} from "./types";

export interface CoreRepository {
  // campaigns
  getCampaign(id: string): Promise<Campaign | null>;
  listCampaigns(workspaceId: string): Promise<Campaign[]>;
  saveCampaign(c: Campaign): Promise<void>;
  deleteCampaign(id: string): Promise<void>;

  // prospects
  getProspect(id: string): Promise<Prospect | null>;
  findProspectByEmail(workspaceId: string, email: string): Promise<Prospect | null>;
  findProspectByLinkedin(workspaceId: string, url: string): Promise<Prospect | null>;
  findProspectByPhone(workspaceId: string, phone: string): Promise<Prospect | null>;
  listProspects(workspaceId: string, filter?: Partial<Pick<Prospect, "campaignId" | "status">>): Promise<Prospect[]>;
  saveProspect(p: Prospect): Promise<void>;

  // activity log (mirrors ATS person_events)
  recordActivity(e: ActivityEvent): Promise<void>;
  listActivity(prospectId: string): Promise<ActivityEvent[]>;
}

class InMemoryCore implements CoreRepository {
  campaigns = new Map<string, Campaign>();
  prospects = new Map<string, Prospect>();
  activity: ActivityEvent[] = [];

  async getCampaign(id: string) {
    return this.campaigns.get(id) ?? null;
  }
  async listCampaigns(workspaceId: string) {
    return [...this.campaigns.values()].filter((c) => c.workspaceId === workspaceId);
  }
  async saveCampaign(c: Campaign) {
    this.campaigns.set(c.id, c);
  }
  async deleteCampaign(id: string) {
    this.campaigns.delete(id);
  }

  async getProspect(id: string) {
    return this.prospects.get(id) ?? null;
  }
  async findProspectByEmail(workspaceId: string, email: string) {
    const key = email.trim().toLowerCase();
    for (const p of this.prospects.values()) {
      if (p.workspaceId === workspaceId && p.email?.toLowerCase() === key) return p;
    }
    return null;
  }
  async findProspectByLinkedin(workspaceId: string, url: string) {
    for (const p of this.prospects.values()) {
      if (p.workspaceId === workspaceId && p.linkedinUrl === url) return p;
    }
    return null;
  }
  async findProspectByPhone(workspaceId: string, phone: string) {
    const key = normalizePhone(phone);
    for (const p of this.prospects.values()) {
      if (p.workspaceId === workspaceId && p.phone && normalizePhone(p.phone) === key) return p;
    }
    return null;
  }
  async listProspects(workspaceId: string, filter?: Partial<Pick<Prospect, "campaignId" | "status">>) {
    return [...this.prospects.values()].filter(
      (p) =>
        p.workspaceId === workspaceId &&
        (!filter?.campaignId || p.campaignId === filter.campaignId) &&
        (!filter?.status || p.status === filter.status),
    );
  }
  async saveProspect(p: Prospect) {
    this.prospects.set(p.id, p);
  }

  async recordActivity(e: ActivityEvent) {
    this.activity.push(e);
  }
  async listActivity(prospectId: string) {
    return this.activity
      .filter((e) => e.prospectId === prospectId)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
}

/** E.164-ish normalization so SMS webhooks match the stored prospect. */
export function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, "");
}

const singleton = new InMemoryCore();

/** The active platform repository. Swap the body for a Prisma impl in prod. */
export function getCore(): CoreRepository {
  return singleton;
}

/** Exposed for dev seeding + tests only. */
export function devCore(): InMemoryCore {
  return singleton;
}
