/**
 * RecruitersOS · LinkedIn Engine
 * Repository: persistence boundary for the engine.
 *
 * Ships with an in-memory reference implementation so the engine runs end to
 * end out of the box. In production, implement `Repository` against your store
 * (Prisma/Postgres) and return it from `getRepository()`.
 *
 * Mapping guide (RecruitersOS core -> engine):
 *   Campaign.prospects  -> Prospect
 *   Campaign.sequence   -> Sequence (+ SequenceStep)
 *   ConnectedAccount    -> LinkedInAccount
 *   LinkedInEnrollment  -> Enrollment
 *   ActivityLog         -> EngineEvent
 */

import type { Repository, EngineEvent } from "./sequenceEngine";
import type { Enrollment, LinkedInAccount, Prospect, Sequence } from "./types";

class InMemoryRepository implements Repository {
  enrollments = new Map<string, Enrollment>();
  prospects = new Map<string, Prospect>();
  sequences = new Map<string, Sequence>();
  accounts = new Map<string, LinkedInAccount>();
  events: EngineEvent[] = [];

  async getEnrollment(id: string) {
    return this.enrollments.get(id) ?? null;
  }
  async getDueEnrollments(nowIso: string, limit: number) {
    const now = Date.parse(nowIso);
    return [...this.enrollments.values()]
      .filter((e) => e.status === "active" && e.nextRunAt !== null && Date.parse(e.nextRunAt) <= now)
      .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
      .slice(0, limit);
  }
  async getEnrollmentByProspectAccount(providerProfileId: string, accountId: string) {
    for (const e of this.enrollments.values()) {
      const p = this.prospects.get(e.prospectId);
      if (e.accountId === accountId && p?.providerProfileId === providerProfileId) return e;
    }
    return null;
  }
  async saveEnrollment(e: Enrollment) {
    this.enrollments.set(e.id, e);
  }
  async getProspect(id: string) {
    return this.prospects.get(id) ?? null;
  }
  async saveProspect(p: Prospect) {
    this.prospects.set(p.id, p);
  }
  async getSequence(id: string) {
    return this.sequences.get(id) ?? null;
  }
  async getAccount(id: string) {
    return this.accounts.get(id) ?? null;
  }
  async recordEvent(e: EngineEvent) {
    this.events.push(e);
  }

  // convenience seeders used by enroll/actions routes in dev
  upsertProspect(p: Prospect) { this.prospects.set(p.id, p); }
  upsertSequence(s: Sequence) { this.sequences.set(s.id, s); }
  upsertAccount(a: LinkedInAccount) { this.accounts.set(a.id, a); }
}

const singleton = new InMemoryRepository();

/**
 * Return the active repository. Replace the body with your Prisma-backed
 * implementation in production, e.g. `return new PrismaRepository(prisma)`.
 */
export function getRepository(): Repository {
  return singleton;
}

/** Exposed for dev seeding / tests only. */
export function devStore(): InMemoryRepository {
  return singleton;
}
