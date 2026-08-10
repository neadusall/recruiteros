/**
 * Regression suite for the Sending.ac Mailbox API transport:
 *   - transport selection (lume via API, tal via SMTP, nothing when no key)
 *   - Graph sendMail payload mapping (subject, HTML vs text, from, replyTo, x- headers)
 *   - status handling (202 ok, 502 ambiguous-but-not-resent, 403/404 failures)
 *   - reply read mapping
 *   - pool eligibility now includes API-sendable boxes
 *
 * Runs against a local stub of the Mailbox API, so it proves the wiring without a live
 * key and without sending real mail.
 *
 * Run: npx tsx scripts/test-mailbox-api.mts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`ok   ${name}`); })
    .catch((e) => { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; });
}

const KEY = "sk_live_stubmailboxkey";

// The stub records the last sendMail it received and lets a test dictate the next status.
const stub = { lastSend: null as any, nextStatus: 202, ownedFolders: new Set<string>() };

function startStub(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      return send(403, { error: { code: "ErrorAccessDenied", message: "This API key is not a Mailbox API key." } });
    }
    const m = /\/azure\/v1\.0\/users\/([^/]+)\/(sendMail|messages|mailFolders)$/.exec(url.pathname);
    if (!m) return send(404, { error: { code: "ResourceNotFound", message: "No such route." } });
    const email = decodeURIComponent(m[1]);
    const op = m[2];

    if (op === "sendMail") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        stub.lastSend = { email, body: JSON.parse(raw || "{}") };
        if (stub.nextStatus === 202) return send(202, undefined);
        if (stub.nextStatus === 502) return send(502, { error: { code: "BadGateway", message: "upstream" } });
        return send(stub.nextStatus, { error: { code: "ResourceNotFound", message: "No such mailbox." } });
      });
      return;
    }
    if (op === "mailFolders") return send(200, { value: [{ id: "inbox" }] });
    // messages
    return send(200, { value: [
      { id: "m1", subject: "Re: hello", from: { emailAddress: { address: "lead@example.com" } }, receivedDateTime: "2026-08-10T00:00:00Z", bodyPreview: "yes" },
    ] });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    resolve({ base: `http://127.0.0.1:${port}/api/mailbox/v1alpha1`, close: () => new Promise<void>((r) => server.close(() => r())) });
  }));
}

const lumeBox = (over: Record<string, unknown> = {}): any => ({
  id: "sndr_lume", workspaceId: "ws", email: "ryan.nead@lumesearchgroup.com",
  displayName: "Ryan Nead", provider: "sending-ac", smtpHost: "smtp.office365.com",
  smtpPort: 587, smtpSecure: false, smtpUser: "ryan.nead@lumesearchgroup.com",
  smtpPassEnc: "", dailyCap: 2, sentToday: 0, status: "warming", warmExternal: true,
  sent: 0, bounced: 0, createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", ...over,
});

async function main() {
  process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "mbx-test-"));

  const api = await import("../lib/senders/mailboxApi");

  await test("no key => not configured, nothing routes to the API", () => {
    process.env.SENDINGAC_MAILBOX_API_KEY = "";
    assert.equal(api.mailboxApiConfigured(), false);
    assert.equal(api.canSendViaMailboxApi(lumeBox()), false);
  });

  await test("with a key, a credential-less Sending.ac box routes to the API", () => {
    process.env.SENDINGAC_MAILBOX_API_KEY = KEY;
    assert.equal(api.mailboxApiConfigured(), true);
    assert.equal(api.canSendViaMailboxApi(lumeBox()), true);
  });

  await test("a Sending.ac box WITH an SMTP login stays on SMTP (tal fleet)", () => {
    assert.equal(api.canSendViaMailboxApi(lumeBox({ smtpPassEnc: "encrypted" })), false);
  });

  await test("a non-Sending.ac provider never uses the API", () => {
    assert.equal(api.canSendViaMailboxApi(lumeBox({ provider: "own-smtp" })), false);
  });

  const server = await startStub();
  process.env.SENDINGAC_MAILBOX_API_BASE = server.base;

  await test("sendMail maps our message to Graph's payload and reports 202 as ok", async () => {
    stub.nextStatus = 202;
    const r = await api.sendViaMailboxApi(lumeBox(), {
      to: "lead@example.com", subject: "Hi", html: "<b>hi</b>", replyTo: "ryan@lumesp.com",
      headers: { "X-Campaign": "mpc-1", "Message-ID": "<should-be-dropped>" },
    });
    assert.equal(r.ok, true);
    assert.equal(stub.lastSend.email, "ryan.nead@lumesearchgroup.com");
    const gm = stub.lastSend.body.message;
    assert.equal(gm.subject, "Hi");
    assert.equal(gm.body.contentType, "HTML");
    assert.equal(gm.toRecipients[0].emailAddress.address, "lead@example.com");
    assert.equal(gm.from.emailAddress.address, "ryan.nead@lumesearchgroup.com");
    assert.equal(gm.replyTo[0].emailAddress.address, "ryan@lumesp.com");
    // only x- headers survive; a Message-ID cannot be forced on Graph sendMail
    assert.deepEqual(gm.internetMessageHeaders, [{ name: "X-Campaign", value: "mpc-1" }]);
  });

  await test("a text-only message sends as Text", async () => {
    await api.sendViaMailboxApi(lumeBox(), { to: "l@example.com", subject: "S", text: "plain" });
    assert.equal(stub.lastSend.body.message.body.contentType, "Text");
    assert.equal(stub.lastSend.body.message.body.content, "plain");
  });

  await test("a 502 is treated as sent-but-ambiguous, never a clean fail (no resend)", async () => {
    stub.nextStatus = 502;
    const r = await api.sendViaMailboxApi(lumeBox(), { to: "l@example.com", subject: "S", text: "x" });
    assert.equal(r.ok, true, "ok=true so the prospect is not mailed a second time");
    assert.match(r.error || "", /502/);
  });

  await test("a 404 (unknown mailbox) is a real failure", async () => {
    stub.nextStatus = 404;
    const r = await api.sendViaMailboxApi(lumeBox(), { to: "l@example.com", subject: "S", text: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error || "", /ResourceNotFound|No such mailbox/);
  });

  await test("a wrong key is rejected", async () => {
    process.env.SENDINGAC_MAILBOX_API_KEY = "sk_live_wrong";
    const r = await api.sendViaMailboxApi(lumeBox(), { to: "l@example.com", subject: "S", text: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error || "", /not a Mailbox API key|ErrorAccessDenied/);
    process.env.SENDINGAC_MAILBOX_API_KEY = KEY;
  });

  await test("reply read returns mapped messages", async () => {
    const msgs = await api.listMailboxApiMessages("ryan.nead@lumesearchgroup.com");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, "lead@example.com");
    assert.equal(msgs[0].subject, "Re: hello");
  });

  await test("ping proves a live key against an owned mailbox", async () => {
    const p = await api.pingMailboxApi("ryan.nead@lumesearchgroup.com");
    assert.equal(p.ok, true);
    assert.equal(p.status, 200);
  });

  await test("the rotation now picks a lume box the API can send from", async () => {
    // Stand up a real store so pickSender exercises the true eligibility path.
    const store = await import("../lib/senders/store");
    process.env.SENDING_COLD_MIN_AGE_DAYS = "0";
    await store.addInbox("ws_mbx", {
      email: "josh@lumerecruiters.com", provider: "sending-ac",
      smtpHost: "smtp.office365.com", smtpPass: "", status: "warming",
      createdAt: "2026-06-01T00:00:00Z",
    });
    const { pickSender } = await import("../lib/senders/pool");
    const picked = await pickSender("ws_mbx", {});
    assert.ok(picked, "a credential-less lume box is eligible once the Mailbox key is set");
    assert.equal(picked!.smtpPassEnc, "");
  });

  await test("with no key, that same box is NOT eligible", async () => {
    process.env.SENDINGAC_MAILBOX_API_KEY = "";
    const { pickSender } = await import("../lib/senders/pool");
    const picked = await pickSender("ws_mbx", {});
    assert.equal(picked, null, "no SMTP login and no Mailbox key => tracked-only, never picked");
    process.env.SENDINGAC_MAILBOX_API_KEY = KEY;
  });

  await server.close();
  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
