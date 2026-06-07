/**
 * RecruiterOS · DNS record computation
 * Given a sending domain + its MTA server, produce the EXACT record set required
 * for cold-email deliverability. This is the single source of truth for what
 * "correctly configured" means; the provisioner pushes these into Hetzner DNS
 * and the verifier checks them back.
 *
 * Records produced (the from-scratch checklist):
 *   ✅ A      mail.<domain>            -> server IP        (MTA host)
 *   ✅ MX     <domain>                 -> mail.<domain>    (inbound/return-path)
 *   ✅ SPF    <domain> TXT             v=spf1 a mx ip4:.. ~all
 *   ✅ DKIM   <selector>._domainkey    v=DKIM1; ... p=..
 *   ✅ DMARC  _dmarc.<domain> TXT      v=DMARC1; p=quarantine; rua=..
 *   ☑ CNAME  track.<domain>           -> mail.<domain>    (custom tracking)
 *   ☑ CNAME  psrp.<domain>            -> rp.<mtahost>     (Postal return-path)
 *   ☑ TXT    default._bimi            (optional, needs a VMC — record only)
 *  (PTR / rDNS is NOT a zone record — it's set on the IP via the Cloud API.)
 */

import { dkimTxtValue } from "./dkim";
import type { SendingDomain, MtaServer, DesiredRecord } from "./types";

const TTL = 3600;

/**
 * Compute the desired record set. `dmarcPolicy` starts at "quarantine" (safe
 * default for a sender that authenticates); ramp to "reject" once stable.
 */
export function desiredRecords(
  d: SendingDomain,
  server: MtaServer,
  opts?: { dmarcPolicy?: "none" | "quarantine" | "reject"; includeBimi?: boolean },
): DesiredRecord[] {
  const recs: DesiredRecord[] = [];
  const ip = server.ip;
  const mtaHost = server.hostname;                 // e.g. mail.recruitco.io
  const mailLabel = mtaHost.endsWith("." + d.domain) ? mtaHost.slice(0, -("." + d.domain).length) : "mail";
  const tracking = d.trackingHost || `track.${d.domain}`;
  const trackLabel = tracking.endsWith("." + d.domain) ? tracking.slice(0, -("." + d.domain).length) : "track";
  const rua = d.dmarcRua || `mailto:dmarc@${d.domain}`;
  const policy = opts?.dmarcPolicy || "quarantine";

  // A record for the MTA host (only when this domain hosts the mail host itself;
  // for satellite domains the MX simply points at the primary mail host).
  if (ip && mtaHost.endsWith(d.domain)) {
    recs.push({ type: "A", name: mailLabel, value: ip, ttl: TTL, purpose: "mta_a" });
  }

  // MX -> mail host
  recs.push({ type: "MX", name: "@", value: mtaHost, ttl: TTL, purpose: "mx", priority: 10 });

  // SPF
  const spf = ip
    ? `v=spf1 a mx ip4:${ip} ~all`
    : `v=spf1 a mx a:${mtaHost} ~all`;
  recs.push({ type: "TXT", name: "@", value: spf, ttl: TTL, purpose: "spf" });

  // DKIM
  if (d.dkimPublicKey) {
    recs.push({
      type: "TXT",
      name: `${d.dkimSelector}._domainkey`,
      value: dkimTxtValue(d.dkimPublicKey),
      ttl: TTL,
      purpose: "dkim",
    });
  }

  // DMARC
  recs.push({
    type: "TXT",
    name: "_dmarc",
    value: `v=DMARC1; p=${policy}; rua=${rua}; ruf=${rua}; fo=1; adkim=s; aspf=s; pct=100`,
    ttl: TTL,
    purpose: "dmarc",
  });

  // Custom tracking host (open/click links served from your own domain, not a
  // shared tracker — a real deliverability signal).
  recs.push({ type: "CNAME", name: trackLabel, value: mtaHost, ttl: TTL, purpose: "tracking" });

  // Postal return-path / bounce alignment (psrp.<domain> -> rp.<mtahost>).
  recs.push({ type: "CNAME", name: "psrp", value: `rp.${mtaHost}`, ttl: TTL, purpose: "return_path" });

  // BIMI is optional and needs a Verified Mark Certificate (paid, trademark).
  // We only emit the record stub when explicitly asked.
  if (opts?.includeBimi) {
    recs.push({
      type: "TXT",
      name: "default._bimi",
      value: `v=BIMI1; l=https://${d.domain}/bimi/logo.svg;`,
      ttl: TTL,
      purpose: "bimi",
    });
  }

  return recs;
}

/** Human checklist for the UI — which core records are present after a verify. */
export function checklist(records: DesiredRecord[]): Array<{ purpose: string; label: string; present: boolean; core: boolean }> {
  const labels: Record<string, string> = {
    mta_a: "A (mail host)", mx: "MX", spf: "SPF", dkim: "DKIM", dmarc: "DMARC",
    tracking: "Tracking CNAME", return_path: "Return-path", bimi: "BIMI",
  };
  const core = new Set(["mx", "spf", "dkim", "dmarc"]);
  return records.map((r) => ({
    purpose: r.purpose,
    label: labels[r.purpose] || r.purpose,
    present: !!r.present,
    core: core.has(r.purpose),
  }));
}
