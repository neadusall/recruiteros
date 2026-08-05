/**
 * RecruitersOS · Senders · Reply sync (IMAP pull for OUR OWN inboxes)
 *
 * The webhook sources (Instantly / Unipile / OS Text) push replies to us; the
 * sender pool and owned MTA have no webhook, so replies to the main cold-email
 * volume used to be invisible: sequences kept mailing people who had answered,
 * nobody was notified, and stats showed nothing. This poller closes that loop:
 *
 *   for each pool inbox with IMAP credentials (stalest first, bounded batch):
 *     - read new INBOX mail past the stored UID high-water mark
 *     - DSN / mailer-daemon bounce  -> classify hard/soft, suppress the
 *       recipient, count the bounce on this inbox (feeds the health guard)
 *     - warm-up traffic            -> skip (X-ROS-Warmup / [rw...] tag)
 *     - real inbound               -> lib/response.processInbound("smtp", ...):
 *       match prospect -> classify (OOO-aware) -> route -> inbox feed; any
 *       HUMAN reply also fires the global reply-stop so every channel pauses.
 *
 * Driven by the scheduler's reply_sync tick + /api/sending/cron. Never throws.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { listInboxes, saveInbox, listSenderWorkspaceIds, recordBounce } from "./store";
import { decryptSecret } from "./crypto";
import type { SenderInbox } from "./types";

export interface ReplySyncReport {
  at: string;
  inboxesChecked: number;
  messagesSeen: number;
  repliesIngested: number;
  autoReplies: number;
  bouncesRecorded: number;
  errors: number;
}

function batchSize(): number {
  const n = Number(process.env.SENDER_REPLYSYNC_BATCH);
  return Number.isFinite(n) && n >= 1 && n <= 200 ? Math.floor(n) : 40;
}

const CONCURRENCY = 5;
const MAX_MSGS_PER_INBOX = 50;
const WARMUP_TAG = /\[rw[a-z0-9]{6,12}\]/i;

function hasImap(m: SenderInbox): boolean {
  if (!(m.imapHost || m.smtpHost)) return false;
  try {
    return decryptSecret(m.imapPassEnc || m.smtpPassEnc).length > 0;
  } catch {
    return false;
  }
}

function isBounceMail(fromAddr: string, contentType?: string): boolean {
  const f = fromAddr.toLowerCase();
  return (
    f.startsWith("mailer-daemon@") || f.startsWith("postmaster@") ||
    (contentType || "").toLowerCase().includes("multipart/report")
  );
}

/** Pull the failed recipient out of a DSN body/headers, best-effort. */
function bouncedRecipientOf(text: string, headers: Map<string, unknown>): string | null {
  const failedRecip = String(headers.get("x-failed-recipients") || "");
  if (/@/.test(failedRecip)) return failedRecip.trim().toLowerCase();
  const m =
    text.match(/Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>;]+)/i) ||
    text.match(/Original-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>;]+)/i) ||
    text.match(/<([^\s<>]+@[^\s<>]+)>:?\s*(?:host|delivery|user|mailbox)/i) ||
    text.match(/(?:delivery to|could not be delivered to|failed for)\s*<?([^\s<>]+@[^\s<>]+)>?/i);
  return m ? m[1].toLowerCase() : null;
}

