/**
 * RecruiterOS · Postal MTA integration
 *
 * Three jobs:
 *   1. cloudInit()      — user-data that installs Postal on a fresh Hetzner box.
 *   2. sendMessage()    — Postal's stable HTTP send API (POST /api/v1/send/message).
 *   3. domainSetup()    — the exact commands to register a domain in Postal with
 *                         OUR generated DKIM key, so Postal signs with the key we
 *                         already published to DNS (we own DKIM, not Postal).
 *
 * Postal's send API is per-"mail server": each server has an X-Server-API-Key.
 * That key + host live on the MtaServer record (pasted once after Postal boots).
 */

import type { MtaServer, SendingDomain } from "./types";

export class PostalNotReady extends Error {
  status = 503;
  constructor(detail?: string) { super(detail || "postal_not_ready"); this.name = "PostalNotReady"; }
}

/**
 * Cloud-init (user-data) to stand Postal up on Ubuntu 24.04 automatically:
 * Docker + the official Postal install, bound to the MTA hostname with TLS via
 * Caddy. After boot, the operator runs `postal make-user` / creates an org+server
 * in the Postal UI and pastes the server API key back into RecruiterOS.
 */
export function cloudInit(hostname: string): string {
  return `#cloud-config
package_update: true
packages: [curl, git, ca-certificates]
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - 'echo "${hostname}" > /etc/hostname && hostnamectl set-hostname ${hostname}'
  # Postal quick-start (official helper). Installs MariaDB + RabbitMQ + Postal.
  - git clone https://github.com/postalserver/install /opt/postal/install
  - /opt/postal/install/bin/postal bootstrap ${hostname} || true
  - /opt/postal/install/bin/postal initialize || true
  - /opt/postal/install/bin/postal start || true
  # Caddy fronts Postal's web/API on 443 with auto Let's Encrypt for ${hostname}.
  - 'echo "${hostname} {\\n  reverse_proxy 127.0.0.1:5000\\n}" > /etc/caddy/Caddyfile' || true
write_files:
  - path: /etc/postal-mta.txt
    content: |
      RecruiterOS MTA host ${hostname}.
      Next: create an organization + mail server in the Postal UI, copy the
      server's API credential (X-Server-API-Key), and paste host+key into the
      RecruiterOS Sending tab. Then add each domain with: postal default config.
`;
}

/**
 * Commands to register a sending domain in Postal using OUR DKIM private key, so
 * Postal signs with the selector we already published. Surfaced in the UI as a
 * copy-paste (Postal has no stable public domain-management API; this is the seam).
 */
export function domainSetup(d: SendingDomain): { selector: string; note: string; privateKeyPem?: string } {
  return {
    selector: d.dkimSelector,
    privateKeyPem: d.dkimPrivateKeyPem,
    note: `In Postal: add domain ${d.domain} to your mail server, then set its DKIM `
      + `selector to "${d.dkimSelector}" and import the private key shown so Postal signs `
      + `with the key already published in DNS. (SPF/MX/return-path already point at this host.)`,
  };
}

export interface PostalSendInput {
  from: string;            // "Ryan <ryan@recruitco.io>"
  to: string;
  subject: string;
  htmlBody?: string;
  plainBody?: string;
  replyTo?: string;
  trackOpens?: boolean;
  trackClicks?: boolean;
  headers?: Record<string, string>;
}

interface PostalSendResp {
  status: string;
  data?: { message_id?: string; messages?: Record<string, { id: number; token: string }> };
}

/** Send a message through a Postal mail server. Throws PostalNotReady if unconfigured. */
export async function sendMessage(server: MtaServer, input: PostalSendInput): Promise<{ messageId: string }> {
  if (!server.postalHost || !server.postalApiKey) throw new PostalNotReady("Postal host/API key not set on the MTA server.");
  const res = await fetch(server.postalHost.replace(/\/$/, "") + "/api/v1/send/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Server-API-Key": server.postalApiKey },
    body: JSON.stringify({
      to: [input.to],
      from: input.from,
      subject: input.subject,
      plain_body: input.plainBody,
      html_body: input.htmlBody,
      reply_to: input.replyTo,
      headers: input.headers,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw Object.assign(new Error(`postal_send_${res.status}: ${txt.slice(0, 200)}`), { status: res.status });
  }
  const j = (await res.json()) as PostalSendResp;
  if (j.status !== "success") throw new Error(`postal_send_rejected: ${j.status}`);
  const first = j.data?.messages ? Object.values(j.data.messages)[0] : undefined;
  return { messageId: j.data?.message_id || (first ? String(first.id) : "queued") };
}

/** Lightweight readiness probe (creds present). */
export function postalConfigured(server?: MtaServer): boolean {
  return !!(server?.postalHost && server?.postalApiKey);
}
