/**
 * RecruitersOS · LinkedIn OS
 * Provider event ingestion: raw webhook payloads are stored, normalized into
 * domain events, then consumed. The pause happens FIRST on an inbound
 * message; classification and routing happen after, so a slow LLM can never
 * delay the stop.
 *
 *   UNIPILE WEBHOOK -> validate -> store raw -> normalize -> domain event ->
 *   consumers (reply stop, inbox, enrollment accept-gates, account health)
 */

import { rid, nowIso } from "../../core/ids";
import { enrollments, rawEvents } from "./store";
import {
  findIdentityByProviderProfile, markConnected, resolveIdentity,
} from "./identity";
import { globalReplyStop } from "./outreachState";
import { ensureConversation, addMessage, classifyConversation } from "./inbox";
import { ensureAccount, recordResult, setHealth } from "./health";
import type { LiDomainEvent, LiDomainEventType } from "./types";

/** Persist the raw provider payload (capped ring buffer) for debugging/audit. */
export async function storeRawEvent(source: string, payload: unknown, workspaceId?: string): Promise<void> {
  const all = await rawEvents.all();
  all.push({ id: rid("liraw"), workspaceId, source, receivedAt: nowIso(), payload });
  rawEvents.save();
}

/** Normalize a raw Unipile-style webhook body into domain events. */
export function normalizeProviderEvent(payload: Record<string, unknown>, workspaceId: string): LiDomainEvent[] {
  const p = payload as Record<string, any>;
  const type = String(p.type ?? p.event ?? "").toLowerCase();
  const accountId = String(p.account_id ?? p.accountId ?? "");
  const at = String(p.timestamp ?? p.at ?? nowIso());
  const out: LiDomainEvent[] = [];
  const mk = (t: LiDomainEventType, extra: Partial<LiDomainEvent> = {}): LiDomainEvent => ({
    id: rid("lievt"), type: t, workspaceId, accountId, at, ...extra,
  });

  if (type.includes("new_relation") || type.includes("invitation_accepted") || type.includes("relation")) {
    out.push(mk("linkedin.connection.accepted", {
      providerProfileId: String(p.user_provider_id ?? p.provider_id ?? p.from ?? ""),
    }));
  } else if (type.includes("message_received") || type === "new_message" || type.includes("message")) {
    const fromSelf = Boolean(p.is_sender ?? p.from_self ?? false);
    out.push(mk(fromSelf ? "linkedin.message.sent" : "linkedin.message.received", {
      providerProfileId: String(p.sender_provider_id ?? p.provider_id ?? p.attendee_provider_id ?? p.from ?? ""),
      providerMessageId: String(p.message_id ?? p.id ?? ""),
      text: typeof p.message === "string" ? p.message : String(p.text ?? ""),
    }));
  } else if (type.includes("chat")) {
    out.push(mk("linkedin.chat.created", {
      providerProfileId: String(p.attendee_provider_id ?? p.provider_id ?? ""),
    }));
  } else if (type.includes("account")) {
    const status = String(p.status ?? "").toUpperCase();
    if (status === "OK" || type.includes("connected")) {
      out.push(mk("linkedin.account.connected"));
    } else if (status === "CREDENTIALS" || status === "ERROR" || type.includes("disconnect")) {
      out.push(mk("linkedin.account.disconnected"));
    }
  } else if (type.includes("failed") || type.includes("error")) {
    out.push(mk("linkedin.action.failed", { text: String(p.reason ?? p.error ?? "") }));
  }
  return out;
}

/** Consume one domain event: the workflow/campaign side effects. */
export async function handleDomainEvent(e: LiDomainEvent): Promise<void> {
  switch (e.type) {
    case "linkedin.message.received": {
      // Identity: known profile, else create a shell identity for the sender.
      let identity = e.providerProfileId
        ? await findIdentityByProviderProfile(e.workspaceId, e.providerProfileId)
        : null;
      if (!identity && e.providerProfileId) {
        identity = await resolveIdentity(e.workspaceId, {
          providerProfileId: e.providerProfileId,
          fullName: undefined,
        });
      }
      if (!identity) return;

      // PAUSE FIRST: cancel future actions, release capacity, stop enrollments.
      await globalReplyStop(e.workspaceId, identity.id, "linkedin");

      // Then persist + classify the message.
      const convo = await ensureConversation({
        workspaceId: e.workspaceId,
        accountId: e.accountId ?? "",
        personIdentityId: identity.id,
        displayName: identity.fullName ?? "LinkedIn contact",
        headline: identity.title,
        company: identity.company,
        providerProfileId: e.providerProfileId,
      });
      const added = addMessage({
        conversation: convo,
        fromSelf: false,
        text: e.text,
        providerMessageId: e.providerMessageId,
        at: e.at,
      });
      if (added && e.text) await classifyConversation(convo, e.text);
      break;
    }

    case "linkedin.message.sent": {
      if (!e.providerProfileId) return;
      const identity = await findIdentityByProviderProfile(e.workspaceId, e.providerProfileId);
      if (!identity) return;
      const convo = await ensureConversation({
        workspaceId: e.workspaceId,
        accountId: e.accountId ?? "",
        personIdentityId: identity.id,
        displayName: identity.fullName ?? "LinkedIn contact",
        providerProfileId: e.providerProfileId,
      });
      addMessage({
        conversation: convo,
        fromSelf: true,
        text: e.text,
        providerMessageId: e.providerMessageId,
        at: e.at,
      });
      break;
    }

    case "linkedin.connection.accepted": {
      if (!e.providerProfileId) return;
      const identity = await findIdentityByProviderProfile(e.workspaceId, e.providerProfileId);
      if (!identity) return;
      await markConnected(e.workspaceId, identity.id, e.at);
      // Release every enrollment gated on wait_until_accepted for this person.
      const all = await enrollments.all();
      let touched = false;
      for (const en of all) {
        if (en.workspaceId !== e.workspaceId || en.personIdentityId !== identity.id) continue;
        en.connectedAt = e.at;
        if (en.status === "waiting_accept") {
          en.status = "active";
          en.nextRunAt = nowIso();
          en.lastEventAt = nowIso();
        }
        touched = true;
      }
      if (touched) enrollments.save();
      break;
    }

    case "linkedin.account.connected": {
      if (!e.accountId) return;
      await ensureAccount(e.workspaceId, e.accountId, { connected: true });
      await setHealth(e.workspaceId, e.accountId, "healthy", "Account connected");
      break;
    }

    case "linkedin.account.disconnected": {
      if (!e.accountId) return;
      const a = await ensureAccount(e.workspaceId, e.accountId);
      a.connected = false;
      await setHealth(e.workspaceId, e.accountId, "disconnected", "Provider reported the account disconnected");
      break;
    }

    case "linkedin.action.failed": {
      if (!e.accountId) return;
      await recordResult(e.workspaceId, e.accountId, false, "provider_event", e.text || "provider reported a failed action");
      break;
    }

    case "linkedin.chat.created":
      break;
  }
}

/** The full ingest path the webhook route calls. */
export async function ingestProviderWebhook(
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<{ events: number }> {
  await storeRawEvent("unipile", payload, workspaceId);
  const events = normalizeProviderEvent(payload, workspaceId);
  for (const e of events) {
    try { await handleDomainEvent(e); } catch { /* one event must not block the rest */ }
  }
  return { events: events.length };
}
