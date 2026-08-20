/**
 * RecruitersOS · Phone Intelligence
 *
 * Automated Business IVR Discovery & Contact Verification Engine.
 * Learns each company's phone tree once, caches the route, and reuses it to
 * reach (and verify) future prospects — the Corporate Telephone Routing Graph.
 *
 * Public surface. The live-call trigger (startCall) is exposed for the
 * admin-gated API route and the batch runner; everything else is read/query.
 */

export { startCall, handleIntelEvent } from "./orchestrator";
export { runBatch, groupByCompany } from "./batch";
export { startQueueRun, stopQueueRun, queueRunState } from "./runner";
export {
  pullRoleVoicemailsFromPipeline, enqueueRoleVoicemail, assembleRoleVoicemail,
  roleForProspect, wasEmailed, corporateNumber, roleVoicemailOnSendEnabled,
  phoneReachabilityStats, classifyPipelinePhones,
  DEFAULT_ROLE_VM_TEMPLATE, type PullSummary, type PhoneReachabilityStats, type ClassifyBatchResult,
} from "./roleVoicemail";
export { planIvrMove, alternateDirectorySpec, type IvrMove, type NavTarget } from "./navigation";
export { aiPlanMove, mapAiAction } from "./aiNavigator";
export { preCallCheck, mayRecordHuman, VELOCITY } from "./compliance";
export {
  ensureIntelReady, companyKeyOf, listProfiles, getProfile, activeRoute,
  listCalls, getCall, listVerifications, dashboard,
} from "./store";
export type {
  CompanyPhoneProfile, IvrRoute, IvrNode, IntelCall, ContactVerification,
  Disposition, SuccessType, AnswerClass, CallState,
} from "./types";
