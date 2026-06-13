/**
 * RecruitersOS · Data providers
 * The seam between the warehouse and an external people-data source.
 *
 * Every ingestion path normalizes to DataRecordInput, so the warehouse, the Data
 * tab, and campaign enrichment never know or care where a record came from. CSV
 * import (today) and the official ZoomInfo API (when a key lands) are just two
 * implementations of this one contract.
 */

import type { DataRecordInput } from "../types";

export interface ProviderSearchQuery {
  q?: string;
  title?: string;
  company?: string;
  companyDomain?: string;
  location?: string;
  limit?: number;
}

export interface DataProvider {
  /** Stable id, e.g. "zoominfo". */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** True only when credentials are present AND the adapter is implemented. */
  configured(): boolean;
  /**
   * Programmatic pull from the provider's OFFICIAL, licensed API. Returns
   * normalized records ready to upsert. Throws { status, message } when the
   * provider isn't configured — never silently returns empty.
   */
  search(query: ProviderSearchQuery): Promise<DataRecordInput[]>;
}

/** Raised by adapters when called without working credentials. */
export class ProviderNotConfigured extends Error {
  status = 503;
  constructor(public providerId: string, detail?: string) {
    super(detail || `${providerId} is not configured`);
    this.name = "ProviderNotConfigured";
  }
}
