/**
 * RecruitersOS · Response · MPC (Sending.ac / Graph) reply bridge.
 *
 * The unified inbox is fed by replySync, which pulls over IMAP. The MPC finance campaign sends
 * from Sending.ac mailboxes (Microsoft Graph, no IMAP password), so replySync can't see them and
 * their replies never reach the inbox. The MPC reply monitor DOES read those mailboxes over the
 * Graph Mailbox API, and it identity-matches every inbound to a real prospect we emailed (so
 * Smartlead warm-up traffic, which comes from other accounts, is excluded). It writes those
 * matched, warm-up-free replies to a /data snapshot; this tick feeds each through the SAME
 * processInbound pipeline as every other channel (normalize -> match -> classify -> store), so
 * they show up in the Replies inbox with a sentiment tag, scoped to the tenant workspace.
 *
 * Idempotent: processInbound dedupes on provider message id, so re-reading the queue each tick
 * never double-inserts.
 */

import { loadSnapshot } from "../db";
import { processInbound } from "./index";

const KEY = "mpc_reply_queue_v1";

interface MpcReplyRow {
  ws: string;
  fromEmail: string;
  messageId: string;
  text?: string;
  fromName?: string;
  receivedAt?: string;
}

export async function runMpcReplyIngest(): Promise<{ ingested: number; total: number }> {
  const rows = (await loadSnapshot<MpcReplyRow[]>(KEY)) || [];
  let ingested = 0;
  for (const r of rows) {
    if (!r || !r.ws || !r.fromEmail || !r.messageId) continue;
    try {
      await processInbound("smtp", r.ws, {
        fromEmail: r.fromEmail,
        messageId: r.messageId,
        fromName: r.fromName,
        text: r.text,
        receivedAt: r.receivedAt,
        campaignId: "mpc-finance", // identity-verified real reply (never warm-up)
      });
      ingested++;
    } catch { /* skip one bad row; the rest still ingest */ }
  }
  return { ingested, total: rows.length };
}
