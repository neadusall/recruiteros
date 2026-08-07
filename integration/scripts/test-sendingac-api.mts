/**
 * Regression suite for the Sending.ac Partner API path:
 *   - key -> host routing (a test key can never reach live infrastructure)
 *   - pagination, retry-on-429, typed auth errors
 *   - the credential sync: mailboxes land in the right portal WITH SMTP/IMAP logins
 *   - a credential-less re-run never wipes a working login (the failure that made
 *     the whole fleet unsendable in the first place)
 *   - go-live capacity counts only inboxes that can actually send
 *
 * Runs against a local stub of the Partner API, so it proves the wiring without a live
 * key and without touching anyone's real mailboxes.
 *
 * Run: npx tsx scripts/test-sendingac-api.mts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`ok   ${name}`); })
    .catch((e) => { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; });
}

const GOOD_KEY = "sac_live_stubkey0001";

interface StubMailbox {
  id: string; email: string; status: string; display_name?: string | null;
  credentials?: { smtp?: Record<string, unknown>; imap?: Record<string, unknown> };
}

/** Config the stub server reads on each request, so a test can change behaviour. */
const stub = {
  senders: [] as Array<{ id: string; name: string; status: string; mailboxes_count: number }>,
  mailboxes: new Map<string, StubMailbox[]>(),
  /** Number of 429s to emit before serving normally (retry/backoff test). */
  rateLimitOnce: 0,
  requests: 0,
};

function creds(email: string, pass: string) {
  return {
    smtp: { host: "smtp.office365.com", port: 587, username: email, password: pass, encryption: "STARTTLS" },
    imap: { host: "outlook.office365.com", port: 993, username: email, password: pass, encryption: "SSL/TLS" },
  };
}

