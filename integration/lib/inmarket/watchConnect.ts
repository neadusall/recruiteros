/**
 * RecruitersOS · In-Market · watch-triggered LinkedIn connect
 *
 * The sequence is two emails; LinkedIn only enters AFTER the prospect proves
 * interest by playing their video. The watch page's play/complete beacon
 * carries &rcpt=<prospectId>, videoStats routes it here, and this files ONE
 * connect request with LinkedIn OS (policy, pacing, health, ledger all apply).
 * The engine's idempotency key makes replays and repeat views a no-op, and a
 * suppressed/DNC person is refused by the engine like any other action.
 *
 * Fire-and-forget by design: never throws, never blocks the tracking beacon.
 * Kill switch: INMARKET_WATCH_CONNECT=0.
 */

export function watchConnectEnabled(): boolean {
  return !["0", "false", "no", "off"].includes((process.env.INMARKET_WATCH_CONNECT || "").toLowerCase());
}

/** Session-lifetime guard so one hot viewer can't queue N engine lookups while
 *  the first request is still in flight (the idempotency key already makes the
 *  duplicates harmless; this just avoids the wasted work). */
const requested = new Set<string>();

/** Note sent with the connect. Plain values, no merge tokens: this renders
 *  outside the email pipeline. Kept under LinkedIn's 300-char note limit. */
function noteFor(firstName: string, role?: string): string {
  const seat = role ? `your ${role} search` : "the role you're hiring for";
  return `Hi ${firstName}, I'm the one from the short video about ${seat}. Wanted to put a real name to the face. Open to connecting?`.slice(0, 280);
}

export async function connectAfterWatch(prospectId: string, roleTitle?: string): Promise<void> {
  if (!watchConnectEnabled() || !prospectId || requested.has(prospectId)) return;
  requested.add(prospectId);
  try {
    const { getCore } = await import("../core/repository");
    const core = getCore();
    const p = await core.getProspect(prospectId);
    if (!p || !p.workspaceId) return;
    // Someone who already replied or opted out gets nothing more; the engine
    // would refuse a DNC anyway, but don't even ask for closed states.
    if (["do_not_contact", "closed_lost", "won", "booked"].includes(p.status || "")) return;

    const campaign = p.campaignId ? await core.getCampaign(p.campaignId) : null;
    const accountId = campaign?.channels?.linkedinAccountId || "default";
    // The watch beacon carries the posting's role title; p.title is the same
    // open-role source renderTouch uses for {{Open_Role}} in this flow.
    const role = roleTitle || p.title;

    const { requestLinkedInAction } = await import("../linkedin/os/engine");
    await requestLinkedInAction({
      workspaceId: p.workspaceId,
      accountId,
      person: {
        prospectId: p.id,
        email: p.email,
        linkedinUrl: p.linkedinUrl,
        fullName: p.fullName,
        company: p.company,
        title: p.title,
      },
      actionType: "connect_note",
      payload: { text: noteFor(p.firstName || "there", role) },
      businessUnit: p.motion === "recruiting" ? "recruiting" : "bd",
      sourceType: "multichannel_workflow",
      campaignId: p.campaignId,
      idempotencyKey: `watchconnect|${p.id}`,
    });
  } catch {
    /* engagement tracking must never fail because LinkedIn had a bad day */
  }
}
