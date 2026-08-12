/**
 * RecruitersOS · Response · reply identity.
 *
 * Replies from the reply center go out FROM the mailbox that received the
 * person's email, so whoever is logged in (usually the admin working the whole
 * team's list) automatically wears the owning recruiter's identity. This
 * resolves that identity so the From line, the AI draft's sign-off, and the
 * composer label all agree on who the reply is from.
 */

import type { ProcessedResponse } from "./types";

export interface SendAsIdentity {
  /** The recruiter who owns the sending mailbox (null when the box is untracked). */
  name: string | null;
  /** The mailbox the reply sends from. */
  email: string;
}

/** The identity a reply on this row goes out under. Same anchor rule as the
 *  send path: this row's receiving mailbox if it is an email with one, else
 *  the newest email in the person's thread that has one. */
export async function sendAsFor(ws: string, resp: ProcessedResponse): Promise<SendAsIdentity | null> {
  const inb = resp.inbound;
  let mailbox = inb.channel === "email" && inb.toMailbox ? inb.toMailbox : undefined;
  if (!mailbox) {
    const { getInbox } = await import("./repository");
    const rows = await getInbox().forPerson(ws, { prospectId: inb.prospectId, handles: [inb.fromHandle] });
    mailbox = rows
      .filter((r) => r.inbound.channel === "email" && r.inbound.toMailbox)
      .sort((a, b) => Date.parse(b.inbound.receivedAt) - Date.parse(a.inbound.receivedAt))[0]?.inbound.toMailbox ?? undefined;
  }
  if (!mailbox) return null;
  return { name: await ownerOfMailbox(ws, mailbox), email: mailbox };
}

/** The recruiter name behind one mailbox (owner if assigned, else the From display name). */
export async function ownerOfMailbox(ws: string, mailbox: string): Promise<string | null> {
  try {
    const { findInboxByEmail } = await import("../senders");
    const box = await findInboxByEmail(ws, mailbox);
    return box?.ownerName || box?.displayName || null;
  } catch {
    return null;
  }
}