function startStub(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    stub.requests++;
    const url = new URL(req.url || "/", "http://localhost");
    const auth = req.headers.authorization || "";
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    if (auth !== `Bearer ${GOOD_KEY}`) {
      return send(401, { error: { code: "auth.invalid_key", message: "The API key is not valid." } });
    }
    if (stub.rateLimitOnce > 0) {
      stub.rateLimitOnce--;
      return send(429, { error: { code: "rate.quota_exceeded", message: "Slow down." } }, { "retry-after": "1" });
    }

    // Cursor pagination: the cursor is simply the offset, encoded the way the real API
    // treats it - an opaque string the client must echo back untouched.
    const size = Number(url.searchParams.get("page[size]")) || 25;
    const after = Number(Buffer.from(url.searchParams.get("page[after]") || "", "base64").toString() || "0");
    const page = <T,>(all: T[]) => {
      const slice = all.slice(after, after + size);
      const end = after + size;
      const more = end < all.length;
      return {
        data: slice,
        pagination: { has_more: more, next_cursor: more ? Buffer.from(String(end)).toString("base64") : null },
      };
    };

    if (url.pathname === "/v1/senders") return send(200, page(stub.senders));

    const m = /^\/v1\/senders\/([^/]+)\/mailboxes$/.exec(url.pathname);
    if (m) {
      const all = stub.mailboxes.get(decodeURIComponent(m[1])) || [];
      const withCreds = url.searchParams.get("include") === "credentials";
      return send(200, page(all.map((x) => (withCreds ? x : { ...x, credentials: undefined }))));
    }
    return send(404, { error: { code: "resource.not_found", message: "No such resource." } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  // Isolate persisted state: the sync writes real inbox rows, and a test must never
  // land them in the developer's or the server's live snapshot. Outside production the
  // store is memory-only anyway (lib/db `fileDir`), but pin the directory regardless so
  // running this with NODE_ENV=production set cannot reach /data.
  process.env.ROS_DATA_DIR = mkdtempSync(join(tmpdir(), "sac-test-"));
  process.env.HOUSE_WORKSPACE_ID = "ws_house_test";

  /* ---------------- key -> host routing ---------------- */
  {
    delete process.env.SENDINGAC_API_BASE;
    const api = await import("../lib/senders/sendingAcApi");

    await test("no key reads as unconfigured", () => {
      process.env.SENDINGAC_API_KEY = "";
      assert.equal(api.sendingAcConfigured(), false);
    });

    await test("a test key routes to sandbox, a live key to production", () => {
      process.env.SENDINGAC_API_KEY = "sac_test_abc1234";
      assert.equal(api.sendingAcBase(), "https://sandbox-api.customers.ac/v1");
      assert.equal(api.sendingAcIsSandbox(), true);
      process.env.SENDINGAC_API_KEY = "sac_live_abc1234";
      assert.equal(api.sendingAcBase(), "https://live-api.customers.ac/v1");
      assert.equal(api.sendingAcIsSandbox(), false);
    });

    // The key Sending.ac actually issued was `sk_sandbox_…`, not the `sac_test_…` the
    // published spec describes. Matching one literal prefix sent it to the LIVE host.
    await test("an undocumented sandbox prefix is still recognised as sandbox", () => {
      process.env.SENDINGAC_API_KEY = "sk_sandbox_EoLN4hlKirgtgtVP";
      assert.equal(api.sendingAcIsSandbox(), true);
      assert.equal(api.sendingAcBase(), "https://sandbox-api.customers.ac/v1");
      process.env.SENDINGAC_API_KEY = "sk_live_abc1234";
      assert.equal(api.sendingAcIsSandbox(), false);
      assert.equal(api.sendingAcBase(), "https://live-api.customers.ac/v1");
    });

    await test("a key in no known format is assumed NOT live", () => {
      // Guessing "live" for a key we cannot classify is the only guess that can point
      // a non-production key at production infrastructure.
      process.env.SENDINGAC_API_KEY = "someopaquetoken123456";
      assert.equal(api.sendingAcIsSandbox(), true);
      assert.equal(api.sendingAcBase(), "https://sandbox-api.customers.ac/v1");
    });

    await test("SENDINGAC_API_BASE overrides the host for either key kind", () => {
      // Neither documented host resolves in DNS, so this override is the mechanism
      // that points at whatever Sending.ac actually ships, with no code change.
      process.env.SENDINGAC_API_BASE = "https://api.customers.ac/v1/";
      process.env.SENDINGAC_API_KEY = "sac_live_abc1234";
      assert.equal(api.sendingAcBase(), "https://api.customers.ac/v1");
      process.env.SENDINGAC_API_KEY = "sk_sandbox_abc1234";
      assert.equal(api.sendingAcBase(), "https://api.customers.ac/v1");
      delete process.env.SENDINGAC_API_BASE;
    });

    await test("the key hint never exposes the secret", () => {
      process.env.SENDINGAC_API_KEY = "sac_live_supersecretvalue9999";
      assert.equal(api.sendingAcKeyHint(), "sac_live_…9999");
      assert.ok(!api.sendingAcKeyHint().includes("supersecret"));
      process.env.SENDINGAC_API_KEY = "sk_sandbox_supersecretvalue8888";
      assert.equal(api.sendingAcKeyHint(), "sk_sandbox_…8888");
      assert.ok(!api.sendingAcKeyHint().includes("supersecret"));
    });
  }

  /* ---------------- against the stub ---------------- */
  const server = await startStub();
  process.env.SENDINGAC_API_BASE = server.base;
  process.env.SENDINGAC_API_KEY = GOOD_KEY;

  const api = await import("../lib/senders/sendingAcApi");

  await test("a bad key surfaces the upstream code, not a generic failure", async () => {
    process.env.SENDINGAC_API_KEY = "sac_live_wrongkey";
    const ping = await api.pingSendingAc();
    assert.equal(ping.ok, false);
    assert.equal(ping.errorCode, "auth.invalid_key");
    process.env.SENDINGAC_API_KEY = GOOD_KEY;
  });

  // 250 mailboxes across 2 senders forces 3 pages on the 100-record ceiling, which is
  // the case that silently truncated when pagination was assumed to be one page.
  stub.senders = [
    { id: "snd_house", name: "House Outbound", status: "active", mailboxes_count: 250 },
    { id: "snd_lume", name: "Lume Outbound", status: "active", mailboxes_count: 2 },
  ];
  stub.mailboxes.set("snd_house", Array.from({ length: 250 }, (_, i) => ({
    id: `mbx_h${i}`,
    email: `rep${i}@talsearchgroup.com`,
    status: "active",
    display_name: `Rep ${i}`,
    credentials: creds(`rep${i}@talsearchgroup.com`, `pw-house-${i}`),
  })));
  stub.mailboxes.set("snd_lume", [
    {
      id: "mbx_l1", email: "josh@lumesearchgroup.com", status: "active", display_name: "Josh",
      credentials: creds("josh@lumesearchgroup.com", "pw-lume-1"),
    },
    // Still provisioning upstream: no credentials issued yet, by design.
    { id: "mbx_l2", email: "noah@bestlumesearchgroup.com", status: "provisioning", display_name: "Noah" },
  ]);

  await test("every page of a long mailbox list is walked", async () => {
    const { mailboxes, truncated } = await api.listMailboxes("snd_house", { credentials: true });
    assert.equal(mailboxes.length, 250);
    assert.equal(truncated, false);
    assert.equal(mailboxes[249].credentials?.smtp?.password, "pw-house-249");
  });

  await test("a 429 is retried rather than dropped", async () => {
    stub.rateLimitOnce = 2;
    const senders = await api.listSenders();
    assert.equal(senders.length, 2);
    assert.equal(stub.rateLimitOnce, 0);
  });

  await test("ping reports the fleet size", async () => {
    const ping = await api.pingSendingAc();
    assert.equal(ping.ok, true);
    assert.equal(ping.senders, 2);
    assert.equal(ping.mailboxes, 252);
  });

  /* ---------------- the sync ---------------- */
  const { syncSendingAcFleet } = await import("../lib/senders/sendingAcSync");
  const store = await import("../lib/senders/store");

  await test("the fleet imports with real SMTP logins attached", async () => {
    const rep = await syncSendingAcFleet();
    assert.equal(rep.configured, true);
    assert.equal(rep.senders, 2);
    assert.equal(rep.mailboxes, 252);
    assert.equal(rep.credentialed, 251, "251 active mailboxes carry a password");
    assert.equal(rep.pending, 1, "the provisioning mailbox has none yet");
    assert.deepEqual(rep.errors, []);
    assert.equal(rep.truncated, false);
  });

  await test("an imported mailbox is actually sendable", async () => {
    const inbox = await store.findInboxByEmail("ws_house_test", "rep7@talsearchgroup.com");
    assert.ok(inbox, "mailbox landed in the house portal");
    assert.equal(inbox!.provider, "sending-ac");
    assert.ok(inbox!.smtpPassEnc, "an SMTP password is stored");
    assert.equal(inbox!.smtpHost, "smtp.office365.com");
    assert.equal(inbox!.smtpPort, 587);
    assert.equal(inbox!.smtpSecure, false, "587/STARTTLS is not implicit TLS");
    assert.ok(inbox!.imapPassEnc, "an IMAP password is stored for reply sync");
    assert.equal(inbox!.imapHost, "outlook.office365.com");
  });

  await test("the rotation will now pick it", async () => {
    const { pickSender } = await import("../lib/senders/pool");
    // The pool refuses inboxes younger than the minimum-age gate, so this asserts the
    // credential requirement specifically: age is neutralised, creds are the variable.
    process.env.SENDING_COLD_MIN_AGE_DAYS = "0";
    const picked = await pickSender("ws_house_test", {} as never);
    assert.ok(picked, "a credentialed inbox is eligible to send");
    assert.ok(picked!.smtpPassEnc);
  });

  await test("a mailbox still provisioning imports without credentials, not as an error", async () => {
    const inbox = await store.findInboxByEmail("ws_house_test", "noah@bestlumesearchgroup.com")
      || await store.findInboxByEmail("ws_lume_test", "noah@bestlumesearchgroup.com");
    assert.ok(inbox, "it is tracked");
    assert.equal(inbox!.smtpPassEnc, "", "with no login, so the rotation skips it");
  });

  await test("a credential-less re-run never wipes a working login", async () => {
    // The exact regression that made the fleet unsendable: upstream stops returning
    // credentials (mid-provisioning, partial response) and the sync rebuilds the row
    // from that empty input, erasing a password that was working a minute ago.
    const before = await store.findInboxByEmail("ws_house_test", "rep7@talsearchgroup.com");
    const kept = before!.smtpPassEnc;
    assert.ok(kept);

    for (const list of stub.mailboxes.values()) for (const mb of list) delete mb.credentials;
    const rep = await syncSendingAcFleet();
    assert.equal(rep.credentialed, 0, "upstream returned nothing this run");

    const after = await store.findInboxByEmail("ws_house_test", "rep7@talsearchgroup.com");
    assert.equal(after!.smtpPassEnc, kept, "the stored login survived");
    assert.equal(after!.smtpHost, "smtp.office365.com", "and its host travelled with it");
  });

  await test("an upstream suspension pauses the inbox and says why", async () => {
    stub.mailboxes.set("snd_lume", [{
      id: "mbx_l1", email: "josh@lumesearchgroup.com", status: "suspended",
      credentials: creds("josh@lumesearchgroup.com", "pw-lume-1"),
    }]);
    await syncSendingAcFleet();
    const inbox = await store.findInboxByEmail("ws_house_test", "josh@lumesearchgroup.com")
      || await store.findInboxByEmail("ws_lume_test", "josh@lumesearchgroup.com");
    assert.ok(inbox);
    assert.equal(inbox!.status, "paused");
    assert.match(inbox!.pausedReason || "", /Suspended upstream/);
  });

  await test("an unreachable API reports the error instead of emptying the pool", async () => {
    process.env.SENDINGAC_API_KEY = "sac_live_wrongkey";
    const rep = await syncSendingAcFleet();
    assert.equal(rep.configured, true);
    assert.ok(rep.errors.length > 0, "the failure is surfaced");
    assert.match(rep.errors[0], /auth\.invalid_key/);
    assert.equal(rep.imported, 0);

    const survivor = await store.findInboxByEmail("ws_house_test", "rep7@talsearchgroup.com");
    assert.ok(survivor?.smtpPassEnc, "stored logins are untouched by a failed run");
    process.env.SENDINGAC_API_KEY = GOOD_KEY;
  });

  await test("an unconfigured key is a no-op, not a failure", async () => {
    process.env.SENDINGAC_API_KEY = "";
    const rep = await syncSendingAcFleet();
    assert.equal(rep.configured, false);
    assert.equal(rep.mailboxes, 0);
    assert.deepEqual(rep.errors, []);
    process.env.SENDINGAC_API_KEY = GOOD_KEY;
  });

  await server.close();
  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
