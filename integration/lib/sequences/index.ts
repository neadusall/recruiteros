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

/** A single touch channel. "multi" is reserved for the *sequence* (see below) —
 *  a step itself is always one concrete channel. */
export type SeqChannel = "email" | "linkedin" | "sms" | "voice" | "multi";

export type LinkedInAction = "connect" | "message" | "inmail" | "voice_note";

export interface SequenceStep {
  id: string;
  /** Days to wait after the previous step (0 on the first step = enroll day). */
  day: number;
  /** The channel this step runs on. Optional for single-channel sequences (it
   *  inherits the sequence's channel); REQUIRED in a "multi" sequence, where
   *  each step picks its own channel (email / linkedin / sms / voice). */
  channel?: Exclude<SeqChannel, "multi">;
  /** Email touch. */
  subject?: string;
  body?: string;
  /** Email: queue as a manual task instead of auto-sending. */
  manualSend?: boolean;
  /** Email: track opens & clicks. */
  tracking?: boolean;
  /** LinkedIn touch. */
  action?: LinkedInAction;
  /** Message text — used by linkedin (message/inmail/voice-note) + sms + voice. */
  text?: string;
  /** Voice drop touch: a reusable Voice Drops script id (lib/voice scripts). The
   *  templated voicemail ({first_name}/{role}) rendered in the cloned voice. */
  voiceScriptId?: string;
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
  /** "multi" = a single cross-channel cadence whose steps mix email / LinkedIn /
   *  voicemail-drop touches (each step carries its own `channel`). */
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

const STEP_CHANNELS: SeqChannel[] = ["email", "linkedin", "sms", "voice"];

function normSteps(steps?: Partial<SequenceStep>[]): SequenceStep[] {
  return (steps ?? []).map((s) => ({
    id: s.id || rid("step"),
    day: Number.isFinite(s.day as number) ? Math.max(0, Math.round(s.day as number)) : 0,
    channel: STEP_CHANNELS.includes(s.channel as SeqChannel) ? s.channel : undefined,
    subject: s.subject,
    body: s.body,
    manualSend: s.manualSend,
    tracking: s.tracking,
    action: s.action,
    text: s.text,
    voiceScriptId: s.voiceScriptId,
  }));
}

const SEQ_CHANNELS: SeqChannel[] = ["email", "linkedin", "sms", "voice", "multi"];

/** Create or update a sequence, normalizing steps and stamping ids/timestamps. */
export function upsertSequence(workspaceId: string, input: SequenceInput): Sequence {
  const channel: SeqChannel = SEQ_CHANNELS.includes(input.channel) ? input.channel : "email";
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
