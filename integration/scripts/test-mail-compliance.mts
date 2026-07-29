/**
 * Regression suite for the cold-email sustainability layer:
 *   - CAN-SPAM footer (visible unsubscribe + postal address, white-label fail-closed)
 *   - white-label sending-domain guard
 *   - per-inbox warm-up ramp caps
 *   - business-hours send window
 *   - humanizer naturalness + truth gates (pure parts)
 * Run: npx tsx scripts/test-mail-compliance.mts
 */
import assert from "node:assert/strict";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`ok   ${name}`); })
    .catch((e) => { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; });
}

const HOUSE = { name: "RecruitersOS", appUrl: "https://recruitersos.co", whiteLabel: false };
const LUME = { name: "Lume Search Partners", appUrl: "https://app.lumesp.com", whiteLabel: true };

async function main() {
  const { complianceFooter, postalAddressFor, footerAddressMissing } = await import("../lib/sending/compliance");
  const { senderAllowedForBrand } = await import("../lib/senders/brandGuard");
  const { coldCapFor, COLD_PER_INBOX } = await import("../lib/senders/limits");
  const { emailSendWindow } = await import("../lib/sending/sendWindow");
  const { naturalnessViolations, truthPreserved } = await import("../lib/bd/mpc/humanizer");

  /* ---------------- CAN-SPAM footer ---------------- */
  process.env.OUTREACH_POSTAL_ADDRESS = "100 Main St Suite 4, Springdale, AR 72762";
  delete process.env.OUTREACH_POSTAL_ADDRESSES;

  await test("house footer carries brand, postal address and unsubscribe link", () => {
    const f = complianceFooter("ws_house", "prospect@example.com", HOUSE);
    assert.match(f.text, /RecruitersOS, 100 Main St Suite 4, Springdale, AR 72762/);
    assert.match(f.text, /Unsubscribe/);
    assert.match(f.text, /\/api\/unsubscribe\?w=ws_house&e=/);
    assert.match(f.html, /Unsubscribe<\/a>/);
  });

  await test("footer never contains an em-dash or en-dash", () => {
    const f = complianceFooter("ws_house", "prospect@example.com", HOUSE);
    assert.ok(!/[—–]/.test(f.html + f.text));
  });

  await test("white-label footer NEVER inherits the house postal address (fail-closed)", () => {
    assert.equal(postalAddressFor("ws_lume", LUME), null);
    assert.equal(footerAddressMissing("ws_lume", LUME), true);
    const f = complianceFooter("ws_lume", "prospect@example.com", LUME);
    assert.ok(!f.text.includes("Springdale"));
    assert.match(f.text, /Lume Search Partners/);
    assert.match(f.text, /Unsubscribe/);
  });

  await test("white-label footer uses its own configured address (brand token key)", () => {
    process.env.OUTREACH_POSTAL_ADDRESSES = JSON.stringify({ lume: "1 Harbor Way, Boston, MA 02110" });
    const f = complianceFooter("ws_lume", "prospect@example.com", LUME);
    assert.match(f.text, /Lume Search Partners, 1 Harbor Way, Boston, MA 02110/);
    assert.equal(footerAddressMissing("ws_lume", LUME), false);
    delete process.env.OUTREACH_POSTAL_ADDRESSES;
  });

  await test("workspace-id key beats brand token key", () => {
    process.env.OUTREACH_POSTAL_ADDRESSES = JSON.stringify({ lume: "A", ws_lume: "B St, Boston, MA" });
    assert.equal(postalAddressFor("ws_lume", LUME), "B St, Boston, MA");
    delete process.env.OUTREACH_POSTAL_ADDRESSES;
  });

  /* ---------------- white-label sending-domain guard ---------------- */
  await test("house workspace may send from any pool inbox", async () => {
    assert.equal(await senderAllowedForBrand(HOUSE, "anyone@recruitersos.co"), true);
    assert.equal(await senderAllowedForBrand(HOUSE, "anyone@random-domain.io"), true);
  });

  await test("white-label may send from its apex and lookalike domains", async () => {
    assert.equal(await senderAllowedForBrand(LUME, "ryan@lumesp.com"), true);
    assert.equal(await senderAllowedForBrand(LUME, "ryan@mail.lumesp.com"), true);
    assert.equal(await senderAllowedForBrand(LUME, "ryan@lumesearch.io"), true);
  });

  await test("white-label may NEVER send from the house domain", async () => {
    assert.equal(await senderAllowedForBrand(LUME, "ryan@recruitersos.co"), false);
    assert.equal(await senderAllowedForBrand(LUME, "ryan@mail.recruitersos.co"), false);
    assert.equal(await senderAllowedForBrand(LUME, "no-at-sign"), false);
  });

  /* ---------------- per-inbox warm-up ramp ---------------- */
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  await test("warming inbox stays at the day-one floor", () => {
    assert.equal(coldCapFor({ status: "warming", createdAt: days(60) }), COLD_PER_INBOX);
  });

  await test("active inbox ramps 5 / 10 / 15 / 20 by week", () => {
    assert.equal(coldCapFor({ status: "active", createdAt: days(2) }), 5);
    assert.equal(coldCapFor({ status: "active", createdAt: days(8) }), 10);
    assert.equal(coldCapFor({ status: "active", createdAt: days(16) }), 15);
    assert.equal(coldCapFor({ status: "active", createdAt: days(30) }), 20);
  });

  await test("Sending.ac inboxes stay flat at 2/day and NEVER ramp", () => {
    assert.equal(coldCapFor({ status: "active", createdAt: days(60), provider: "sending-ac" }), 2);
    assert.equal(coldCapFor({ status: "warming", createdAt: days(1), provider: "sending-ac" }), 2);
    assert.equal(coldCapFor({ status: "paused", createdAt: days(60), provider: "sending-ac" }), 0);
    assert.equal(coldCapFor({ status: "active", createdAt: days(60), provider: "own-smtp" }), 20);
  });

  await test("paused and error inboxes have zero capacity", () => {
    assert.equal(coldCapFor({ status: "paused", createdAt: days(30) }), 0);
    assert.equal(coldCapFor({ status: "error", createdAt: days(30) }), 0);
  });

  await test("SENDER_COLD_MAX_PER_INBOX lowers the ceiling", () => {
    process.env.SENDER_COLD_MAX_PER_INBOX = "10";
    assert.equal(coldCapFor({ status: "active", createdAt: days(40) }), 10);
    delete process.env.SENDER_COLD_MAX_PER_INBOX;
  });

  /* ---------------- send window ---------------- */
  await test("enforce=0 disables the window", () => {
    process.env.OUTREACH_SEND_WINDOW_ENFORCE = "0";
    assert.equal(emailSendWindow(new Date("2026-07-26T07:00:00Z")).open, true);
    delete process.env.OUTREACH_SEND_WINDOW_ENFORCE;
  });

  await test("weekday mid-morning New York is open", () => {
    process.env.OUTREACH_TIMEZONE = "America/New_York";
    // Tuesday 2026-07-28 14:00Z = 10:00 EDT
    assert.equal(emailSendWindow(new Date("2026-07-28T14:00:00Z")).open, true);
  });

  await test("weekend and small-hours are closed", () => {
    process.env.OUTREACH_TIMEZONE = "America/New_York";
    // Sunday 2026-07-26 15:00Z = 11:00 EDT Sunday
    const sunday = emailSendWindow(new Date("2026-07-26T15:00:00Z"));
    assert.equal(sunday.open, false);
    // Tuesday 06:00Z = 02:00 EDT
    const night = emailSendWindow(new Date("2026-07-28T06:00:00Z"));
    assert.equal(night.open, false);
    delete process.env.OUTREACH_TIMEZONE;
  });

  /* ---------------- fleet import: store semantics ---------------- */
  const store = await import("../lib/senders/store");

  await test("credential-less import stores empty smtpPassEnc and is skipped by rotation", async () => {
    const m = await store.addInbox("ws_test", {
      email: "oauth@lumesearchgroup.com", provider: "sending-ac",
      smtpHost: "smtp.office365.com", smtpPort: 587, smtpPass: "",
      status: "active", createdAt: days(30),
    });
    assert.equal(m.smtpPassEnc, "");
    assert.equal(store.toPublic(m).hasSmtpCreds, false);
    const { pickSender } = await import("../lib/senders/pool");
    assert.equal(await pickSender("ws_test", {}), null);
  });

  await test("credentialed import is sendable and re-import preserves status + createdAt", async () => {
    const d20 = days(20);
    const first = await store.addInbox("ws_test", {
      email: "r1@lumeoutreach.com", provider: "own-smtp",
      smtpHost: "mail.lumesp.com", smtpPort: 587, smtpPass: "secret-pw",
      status: "warming", createdAt: d20,
    });
    assert.ok(first.smtpPassEnc.length > 0);
    assert.equal(first.createdAt, d20);
    first.status = "active";
    await store.saveInbox(first);
    const again = await store.addInbox("ws_test", {
      email: "r1@lumeoutreach.com", provider: "own-smtp",
      smtpHost: "mail.lumesp.com", smtpPort: 587, smtpPass: "secret-pw-rotated",
      status: first.status, createdAt: days(1),
    });
    assert.equal(again.id, first.id);
    assert.equal(again.status, "active");
    assert.equal(again.createdAt, d20); // updates keep the original age
    const { pickSender } = await import("../lib/senders/pool");
    const picked = await pickSender("ws_test", {});
    assert.equal(picked?.email, "r1@lumeoutreach.com");
  });

  /* ---------------- humanizer gates (pure) ---------------- */
  await test("naturalness gate flags template-mill phrases and em-dashes", () => {
    assert.ok(naturalnessViolations("I wanted to reach out about the role").length > 0);
    assert.ok(naturalnessViolations("quick note — saw your team is hiring").includes("em-dash"));
    assert.equal(naturalnessViolations("saw your team is hiring, worth a quick chat?").length, 0);
  });

  await test("truth gate rejects dropped facts and invented numbers", () => {
    const ref = "hi Dana, we placed a controller near Austin who hit 142% of plan. worth a chat? Ryan";
    assert.equal(truthPreserved(ref, "hi Dana, placed a controller by Austin, 142% of plan. chat? Ryan", ["Dana", "Ryan"]), true);
    assert.equal(truthPreserved(ref, "hi Dana, placed a controller, 150% of plan. chat? Ryan", ["Dana", "Ryan"]), false);
    assert.equal(truthPreserved(ref, "hi there, placed a controller. chat? Ryan", ["Dana", "Ryan"]), false);
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ", WITH FAILURES" : ""}`);
}

main();
