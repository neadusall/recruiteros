/**
 * RecruitersOS · DKIM
 * Generate a real 2048-bit RSA DKIM keypair in-app. The public key is formatted
 * for the DKIM DNS TXT record; the private key (PEM) is configured into the MTA
 * (Postal) so it signs outbound mail. Nothing is hand-entered.
 */

import { generateKeyPairSync } from "crypto";

export interface DkimKeypair {
  /** base64 SPKI DER — the `p=` value in the DKIM TXT record. */
  publicKey: string;
  /** PKCS#8 PEM — secret, configured into the MTA. */
  privateKeyPem: string;
}

/** Generate a fresh 2048-bit RSA DKIM keypair. */
export function generateDkimKeypair(): DkimKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKey: (publicKey as Buffer).toString("base64"),
    privateKeyPem: privateKey as string,
  };
}

/** The full DKIM TXT record value for a public key. */
export function dkimTxtValue(publicKeyBase64: string): string {
  return `v=DKIM1; k=rsa; t=s; h=sha256; p=${publicKeyBase64}`;
}
