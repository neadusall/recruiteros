/**
 * RecruitersOS · Senders
 * Public barrel for recruiter-owned SMTP inbox pools (bring-your-own-SMTP sending,
 * rotated per recruiter, scoped per portal). Import from here.
 */

export type { SenderInbox, SenderInboxPublic, SenderProvider, SenderStatus, RecruiterPool } from "./types";

export {
  ready, persist, toPublic,
  listInboxes, getInbox, findInboxByEmail, addInbox, saveInbox, deleteInbox,
  assignOwner, setStatus, recruiterPools, stats, recordSend, resetDaily, resetDailyIfNewDay, listSenderWorkspaceIds,
  sendCapacity,
} from "./store";
export type { NewInboxInput, RecruiterCapacity, SendCapacity } from "./store";

export { pickSender, poolCapacity } from "./pool";

export { COLD_PER_INBOX, WARMING_PER_INBOX, INBOXES_PER_DOMAIN, coldCap } from "./limits";

export { sendViaInbox, verifyInbox } from "./smtp";
export type { SmtpMessage, SmtpResult } from "./smtp";

export { parseCsv, detectColumns, rowsToInboxes } from "./csv";
export type { ColumnMap, MapRowsResult } from "./csv";

export { encryptionConfigured } from "./crypto";
