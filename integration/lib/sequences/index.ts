/**
 * RecruiterOS · Sequences
 *
 * A sequence is the *message content* for one channel — the ordered touches a
 * customer authors under Campaigns (Email / LinkedIn / SMS). It is deliberately
 * separate from a deployed campaign: sequences hold only the steps and their
 * copy; assigning a prospect list and deploying happens in Campaign Studio.
 *
 * Per-workspace, in-memory reference store (swap for Prisma at the seam),
 * mirroring the rest of the engine.
 */

import { rid, nowIso } from "../core/ids";
import type { Motion } from "../core/types";

export type SeqChannel = "email" | "linkedin" | "sms";

export type LinkedInAction = "connect" | "message" | "inmail" | "voice_note";

export interface SequenceStep {
  id: string;
  /** Days to wait after the previous step (0 on the first step = enroll day). */
  day: number;
  /** Email touch. */
  subject?: string;
  body?: string;
  /** Email: queue as a manual task instead of auto-sending. */
  manualSend?: boolean;
  /** Email: track opens & clicks. */
  tracking?: boolean;
  /** LinkedIn touch. */
  action?: LinkedInAction;
  /** Message text — used by linkedin (message/inmail/voice-note) + sms. */
  text?: string;
}

/** A reusable merge token the customer defines, e.g. {{custom_variable1}}. */
export interface CustomVariable {
  key: string;   // custom_variable1
  label: string; // "Simple Job Lead Title"
}

export type SequenceStatus = "active" | "inactive";

export interface Sequence {
  id: string;
  workspaceId: string;
  channel: SeqChannel;
  name: string;
  motion: Motion;
  /** Display owner (creator's name) — shown in the Sequences Library. */
  owner?: string;
  /** Active = enrolling/usable; inactive = draft. */
  status: SequenceStatus;
  steps: SequenceStep[];
  tags: string[];
  variables: CustomVariable[];
  createdAt: string;
  updatedAt: string;
}

const store: Sequence[] = [];

export function listSequences(workspaceId: string, motion?: Motion): Sequence[] {
  return store
    .filter((s) => s.workspaceId === workspaceId && (!motion || s.motion === motion))
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}

export function getSequence(workspaceId: string, id: string): Sequence | undefined {
  return store.find((s) => s.id === id && s.workspaceId === workspaceId);
}

export interface SequenceInput {
  id?: string;
  channel: SeqChannel;
  name: string;
  motion?: Motion;
  owner?: string;
  status?: SequenceStatus;
  steps?: Partial<SequenceStep>[];
  tags?: string[];
  variables?: CustomVariable[];
}

function normSteps(steps?: Partial<SequenceStep>[]): SequenceStep[] {
  return (steps ?? []).map((s) => ({
    id: s.id || rid("step"),
    day: Number.isFinite(s.day as number) ? Math.max(0, Math.round(s.day as number)) : 0,
    subject: s.subject,
    body: s.body,
    manualSend: s.manualSend,
    tracking: s.tracking,
    action: s.action,
    text: s.text,
  }));
}

/** Create or update a sequence, normalizing steps and stamping ids/timestamps. */
export function upsertSequence(workspaceId: string, input: SequenceInput): Sequence {
  const channel: SeqChannel = ["email", "linkedin", "sms"].includes(input.channel) ? input.channel : "email";
  const steps = normSteps(input.steps);
  const tags = (input.tags ?? []).filter(Boolean).slice(0, 10);
  const variables = (input.variables ?? []).filter((v) => v && v.key);

  const status: SequenceStatus = input.status === "active" ? "active" : "inactive";

  const existing = input.id ? getSequence(workspaceId, input.id) : undefined;
  if (existing) {
    existing.name = input.name || existing.name;
    existing.channel = channel;
    existing.steps = steps;
    existing.tags = tags;
    existing.variables = variables;
    if (input.motion) existing.motion = input.motion;
    if (input.owner) existing.owner = input.owner;
    if (input.status) existing.status = status;
    existing.updatedAt = nowIso();
    return existing;
  }

  const seq: Sequence = {
    id: input.id || rid("seq"),
    workspaceId,
    channel,
    name: input.name || "Untitled sequence",
    motion: input.motion === "bd" ? "bd" : "recruiting",
    owner: input.owner,
    status,
    steps,
    tags,
    variables,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.push(seq);
  return seq;
}

export function deleteSequence(workspaceId: string, id: string): boolean {
  const i = store.findIndex((s) => s.id === id && s.workspaceId === workspaceId);
  if (i < 0) return false;
  store.splice(i, 1);
  return true;
}

/** Hard-reset hook: drop every sequence for a workspace. Returns count removed. */
export function purgeWorkspaceSequences(workspaceId: string): number {
  let n = 0;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].workspaceId === workspaceId) { store.splice(i, 1); n++; }
  }
  return n;
}
