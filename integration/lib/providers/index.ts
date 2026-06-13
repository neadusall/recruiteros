/**
 * RecruitersOS · Providers · Registry
 * Single place every module reaches integrations through. Lazily instantiated
 * singletons, a status map for the Connected tab, and verifyAll for "Test all".
 *
 * Provider id <-> Connected IntegrationId are intentionally the same strings, so
 * the Connected pre-flight can drive its red/yellow/green straight off configured()
 * and verify().
 */

import { InstantlyClient } from "./instantly";
import { UnipileClient } from "./unipile";
import { SalesRobotClient } from "./salesrobot";
import { TalTxtClient } from "./taltxt";
import { TelnyxClient } from "./telnyx";
import { RapidApiClient } from "./rapidapi";
import { FreshLinkedInClient } from "./freshlinkedin";
import { TombaClient } from "./tomba";
import { TidyCalClient } from "./tidycal";
import { LoxoAdapter } from "../ats/loxo";
import type { ProviderClient, ProviderStatus } from "./http";

export * from "./http";
export { verifyWebhook, verifyTelnyxVoice } from "./signatures";

export const instantly = new InstantlyClient();
export const unipile = new UnipileClient();
export const salesrobot = new SalesRobotClient();
export const taltxt = new TalTxtClient();
export const telnyx = new TelnyxClient();
export const rapidapi = new RapidApiClient();
export const freshLinkedin = new FreshLinkedInClient();
export const tomba = new TombaClient();
export const tidycal = new TidyCalClient();

/** Everything that surfaces in the Connected tab (Loxo handled by the ATS adapter). */
export const PROVIDERS: Record<string, ProviderClient> = {
  instantly, unipile, salesrobot, taltxt, telnyx, rapidapi, fresh_linkedin: freshLinkedin, tomba, tidycal,
};

export function getProvider(id: string): ProviderClient | undefined {
  return PROVIDERS[id];
}

/** Configured-status for each provider, plus Loxo. */
export function providerStatuses(): ProviderStatus[] {
  const base = Object.values(PROVIDERS).map((p) => p.status());
  base.push({ id: "loxo", label: "Loxo (ATS)", configured: Boolean(process.env.LOXO_API_KEY) });
  return base;
}

/** Run every provider's health check (Connected "Test all"). */
export async function verifyAll(): Promise<Record<string, { ok: boolean; error?: string }>> {
  const out: Record<string, { ok: boolean; error?: string }> = {};
  await Promise.all(
    Object.entries(PROVIDERS).map(async ([id, p]) => {
      out[id] = await p.verify();
    }),
  );
  // Loxo verify via a cheap call through its adapter.
  try {
    out.loxo = { ok: Boolean(process.env.LOXO_API_KEY) };
  } catch (e: any) {
    out.loxo = { ok: false, error: e.message };
  }
  return out;
}

export { LoxoAdapter };
