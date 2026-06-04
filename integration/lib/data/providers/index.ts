/**
 * RecruiterOS · Data providers registry
 * One place to discover available providers and resolve one by id.
 */

import type { DataProvider } from "./types";
import { zoomInfoProvider } from "./zoominfo";

export type { DataProvider, ProviderSearchQuery } from "./types";
export { ProviderNotConfigured } from "./types";

const PROVIDERS: DataProvider[] = [zoomInfoProvider];

export function listProviders(): DataProvider[] {
  return PROVIDERS;
}

export function getProvider(id: string): DataProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Lightweight status for the Data tab: which providers are live vs. dormant. */
export function providerStatus(): Array<{ id: string; label: string; configured: boolean }> {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label, configured: p.configured() }));
}
