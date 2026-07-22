/**
 * Auth-email fail-safe — regression suite.
 * Run: npx tsx lib/auth/emailFailsafe.test.ts   (exits non-zero on failure)
 *
 * Guards the rule that AUTH-CRITICAL mail (password reset, sign-in link, email
 * verification) is NEVER lost when a white-label tenant's own mailbox is broken:
 * it fails over to the house sender so the user cannot be locked out. Routine
 * (non-critical) white-label mail must still NOT fall back (no silent rebrand).
 *
 * Strategy: register a user whose workspace domain matches a white-label preset
 * (lumesp.com -> Lume), leave its mailbox creds unset (the "broken mailbox"
 * case), and capture console output. With no RESEND_API_KEY locally the house
 * sender logs "(no RESEND_API_KEY, logging only) -> <to>", so a house send to
 * our recipient is directly observable.
 */

import { register, requestPasswordReset, sendWorkspaceEmail, devAuthStore } from "./index";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ FAIL: ") + m); if (!c) fails++; };

/** Run fn while capturing everything written to console.info/error. */
async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const origInfo = console.info, origErr = console.error, origLog = console.log;
  console.info = (...a: any[]) => { lines.push(a.join(" ")); };
  console.error = (...a: any[]) => { lines.push(a.join(" ")); };
  console.log = (...a: any[]) => { lines.push(a.join(" ")); };
  try { await fn(); } finally {
    console.info = origInfo; console.error = origErr; console.log = origLog;
  }
  return lines.join("\n");
}

async function main() {
  // Guard: this test asserts the house-fallback FIRES, which is only observable
  // via the "logging only" line when RESEND is unset. If a real key is present
  // the house send would go out for real; skip rather than send mail.
  if (process.env.RESEND_API_KEY) {
    console.log("  (skipped: RESEND_API_KEY set — would send real mail)");
    return;
  }

  const email = "failsafe-tester@lumesp.com";
  const auth = await register(email, "password123", "Fail Safe Tester");
  // Make the workspace resolve as the Lume white-label preset by host domain,
  // with NO mailbox creds saved -> the branded transport must fail.
  const ws = devAuthStore().workspaces.get(auth.workspace.id)!;
  ws.domain = "lumesp.com";

  // 1) CRITICAL auth mail: password reset must fall over to the house sender.
  const resetLog = await capture(async () => { await requestPasswordReset(email); });
  ok(/no mailbox creds/i.test(resetLog), "reset: branded transport reported the broken/missing tenant mailbox");
  ok(/FAIL-SAFE/.test(resetLog), "reset: fail-safe branch was taken");
  ok(new RegExp(`logging only\\) -> ${email}`).test(resetLog),
     "reset: the reset email reached the HOUSE sender (user not locked out)");

  // 2) NON-critical white-label mail must NOT fall back (no silent rebrand).
  const routineLog = await capture(async () => {
    await sendWorkspaceEmail(email, "Weekly digest", "Your numbers this week", ws.id);
  });
  ok(!new RegExp(`logging only\\) -> ${email}`).test(routineLog),
     "routine: non-critical mail did NOT reach the house sender (white-label rule intact)");
  ok(/no mailbox creds/i.test(routineLog), "routine: broken tenant mailbox was still logged");
}

main().then(() => {
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error("threw:", e); process.exit(1); });
