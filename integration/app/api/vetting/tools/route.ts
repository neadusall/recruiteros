/**
 * AI Vetting · Mid-call tools webhook  (PUBLIC — called by the voice engine)
 *   POST /api/vetting/tools?desk=<deskId>&tool=<name>
 *
 * The agent's "hands". When the live Telnyx assistant decides to USE one of the
 * desk's provisioned tools (assistant.ts), Telnyx posts here and speaks our JSON
 * `result` back into the conversation. Everything stays on the Telnyx stack:
 * the only tool with a side effect today sends the caller a Telnyx SMS.
 *
 * Trust model matches the other public vetting webhooks (context/webhook): the
 * desk id is an unguessable record id, the route can only act on desks that
 * explicitly configured the ability, and the caller is resolved from OUR call
 * records (never from attacker-controllable body fields alone). Failures return
 * a speakable result string instead of an error status, so a hiccup never
 * strands the agent mid-sentence.
 */

import { NextResponse } from "next/server";
import { telnyx } from "../../../../lib/providers";
import { withWorkspaceCreds } from "../../../../lib/connected";
import {
  getDeskById, findCallByEngineId, listCalls, getCandidateById,
} from "../../../../lib/vetting";

/** What the engine speaks back to itself as the tool outcome. */
function result(message: string, ok = true) {
  return NextResponse.json({ ok, result: message });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const deskId = url.searchParams.get("desk") || "";
  const tool = url.searchParams.get("tool") || "";

  const desk = deskId ? getDeskById(deskId) : undefined;
  if (!desk) return result("That action isn't available on this call.", false);

  // Resolve WHICH live call this is: the call-control id header Telnyx sends is
  // authoritative; fall back to the desk's most recent still-open call.
  const engineCallId = req.headers.get("x-telnyx-call-control-id") || "";
  const call =
    (engineCallId ? findCallByEngineId(engineCallId) : undefined) ??
    listCalls(desk.workspaceId, desk.id, 10).find((c) => c.status === "ringing" || c.status === "in_progress") ??
    listCalls(desk.workspaceId, desk.id, 1)[0];

  if (tool === "send_scheduling_text") {
    const link = (desk.bookingUrl || "").trim();
    if (!link) return result("There's no scheduling link set up for this role, so let them know the recruiter will reach out to schedule.", false);

    const to = (call?.callerPhone || "").trim();
    if (!to || to === "unknown") {
      return result("You couldn't grab their number from this call, so let them know the recruiter will send the scheduling link shortly instead.", false);
    }

    const candidate = call?.candidateId ? getCandidateById(call.candidateId) : undefined;
    const first = candidate?.firstName || call?.callerName?.split(/\s+/)[0] || "";
    const text =
      `${first ? `Hi ${first}, ` : "Hi, "}it's ${desk.persona.agentName} with ${desk.persona.agentCompany}. ` +
      `Great talking with you. Here's the link to grab time for your next step on the ${desk.roleTitle || "role"}: ${link}`;

    try {
      const res: any = await withWorkspaceCreds(desk.workspaceId, () =>
        // Send from the desk's own number: the same number they just dialed, so
        // the text is instantly recognizable (and stays on the Telnyx stack).
        telnyx.sendSms(to, text, desk.phoneNumber),
      );
      if (res?.dryRun) return result("The scheduling text is on its way to their phone.");
      if (res?.error) throw new Error(String(res.error));
      return result("The scheduling text is on its way to their phone. Confirm out loud that you just sent it.");
    } catch (e: any) {
      console.error("[vetting] send_scheduling_text failed:", e?.message || e);
      return result("The text didn't go through just now, so let them know the recruiter will send the scheduling link right after this call.", false);
    }
  }

  return result("That action isn't available on this call.", false);
}
