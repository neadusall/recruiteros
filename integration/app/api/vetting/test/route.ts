/**
 * AI Vetting · Test drive
 *   POST /api/vetting/test  -> { deskId, phone, mode: "call" | "text", name? }
 *
 * Lets any operator (house or white-label) run the live agent through its
 * courses on demand: the desk's assistant CALLS the number they type, or opens
 * an SMS conversation with it, exactly as it treats a real candidate: same
 * prompt, same tools, same default (Lukas) or picked voice. Fires as a Telnyx
 * scheduled event a few seconds out, inside the workspace credential context,
 * so every tenant demos on its own engine and numbers.
 *
 * Demo etiquette is baked into the variables: the tester's first name rides
 * the normal {{first_name}} slot so the greeting sounds real, and no resume /
 * scoring state is created (this is a walkthrough, not a candidate).
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { telnyx } from "../../../../lib/providers";
import { getDesk, buildCallContext, type VettingDesk } from "../../../../lib/vetting";
import { toE164 } from "../../../../lib/voice/phone";

/** Opening SMS for a text test: honest, link-free, reply-able. */
function testOpeningText(desk: VettingDesk, firstName: string): string {
  const who = `${desk.persona.agentName} with ${desk.persona.agentCompany}`;
  const role = desk.roleTitle || "the role";
  const name = firstName === "there" ? "" : ` ${firstName}`;
  return `Hey${name}, this is ${who} about ${role}. Do you have a minute to chat by text?`;
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ deskId?: string; phone?: string; mode?: string; name?: string }>(req);
  if (!b?.deskId || !b?.phone) return fail("missing_fields", 422);
  const mode: "call" | "text" = b.mode === "text" ? "text" : "call";

  const desk = getDesk(ws, b.deskId);
  if (!desk) return fail("not_found", 404);
  if (!desk.assistantId) {
    return fail("not_live", 422, { detail: "Take the desk live first, then test it." });
  }
  if (!desk.phoneNumber) {
    return fail("no_phone_number", 422, { detail: "Bind an inbound number to the desk first." });
  }
  const phone = toE164(b.phone);
  if (!phone) {
    return fail("bad_phone", 422, { detail: "Enter the number with area code, e.g. +1 479 555 0134." });
  }

  const firstName = (b.name || "").trim().split(/\s+/)[0] || "there";
  // The same variable set a real scheduled screen carries, minus resume state.
  const vars = buildCallContext(desk, undefined, {
    callOpening: mode === "call" ? "Thanks for making time, calling like we set up." : undefined,
  });
  vars.first_name = firstName;

  // A few seconds out: enough for Telnyx to accept and fire, near-instant to
  // the person holding the phone.
  const scheduledAt = new Date(Date.now() + 15 * 1000).toISOString();

  try {
    return await withWorkspaceCreds(ws, async () => {
      const res: any = await telnyx.createAssistantScheduledEvent(desk.assistantId!, {
        agentNumber: desk.phoneNumber!,
        endUserNumber: phone,
        scheduledAt,
        channel: mode === "text" ? "sms_chat" : "phone_call",
        dynamicVariables: vars,
        text: mode === "text" ? testOpeningText(desk, firstName) : undefined,
      });
      if (res?.error) {
        return fail("test_failed", 502, { detail: String(res.error).slice(0, 180) });
      }
      const dryRun = Boolean(res?.dryRun);
      const eventId = res?.data?.scheduled_event_id ?? res?.scheduled_event_id;
      return ok({ mode, phone, dryRun, eventId, from: desk.phoneNumber });
    });
  } catch (e: any) {
    return fail("test_failed", 502, { detail: String(e?.message || "could not start the test").slice(0, 180) });
  }
}
