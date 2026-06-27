/**
 * RecruitersOS · Senders
 * Public barrel for recruiter-owned SMTP inbox pools (bring-your-own-SMTP sending,
 * rotated per recruiter, scoped per portal). Import from here.
 */

export type { SenderInbox, SenderInboxPublic, SenderProvider, SenderStatus, RecruiterPool } from "./types";

export {
  ready, persist, toPublic,
  listInboxes, getInbox, findInboxByEmail, addInbox, saveInbox, deleteInbox,
  assignOwner, setStatus, recruiterPools, stats, recordSend, resetDaily, listSenderWorkspaceIds,
} from "./store";
export type { NewInboxInput } from "./store";

export { pickSender, poolCapacity } from "./pool";

export { sendViaInbox, verifyInbox } from "./smtp";
export type { SmtpMessage, SmtpResult } from "./smtp";

export { parseCsv, detectColumns, rowsToInboxes } from "./csv";
export type { ColumnMap, MapRowsResult } from "./csv";

export { encryptionConfigured } from "./crypto";
