/**
 * RecruitersOS · Outbound Performance · notification brand identity
 *
 * Automated team updates (email/SMS summaries, warnings, reports) must speak
 * as the company the workspace belongs to: the house brand on recruitersos.co,
 * or the white-label brand (e.g. Lume Search Partners on app.lumesp.com) for a
 * branded workspace. This resolves workspace -> {name, appUrl} from the same
 * per-workspace branding record the portal uses (lib/branding), with the
 * built-in host presets as a fallback for flagship tenants, so a white-label
 * user never sees the house name in an automated update.
 *
 * Transport is already tenant-true: notification emails go out through the
 * workspace's own MTA/sender pool, so the From address is the customer's.
 */

export interface NotifyBrand {
  /** Company name used in subjects, SMS prefixes and report copy. */
  name: string;
  /** Base URL links point at (custom domain when verified/live). */
  appUrl: string;
  /** True when this workspace speaks as a white-label brand, not the house. */
  whiteLabel: boolean;
}

function house(): NotifyBrand {
  return {
    name: "RecruitersOS",
    appUrl: process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co",
    whiteLabel: false,
  };
}

export async function notifyBrand(workspaceId: string): Promise<NotifyBrand> {
  try {
    const { getBranding } = await import("../branding");
    const { presetForHost } = await import("../branding/presets");
    const b = await getBranding(workspaceId);
    const domainLive = !!(b.customDomain && (b.domainStatus === "verified" || b.domainStatus === "live"));
    const preset = b.customDomain ? presetForHost(b.customDomain) : null;
    const name = (b.brandName || preset?.brandName || "").trim();
    if (!name && !domainLive) return house();
    return {
      name: name || house().name,
      appUrl: domainLive ? `https://${b.customDomain}` : house().appUrl,
      whiteLabel: true,
    };
  } catch {
    return house();
  }
}
