/**
 * RecruiterOS · LinkedIn Engine
 * Sequence / cadence engine.
 *
 * This is the brain. It pulls due enrollments, runs the next allowed step
 * through the rate limiter and provider, advances state, and reacts to inbound
 * webhook events (accept-triggered follow-ups, pause-on-reply).
 *
 * Persistence is injected via `Repository` so this drops onto whatever store
 * RecruiterOS already uses (Prisma, Postgres, etc.). The engine itself holds no
 * database dependency.
 */

import type {
  Enrollment,
  LinkedInAccount,
  LinkedInWebhookEvent,
  Prospect,
  Sequence,
  SequenceStep,
  ActionResult,
} from "./types";
import { getProvider, type LinkedInProvider } from "./provider";
import { gate, humanJitterMs } from "./rateLimiter";
import { generateMessage, pickVariant } from "./personalize";
import { classifyReply } from "./classify";

/** Everything the engine needs to read/write. Implement against your DB. */
export interface Repository {
  getEnrollment(id: string): Promise<Enrollment | null>;
  getDueEnrollments(nowIso: string, limit: number): Promise<Enrollment[]>;
  getEnrollmentByProspectAccount(providerProfileId: string, accountId: string): Promise<Enrollment | null>;
  saveEnrollment(e: Enrollment): Promise<void>;
  getProspect(id: string): Promise<Prospect | null>;
  /** Upsert the prospect snapshot the engine will personalize against. */
  saveProspect(p: Prospect): Promise<void>;
  getSequence(id: string): Promise<Sequence | null>;
  getAccount(id: string): Promise<LinkedInAccount | null>;
  /** Append an audit record (sent message, error, classification…). */
  recordEvent(e: EngineEvent): Promise<void>;
}

export interface EngineEvent {
  enrollmentId: string;
  prospectId: string;
  accountId: string;
  kind:
    | "step_sent"
    | "step_deferred"
    | "step_failed"
    | "invite_accepted"
    | "reply_received"
    | "reply_classified"
    | "sequence_completed"
    | "enrollment_paused"
    | "enrollment_stopped";
  stepOrder?: number;
  action?: SequenceStep["action"];
  rung?: SequenceStep["rung"];
  providerMessageId?: string;
  text?: string;
  meta?: Record<string, unknown>;
  at: string;
}

export class SequenceEngine {
  constructor(
    private repo: Repository,
    private provider: LinkedInProvider = getProvider(),
  ) {}

  /** Enroll a prospect into a sequence on a given account. */
  async enroll(prospect: Prospect, sequence: Sequence, account: LinkedInAccount): Promise<Enrollment> {
    const first = sortSteps(sequence.steps)[0];
    const enrollment: Enrollment = {
      id: `enr_${prospect.id}_${sequence.id}`,
      prospectId: prospect.id,
      sequenceId: sequence.id,
      accountId: account.id,
      status: "active",
      currentStepOrder: 0,
      // First step runs on the next tick (subject to working-hours gate).
      nextRunAt: new Date().toISOString(),
      connectedAt: prospect.connectionDegree === 1 ? new Date().toISOString() : null,
      lastEventAt: new Date().toISOString(),
    };
    void first; // first step resolved at run time
    await this.repo.saveEnrollment(enrollment);
    return enrollment;
  }

  /** Cron entrypoint: process a batch of due enrollments. */
  async tick(now = new Date(), batch = 50): Promise<{ processed: number }> {
    const due = await this.repo.getDueEnrollments(now.toISOString(), batch);
    let processed = 0;
    for (const e of due) {
      try {
        await this.runNextStep(e);
      } catch (err) {
        await this.repo.recordEvent({
          enrollmentId: e.id, prospectId: e.prospectId, accountId: e.accountId,
          kind: "step_failed", text: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        });
      }
      processed++;
    }
    return { processed };
  }

  /** Execute the next pending step for one enrollment. */
  async runNextStep(enrollment: Enrollment): Promise<ActionResult | null> {
    if (enrollment.status !== "active") return null;

    const [prospect, sequence, account] = await Promise.all([
      this.repo.getProspect(enrollment.prospectId),
      this.repo.getSequence(enrollment.sequenceId),
      this.repo.getAccount(enrollment.accountId),
    ]);
    if (!prospect || !sequence || !account) return null;

    const steps = sortSteps(sequence.steps);
    const step = steps.find((s) => s.order > enrollment.currentStepOrder);
    if (!step) return this.complete(enrollment);

    // Accept-triggered gating: hold follow-ups until the invite is accepted.
    if (step.requiresConnection && !enrollment.connectedAt) {
      // Re-check in 6h; the webhook will usually advance us sooner.
      await this.reschedule(enrollment, hoursFromNow(6));
      return null;
    }

    // Account-safety gate (caps, working hours, account health).
    const g = await gate(account, step.action);
    if (!g.allowed) {
      await this.repo.recordEvent({
        enrollmentId: enrollment.id, prospectId: prospect.id, accountId: account.id,
        kind: "step_deferred", stepOrder: step.order, action: step.action,
        meta: { reason: g.reason }, at: new Date().toISOString(),
      });
      await this.reschedule(enrollment, g.retryAt ?? hoursFromNow(2));
      return { ok: false, action: step.action, deferredUntil: g.retryAt };
    }

    const result = await this.execute(account, prospect, step);

    if (result.ok) {
      await this.repo.recordEvent({
        enrollmentId: enrollment.id, prospectId: prospect.id, accountId: account.id,
        kind: "step_sent", stepOrder: step.order, action: step.action, rung: step.rung,
        providerMessageId: result.providerMessageId, at: new Date().toISOString(),
      });
      enrollment.currentStepOrder = step.order;
      enrollment.lastEventAt = new Date().toISOString();
      const next = steps.find((s) => s.order > step.order);
      enrollment.nextRunAt = next
        ? hoursFromNow(next.delayHours, humanJitterMs())
        : null;
      enrollment.status = next ? "active" : "completed";
      await this.repo.saveEnrollment(enrollment);
      if (!next) {
        await this.repo.recordEvent({
          enrollmentId: enrollment.id, prospectId: prospect.id, accountId: account.id,
          kind: "sequence_completed", at: new Date().toISOString(),
        });
      }
    } else {
      await this.repo.recordEvent({
        enrollmentId: enrollment.id, prospectId: prospect.id, accountId: account.id,
        kind: "step_failed", stepOrder: step.order, action: step.action,
        text: result.error, at: new Date().toISOString(),
      });
      // Back off and retry once on the next window.
      await this.reschedule(enrollment, hoursFromNow(4));
    }
    return result;
  }

