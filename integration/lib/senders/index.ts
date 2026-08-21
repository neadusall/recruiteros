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

export { fleetOverview } from "./fleets";
export type { FleetCard, FleetKey } from "./fleets";

export { coldCapacity, rampCap, COLD_LANE_NAMES } from "./coldLane";
export type { ColdCapacity, ColdLane, RampCap } from "./coldLane";

export { runOutlookWatch } from "./outlookWatch";
export type { OutlookWatchReport } from "./outlookWatch";
export { OUTLOOK_LEDGER_KEY, buildOutlook, foldOutlook, pruneOutlook, ledgerKey, outlookGraceH } from "./outlook";
export type { OutlookStep, OutlookState, OutlookRecord, OutlookLedger, OutlookEvent } from "./outlook";

export { syncFleetInboxes, maybeAutoFleetSync, buildPortalRouter } from "./fleetSync";
export type { FleetSyncReport } from "./fleetSync";

export { syncSendingAcFleet, maybeAutoSendingAcSync } from "./sendingAcSync";
export type { SendingAcSyncReport } from "./sendingAcSync";
export { sendingAcConfigured, sendingAcIsSandbox, sendingAcKeyHint, pingSendingAc } from "./sendingAcApi";
export type { SendingAcPing } from "./sendingAcApi";

export { reconcileSenderCounters } from "./reconcile";
export type { ReconcileReport } from "./reconcile";

export { runSenderHealthGuard, guardStatus } from "./healthGuard";
export type { GuardReport, GuardAction } from "./healthGuard";

export {
  recordLedgerTick, ledgerFleet, ledgerIdentity, annotateEvent, causeCatalog, identityRef,
  LEDGER_KEY, LEDGER_EVENTS_KEY,
} from "./ledger";
export type { LedgerTickReport, LedgerFleet, LedgerRow, LedgerIdentityView, Lifetime } from "./ledger";
export { CAUSES, CAUSE_BY_CODE, SEVERITY_RANK } from "./ledgerTypes";
export type { Blocker, CauseDef, Category, DomainDay, LedgerEvent, MailboxDay, ShelfLife, Severity, IdentityKind } from "./ledgerTypes";

export { runReplySync } from "./replySync";
export type { ReplySyncReport } from "./replySync";

export { COLD_PER_INBOX, SENDING_AC_PER_INBOX, WARMING_PER_INBOX, INBOXES_PER_DOMAIN, coldCap, coldCapFor, coldMaxPerInbox, RAMP_BY_WEEK } from "./limits";

export { sendViaInbox, verifyInbox } from "./smtp";
export type { SmtpMessage, SmtpResult } from "./smtp";

export {
  mailboxApiConfigured, canSendViaMailboxApi, sendViaMailboxApi,
  listMailboxApiMessages, pingMailboxApi,
} from "./mailboxApi";
export type { MailboxApiMessage, MailboxApiPing } from "./mailboxApi";

export { parseCsv, detectColumns, rowsToInboxes } from "./csv";
export type { ColumnMap, MapRowsResult } from "./csv";

export { encryptionConfigured } from "./crypto";
