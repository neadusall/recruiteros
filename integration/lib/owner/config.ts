/**
 * RecruiterOS · Owner · Cost config (OWNER ONLY)
 *
 * Runtime overrides for the cost model so the owner can tune rates and the
 * pricing constants (sequence length, sends/inbox, target margin, ...) from the
 * console without a redeploy. Empty by default -> the shipped DEFAULT_RATES /
 * DEFAULT_CONSTANTS are used verbatim.
 */

import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { PricingConstants } from "../billing/rates";

interface CostConfig {
  /** rateId -> unitCostUsd override. */
  rateOverrides: Record<string, number>;
  /** Partial override of the pricing constants. */
  constants: Partial<PricingConstants>;
}

const store: { config: CostConfig } = { config: { rateOverrides: {}, constants: {} } };

const SNAP_KEY = "owner_cost_config";
const persist = debouncedSaver(SNAP_KEY, () => store.config);

let hydrated: Promise<void> | null = null;
export function ensureCostConfigReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<CostConfig>(SNAP_KEY).then((c) => { if (c) store.config = { rateOverrides: c.rateOverrides || {}, constants: c.constants || {} }; }).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensureCostConfigReady();

export function getCostConfig(): CostConfig {
  return { rateOverrides: { ...store.config.rateOverrides }, constants: { ...store.config.constants } };
}

export function updateCostConfig(patch: { rateOverrides?: Record<string, number>; constants?: Partial<PricingConstants> }): CostConfig {
  if (patch.rateOverrides) {
    for (const [k, v] of Object.entries(patch.rateOverrides)) {
      if (v === null || Number.isNaN(Number(v))) delete store.config.rateOverrides[k];
      else store.config.rateOverrides[k] = Number(v);
    }
  }
  if (patch.constants) {
    store.config.constants = { ...store.config.constants, ...patch.constants };
  }
  persist();
  return getCostConfig();
}