  /** Run the actual provider call for a step (generating copy as needed). */
  private async execute(account: LinkedInAccount, prospect: Prospect, step: SequenceStep): Promise<ActionResult> {
    switch (step.action) {
      case "profile_view":
        return this.provider.viewProfile(account, prospect.providerProfileId!);
      case "endorse":
        return this.provider.endorseTopSkills(account, prospect.providerProfileId!);
      case "withdraw_invite":
        return this.provider.withdrawInvite(account, prospect.providerProfileId!);
      case "connect": {
        const variant = pickVariant(step);
        const note = await generateMessage(prospect, step, variant?.template);
        return this.provider.sendConnection({ account, prospect, note: note.text });
      }
      case "message":
      case "voice_note": {
        const variant = pickVariant(step);
        const msg = await generateMessage(prospect, step, variant?.template);
        return this.provider.sendMessage({ account, prospect, text: msg.text });
      }
      case "inmail": {
        const variant = pickVariant(step);
        const msg = await generateMessage(prospect, step, variant?.template);
        return this.provider.sendInMail({
          account, prospect, text: msg.text, subject: msg.subject ?? `Quick note, ${prospect.firstName}`,
        });
      }
      default:
        return { ok: false, action: step.action, error: `Unknown action ${step.action}` };
    }
  }

  /** React to a normalized inbound provider event. */
  async handleEvent(event: LinkedInWebhookEvent): Promise<void> {
    if (event.type === "invite_accepted") {
      const e = await this.repo.getEnrollmentByProspectAccount(event.providerProfileId, event.accountId);
      if (!e) return;
      e.connectedAt = event.at;
      e.nextRunAt = new Date().toISOString(); // fire the accept-triggered follow-up now
      e.lastEventAt = event.at;
      await this.repo.saveEnrollment(e);
      await this.repo.recordEvent({
        enrollmentId: e.id, prospectId: e.prospectId, accountId: e.accountId,
        kind: "invite_accepted", at: event.at,
      });
      return;
    }

    if (event.type === "message_received") {
      const e = await this.repo.getEnrollmentByProspectAccount(event.providerProfileId, event.accountId);
      if (!e) return;
      await this.repo.recordEvent({
        enrollmentId: e.id, prospectId: e.prospectId, accountId: e.accountId,
        kind: "reply_received", text: event.text, providerMessageId: event.providerMessageId, at: event.at,
      });
      // Pause automation the instant a human replies.
      e.status = "paused_replied";
      e.nextRunAt = null;
      e.lastEventAt = event.at;
      await this.repo.saveEnrollment(e);

      const classified = await classifyReply(event.text);
      await this.repo.recordEvent({
        enrollmentId: e.id, prospectId: e.prospectId, accountId: e.accountId,
        kind: "reply_classified", text: classified.intent,
        meta: { ...classified }, at: new Date().toISOString(),
      });
      if (classified.intent === "stop") {
        e.status = "stopped";
        await this.repo.saveEnrollment(e);
        await this.repo.recordEvent({
          enrollmentId: e.id, prospectId: e.prospectId, accountId: e.accountId,
          kind: "enrollment_stopped", at: new Date().toISOString(),
        });
      }
      return;
    }
  }

  private async complete(enrollment: Enrollment): Promise<null> {
    enrollment.status = "completed";
    enrollment.nextRunAt = null;
    await this.repo.saveEnrollment(enrollment);
    return null;
  }

  private async reschedule(enrollment: Enrollment, atIso: string): Promise<void> {
    enrollment.nextRunAt = atIso;
    await this.repo.saveEnrollment(enrollment);
  }
}

/* helpers */
function sortSteps(steps: SequenceStep[]): SequenceStep[] {
  return [...steps].sort((a, b) => a.order - b.order);
}
function hoursFromNow(hours: number, extraMs = 0): string {
  return new Date(Date.now() + hours * 3_600_000 + extraMs).toISOString();
}
