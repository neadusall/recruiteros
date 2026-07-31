/**
 * RecruitersOS · mail that reaches the operator
 *
 * The back office has plenty of ways to tell someone LOOKING at the console that something
 * is wrong. This is for the case where nobody is looking, which is the case that matters:
 * an unattended job that finds a problem has to be able to say so out loud.
 *
 * Deliberately a leaf module over the Resend HTTP API rather than the sending stack. The
 * sending stack is warm-up pools, per-mailbox caps and suppression lists, all correct for
 * outreach and all wrong here: an operational alert must not queue behind a warm-up ramp,
 * must not be suppressed because the address unsubscribed from a campaign, and must not
 * consume a sending mailbox's daily quota. It goes to the owner, from the system address,
 * every time.
 *
 * Never throws. A failed alert must not take down the job that raised it; it reports the
 * failure and the caller records it.
 */

import { ownerEmails } from "./emails";

export interface NoticeResult {
  ok: boolean;
  to: string[];
  reason?: string;
}

/** Whether an alert can actually leave the building. Reported on the console. */
export function noticeConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * One operational email to the owner.
 *
 * `body` is plain text, and it is written to be read on a phone: the answer in the first
 * line, the detail under it. HTML is generated from it so links are clickable, and the
 * plain text goes along as well so a text-only client shows the same thing.
 */
export async function notifyOwner(input: { subject: string; body: string; to?: string[] }): Promise<NoticeResult> {
  const to = (input.to?.length ? input.to : ownerEmails()).filter(Boolean);
  if (!to.length) return { ok: false, to: [], reason: "no owner address is configured" };

  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "RecruitersOS <no-reply@recruitersos.co>";
  if (!key) {
    /* Local and CI: say what would have gone, so a test run proves the wording without
       needing a live key. */
    console.info(`[owner-notice] (no RESEND_API_KEY) -> ${to.join(", ")} :: ${input.subject}\n${input.body}`);
    return { ok: false, to, reason: "RESEND_API_KEY is not set" };
  }

  const html = input.body
    .split("\n")
    .map((line) => line.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>'))
    .join("<br>");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: input.subject, html, text: input.body }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, to, reason: `Resend refused it (${res.status}) ${detail}` };
    }
    return { ok: true, to };
  } catch (e) {
    return { ok: false, to, reason: (e as Error).message };
  }
}
