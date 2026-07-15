/**
 * RecruitersOS · LinkedIn OS
 * The native LinkedIn inbox: durable conversations per (account, person),
 * fed by webhook events and by the executor's own sends. Inbound messages
 * pause the person's automation IMMEDIATELY (before classification), then
 * the AI intent classification and routing run after.
 */

import { rid, nowIso } from "../../core/ids";
import { conversations } from "./store";
import type { BusinessUnit, LiConversation, LiMessage } from "./types";

export async function listConversations(workspaceId: string): Promise<LiConversation[]> {
  const all = await conversations.all();
  return all
    .filter((c) => c.workspaceId === workspaceId)
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
}

export async function getConversation(workspaceId: string, id: string): Promise<LiConversation | null> {
  const all = await conversations.all();
  return all.find((c) => c.workspaceId === workspaceId && c.id === id) ?? null;
}

export interface EnsureConversationInput {
  workspaceId: string;
  accountId: string;
  personIdentityId: string;
  displayName: string;
  headline?: string;
  company?: string;
  businessUnit?: BusinessUnit;
  campaignId?: string;
  providerChatId?: string;
  providerProfileId?: string;
}

export async function ensureConversation(input: EnsureConversationInput): Promise<LiConversation> {
  const all = await conversations.all();
  let c = all.find((x) =>
    x.workspaceId === input.workspaceId &&
    x.accountId === input.accountId &&
    x.personIdentityId === input.personIdentityId);
  if (!c) {
    c = {
      id: rid("lichat"),
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      personIdentityId: input.personIdentityId,
      providerChatId: input.providerChatId,
      providerProfileId: input.providerProfileId,
      displayName: input.displayName,
      headline: input.headline,
      company: input.company,
      businessUnit: input.businessUnit,
      campaignId: input.campaignId,
      messages: [],
      unread: false,
      needsAttention: false,
      lastMessageAt: nowIso(),
      createdAt: nowIso(),
    };
    all.push(c);
    conversations.save();
  } else {
    if (input.providerChatId && !c.providerChatId) c.providerChatId = input.providerChatId;
    if (input.providerProfileId && !c.providerProfileId) c.providerProfileId = input.providerProfileId;
    if (input.campaignId && !c.campaignId) c.campaignId = input.campaignId;
    if (input.businessUnit && !c.businessUnit) c.businessUnit = input.businessUnit;
  }
  return c;
}

export interface AddMessageInput {
  conversation: LiConversation;
  fromSelf: boolean;
  kind?: LiMessage["kind"];
  text?: string;
  audioUrl?: string;
  providerMessageId?: string;
  at?: string;
}

/** Append a message. Idempotent on providerMessageId. Returns null if seen. */
export function addMessage(input: AddMessageInput): LiMessage | null {
  const c = input.conversation;
  if (input.providerMessageId &&
      c.messages.some((m) => m.providerMessageId === input.providerMessageId)) {
    return null; // duplicate webhook delivery
  }
  const m: LiMessage = {
    id: rid("limsg"),
    providerMessageId: input.providerMessageId,
    fromSelf: input.fromSelf,
    kind: input.kind ?? "text",
    text: input.text,
    audioUrl: input.audioUrl,
    at: input.at ?? nowIso(),
  };
  c.messages.push(m);
  if (c.messages.length > 500) c.messages.splice(0, c.messages.length - 500);
  c.lastMessageAt = m.at;
  if (!input.fromSelf) {
    c.unread = true;
    c.needsAttention = true;
  }
  conversations.save();
  return m;
}

/** AI intent classification for an inbound message (best-effort, editable). */
export async function classifyConversation(c: LiConversation, latestText: string): Promise<void> {
  try {
    const { classifyReply } = await import("../classify");
    const r = await classifyReply(latestText);
    c.intent = r.intent;
    c.intentConfidence = r.confidence;
    conversations.save();
  } catch { /* classification is additive; the pause already happened */ }
}

export async function setIntent(
  workspaceId: string,
  conversationId: string,
  intent: string,
  by?: string,
): Promise<LiConversation | null> {
  const c = await getConversation(workspaceId, conversationId);
  if (!c) return null;
  c.intent = intent;
  c.intentEditedBy = by;
  conversations.save();
  return c;
}

export async function markRead(workspaceId: string, conversationId: string): Promise<void> {
  const c = await getConversation(workspaceId, conversationId);
  if (!c) return;
  c.unread = false;
  c.needsAttention = false;
  conversations.save();
}
