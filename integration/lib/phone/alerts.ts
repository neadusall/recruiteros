/**
 * RecruitersOS · Phone · saying it out loud
 *
 * The phone's failure mode is silence. From 2026-07-20 to 2026-08-07 every
 * browser call on this box died in about a second because Telnyx refuses SIP
 * URI calls unless the credential connection allows them — and nothing said so.
 * Calls showed "failed", the console showed "softphone ready", and eighteen
 * days went by. The fix for the setting is in infra.ts; this is the part that
 * makes sure a phone can never rot quietly again.
 *
 * Two rules: a break is filed (so it is quotable in the Breaks tab and
 * greppable in the container log the moment it happens), and the owner gets ONE
 * email per problem per workspace per six hours, however many calls fail in
 * between. Never throws — an alert must not take down the call path it is
 * reporting on.
 */

import { recordBreak } from "../breaks";
import { notifyOwner } from "../owner/ownerNotice";
import { workspaceOwner } from "../auth";

/** One email per code per workspace per this long, however loud the failure. */
const REALERT_MS = 6 * 60 * 60 * 1000;
const lastAlert = new Map<string, number>();

/**
 * File a break and, at most every six hours, email the owner.
 *
 * `code` is the quotable identity of the problem, `headline` is the first line
 * of the email (the answer), `detail` is what to do about it.
 */
export async function phoneAlert(
  workspaceId: string,
  code: string,
  headline: string,
  detail: string,
): Promise<void> {
  try {
    const owner = await workspaceOwner(workspaceId).catch(() => null);
    await recordBreak(
      {
        code: "ROS-SETUP",
        where: "BD Phone",
        screen: "background",
        path: code,
        status: 0,
        detail: `${headline} ${detail}`,
        agent: "phone-watchdog",
      },
      { workspaceId, userEmail: owner?.email ?? "" },
    ).catch(() => {});

    const key = `${workspaceId}:${code}`;
    const last = lastAlert.get(key) ?? 0;
    if (Date.now() - last < REALERT_MS) return;
    lastAlert.set(key, Date.now());

    await notifyOwner({
      subject: `RecruitersOS phone: ${headline}`,
      body: [
        headline,
        "",
        detail,
        "",
        `Workspace: ${owner?.name ? `${owner.name} (${workspaceId})` : workspaceId}`,
        `Code: ${code}`,
        "",
        "Breaks tab: https://recruitersos.co/recruiter#breaks",
      ].join("\n"),
    });
  } catch {
    // An alert that fails is not allowed to break a call.
  }
}

/** Test seam: forget the rate-limit state. */
export function resetPhoneAlerts(): void {
  lastAlert.clear();
}
