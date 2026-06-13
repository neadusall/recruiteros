/**
 * RecruitersOS · Data warehouse
 * Public barrel. Import from here, not individual files.
 *
 *   import { listRecords, upsertRecords, rowsToInputs, enrichRecord } from "@/integration/lib/data";
 */

export type { DataRecord, DataRecordInput, DataQuery, DataSource, ContactStatus } from "./types";

export {
  listRecords,
  getRecord,
  upsertRecords,
  saveRecord,
  deleteRecords,
  deleteByProviderId,
  findRecordForPerson,
  stats,
  purgeWorkspaceData,
} from "./store";

export { rowsToInputs, guessField, FIELD_KEYS } from "./import";
export type { ImportOptions } from "./import";

export { enrichRecord, backfillFromWarehouse } from "./enrich";

export { listProviders, getProvider, providerStatus, ProviderNotConfigured } from "./providers";
export type { DataProvider, ProviderSearchQuery } from "./providers";