async function syncOneInbox(m: SenderInbox, report: ReplySyncReport): Promise<void> {
  const pass = decryptSecret(m.imapPassEnc || m.smtpPassEnc);
  const client = new ImapFlow({
    host: m.imapHost || m.smtpHost,
    port: m.imapPort || 993,
    secure: true,
    auth: { user: m.imapUser || m.smtpUser, pass },
    logger: false,
    socketTimeout: 30_000,
  });

  const startUid = m.replySyncUid || 0;
  let maxUid = startUid;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = client.mailbox;
      // First-ever sync: don't reprocess the whole mailbox history; start from now.
      if (!startUid && status && typeof status.uidNext === "number") {
        m.replySyncUid = Math.max(0, status.uidNext - 1);
        m.replySyncAt = new Date().toISOString();
        await saveInbox(m);
        return;
      }

      let handled = 0;
      for await (const msg of client.fetch(
        { uid: `${startUid + 1}:*` },
        { uid: true, envelope: true, source: true },
        { uid: true },
      )) {
        if (msg.uid <= startUid) continue; // servers echo the last seen uid
        maxUid = Math.max(maxUid, msg.uid);
        if (++handled > MAX_MSGS_PER_INBOX) break;
        report.messagesSeen++;

        let parsed;
        try {
          parsed = await simpleParser(msg.source as Buffer);
        } catch {
          continue;
        }
        const fromAddr = (parsed.from?.value?.[0]?.address || msg.envelope?.from?.[0]?.address || "").toLowerCase();
        if (!fromAddr) continue;
        // Our own mail looping back (warm-up partners, seed replies, self-BCC).
        if (fromAddr === m.email.toLowerCase()) continue;
        const subject = parsed.subject || msg.envelope?.subject || "";
        const headers = parsed.headers;

        // Warm-up traffic never enters the response pipeline.
        if (headers.get("x-ros-warmup") || WARMUP_TAG.test(subject)) continue;

        // DSN / bounce mail -> suppression + inbox bounce counter.
        const contentType = String(headers.get("content-type") || (parsed as any).headerLines?.find?.((h: any) => h.key === "content-type")?.line || "");
        if (isBounceMail(fromAddr, contentType)) {
          const text = `${parsed.text || ""}\n${parsed.html || ""}`;
          const recipient = bouncedRecipientOf(text, headers as any);
          if (recipient && recipient.split("@")[1] !== m.email.split("@")[1]) {
            const { classifyBounce } = await import("../sending/bounces");
            const severity = classifyBounce(text);
            const store = await import("../sending/store");
            await store.suppress(recipient, "bounce", "imap-dsn", { kind: severity });
            await recordBounce(m.workspaceId, m.id);
            report.bouncesRecorded++;
            // Park the prospect so the cadence stops retrying a dead address.
            try {
              const { getCore } = await import("../core/repository");
              const p = await getCore().findProspectByEmail(m.workspaceId, recipient);
              if (p && severity === "hard" && p.status !== "do_not_contact") {
                p.status = "do_not_contact";
                await getCore().saveProspect(p);
              }
            } catch { /* best-effort */ }
          }
          continue;
        }

        // A real inbound: run the full response pipeline (OOO-aware).
        const autoSubmitted =
          (!!headers.get("auto-submitted") && String(headers.get("auto-submitted")).toLowerCase() !== "no") ||
          !!headers.get("x-autoreply") || !!headers.get("x-autorespond") ||
          /^auto[_-]?repl/i.test(String(headers.get("precedence") || ""));
        try {
          const { processInbound } = await import("../response");
          const processed = await processInbound(
            "smtp",
            m.workspaceId,
            {
              messageId: parsed.messageId || `imap-${m.id}-${msg.uid}`,
              fromEmail: fromAddr,
              fromName: parsed.from?.value?.[0]?.name,
              text: (parsed.text || "").slice(0, 8000) || subject,
              receivedAt: (parsed.date || new Date()).toISOString(),
            },
            async (prospectId: string) => {
              const { replyStopByProspectId } = await import("../linkedin/os/outreachState");
              await replyStopByProspectId(m.workspaceId, prospectId, "email");
            },
            { autoSubmitted },
          );
          if (processed) {
            if (processed.classification.class === "auto_reply") {
              report.autoReplies++;
            } else {
              report.repliesIngested++;
              // Belt and braces (mirrors the webhook route): any HUMAN inbound
              // from a known prospect pauses their automation everywhere.
              if (processed.inbound.prospectId) {
                try {
                  const { replyStopByProspectId } = await import("../linkedin/os/outreachState");
                  await replyStopByProspectId(m.workspaceId, processed.inbound.prospectId, "email");
                } catch { /* idempotent + best-effort */ }
              }
            }
          }
        } catch { /* one bad message must not stop the sweep */ }
      }
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* connection may already be gone */ }
  }

  m.replySyncUid = maxUid;
  m.replySyncAt = new Date().toISOString();
  await saveInbox(m);
}

/** One reply-sync round across every sender workspace: the stalest IMAP-capable
 *  inboxes first, bounded to `batch`, small concurrency. Never throws. */
export async function runReplySync(opts: { batch?: number } = {}): Promise<ReplySyncReport> {
  const report: ReplySyncReport = {
    at: new Date().toISOString(),
    inboxesChecked: 0, messagesSeen: 0, repliesIngested: 0,
    autoReplies: 0, bouncesRecorded: 0, errors: 0,
  };
  const batch = opts.batch ?? batchSize();

  let candidates: SenderInbox[] = [];
  try {
    for (const ws of await listSenderWorkspaceIds()) {
      const pool = (await listInboxes(ws)).filter((m) => m.status !== "paused" && hasImap(m));
      candidates.push(...pool);
    }
  } catch {
    report.errors++;
    return report;
  }
  candidates = candidates
    .sort((a, b) => Date.parse(a.replySyncAt || "1970-01-01") - Date.parse(b.replySyncAt || "1970-01-01"))
    .slice(0, batch);

  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
      while (idx < candidates.length) {
        const m = candidates[idx++];
        try {
          await syncOneInbox(m, report);
          report.inboxesChecked++;
        } catch {
          report.errors++;
          try {
            m.replySyncAt = new Date().toISOString(); // don't head-of-line-block the rotation
            await saveInbox(m);
          } catch { /* ignore */ }
        }
      }
    }),
  );
  return report;
}
