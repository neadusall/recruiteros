/**
 * RecruiterOS · Warm-up seed client (IMAP + SMTP)
 * The hands at the real-provider inboxes. For each warm-up thread we sent from a
 * warming mailbox to a Gmail/Outlook/Yahoo seed, this connects to that seed over
 * IMAP and performs the reputation-building actions there:
 *   1. if our message landed in Spam/Junk -> move it to Inbox (the "not spam" signal),
 *   2. mark it read (the "open" signal),
 *   3. when due, reply from the seed over SMTP (the strongest positive signal),
 *      threaded to our Message-ID so it looks like a real conversation.
 *
 * These actions happen AT the provider whose trust we are building — which is the
 * whole point (a self-loop among our own MTA mailboxes teaches Gmail nothing).
 *
 * Everything degrades gracefully: a seed with no IMAP creds is skipped, an IMAP
 * error on one seed never throws out of the round.
 */

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { SeedAccount, WarmupThread } from "./types";

interface Endpoint { host: string; port: number; secure: boolean }
interface ProviderCfg { imap: Endpoint; smtp: Endpoint }

/** Known provider IMAP/SMTP endpoints; "other" falls back to the seed's imapHost. */
const PROVIDERS: Record<string, ProviderCfg> = {
  gmail:   { imap: { host: "imap.gmail.com", port: 993, secure: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true } },
  outlook: { imap: { host: "outlook.office365.com", port: 993, secure: true }, smtp: { host: "smtp.office365.com", port: 587, secure: false } },
  yahoo:   { imap: { host: "imap.mail.yahoo.com", port: 993, secure: true }, smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true } },
};

function imapEndpoint(seed: SeedAccount): Endpoint | null {
  const p = PROVIDERS[seed.provider];
  if (p) return p.imap;
  if (seed.imapHost) return { host: seed.imapHost, port: 993, secure: true };
  return null;
}
function smtpEndpoint(seed: SeedAccount): Endpoint | null {
  const p = PROVIDERS[seed.provider];
  if (p) return p.smtp;
  if (seed.imapHost) return { host: seed.imapHost.replace(/^imap\./, "smtp."), port: 465, secure: true };
  return null;
}

/** A seed can be driven only if it has login creds and a resolvable IMAP host. */
export function seedDrivable(seed: SeedAccount): boolean {
  return !!(seed.imapUser && seed.imapPass && imapEndpoint(seed));
}

/** Short, human reply bodies — varied by index so they aren't identical strings. */
const REPLIES = [
  "Thanks for the note — this looks good. Let's pick it back up next week.",
  "Appreciate you sending this over. Makes sense to me, talk soon.",
  "Got it, thanks. Nothing else needed on my end right now.",
  "Sounds good — I'll keep an eye out. Thanks for flagging.",
  "Perfect, thank you. Circling back once I've had a look.",
];
function replyBody(seedId: string): string {
  let h = 0;
  for (let i = 0; i < seedId.length; i++) h = (h * 31 + seedId.charCodeAt(i)) >>> 0;
  return REPLIES[h % REPLIES.length];
}

export interface EngageResult {
  rescued: number;
  opened: number;
  replied: number;
  errors: number;
}

/**
 * Drive ALL of one seed's open warm-up threads in a single IMAP/SMTP session.
 * Mutates the passed WarmupThread records in place (caller persists them).
 * Reply timing is jittered: a thread is opened on one tick and only replied on a
 * later tick after `scheduledReplyAt`, so the seed never looks instant/botty.
 */
export async function engageSeed(seed: SeedAccount, threads: WarmupThread[]): Promise<EngageResult> {
  const out: EngageResult = { rescued: 0, opened: 0, replied: 0, errors: 0 };
  const ep = imapEndpoint(seed);
  if (!ep || !seed.imapUser || !seed.imapPass || threads.length === 0) return out;

  const client = new ImapFlow({ host: ep.host, port: ep.port, secure: ep.secure, auth: { user: seed.imapUser, pass: seed.imapPass }, logger: false });
  try {
    await client.connect();

    // Find the Junk/Spam folder by IMAP special-use, so it works across providers.
    let junkPath: string | undefined;
    try {
      for (const box of await client.list()) {
        if (((box as any).specialUse || "") === "\\Junk") { junkPath = box.path; break; }
      }
    } catch { /* no special-use; rescue step is skipped */ }

    for (const t of threads) {
      try {
        let foundInInbox = false;

        // 1) Rescue from Junk -> Inbox (the "not spam" action).
        if (junkPath) {
          const lock = await client.getMailboxLock(junkPath);
          try {
            const uids = await client.search({ subject: t.tag }, { uid: true });
            if (uids && uids.length) {
              await client.messageMove(uids, "INBOX", { uid: true });
              t.rescuedFromSpam = true; t.opened = true; t.status = "rescued"; out.rescued++;
            }
          } finally { lock.release(); }
        }

        // 2) Open (mark \Seen) in the Inbox.
        {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const uids = await client.search({ subject: t.tag }, { uid: true });
            if (uids && uids.length) {
              foundInInbox = true;
              await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
              if (t.status === "sent") { t.opened = true; t.status = "opened"; out.opened++; }
              else if (t.status === "rescued") { t.opened = true; }
            }
          } finally { lock.release(); }
        }

        // Schedule a natural reply once the message has been seen.
        if ((t.status === "opened" || t.status === "rescued") && !t.replied && !t.scheduledReplyAt && (foundInInbox || t.rescuedFromSpam)) {
          const delayMin = 20 + Math.floor(Math.random() * 100); // 20-120 min
          t.scheduledReplyAt = new Date(Date.now() + delayMin * 60_000).toISOString();
        }
      } catch { out.errors++; t.detail = "imap_action_failed"; }
    }
  } catch {
    out.errors++;
    return out; // connection failed: leave threads for the next tick
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }

  // 3) Replies that are due — sent over the seed's SMTP, threaded to our Message-ID.
  const due = threads.filter((t) => !t.replied && t.scheduledReplyAt && t.scheduledReplyAt <= new Date().toISOString() && (t.opened || t.rescuedFromSpam));
  const sep = smtpEndpoint(seed);
  if (due.length && sep && seed.imapUser && seed.imapPass) {
    const transport = nodemailer.createTransport({ host: sep.host, port: sep.port, secure: sep.secure, auth: { user: seed.imapUser, pass: seed.imapPass } });
    for (const t of due) {
      try {
        await transport.sendMail({
          from: seed.address,
          to: t.mailboxAddress,
          subject: "Re: " + t.subject,
          text: replyBody(seed.id),
          inReplyTo: t.messageId,
          references: t.messageId,
        });
        t.replied = true; t.status = "replied"; out.replied++;
      } catch { out.errors++; t.detail = "smtp_reply_failed"; }
    }
    transport.close();
  }

  return out;
}
