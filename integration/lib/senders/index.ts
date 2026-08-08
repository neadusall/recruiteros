/**
 * RecruitersOS · Senders
 * Public barrel for recruiter-owned SMTP inbox pools (bring-your-own-SMTP sending,
 * rotated per recruiter, scoped per portal). Import from here.
 */

export type { SenderInbox, SenderInboxPublic, SenderProvider, SenderStatus, RecruiterPool } from "./types";

export {
  ready, persist, toPublic,
  listInboxes, getInbox, findInboxByEmail, addInbox, saveInbox, deleteInbox,
  assignOwner, setStatus, recruiterPools, stats, recordSend, recordBounce, recordSendFailure, resetDaily, resetDailyIfNewDay, listSenderWorkspaceIds,
  sendCapacity,
} from "./store";
export type { NewInboxInput, RecruiterCapacity, SendCapacity } from "./store";

export { pickSender, poolCapacity, fleetDailyCapacity } from "./pool";

export { syncFleetInboxes, maybeAutoFleetSync } from "./fleetSync";
export type { FleetSyncReport } from "./fleetSync";

export { runSenderHealthGuard, guardStatus } from "./healthGuard";
export type { GuardReport, GuardAction } from "./healthGuard";

export { runReplySync } from "./replySync";
export type { ReplySyncReport } from "./replySync";

export { COLD_PER_INBOX, SENDING_AC_PER_INBOX, WARMING_PER_INBOX, INBOXES_PER_DOMAIN, coldCap, coldCapFor, coldMaxPerInbox, RAMP_BY_WEEK } from "./limits";

export { sendViaInbox, verifyInbox } from "./smtp";
export type { SmtpMessage, SmtpResult } from "./smtp";

export { parseCsv, detectColumns, rowsToInboxes } from "./csv";
export type { ColumnMap, MapRowsResult } from "./csv";

export { encryptionConfigured } from "./crypto";
