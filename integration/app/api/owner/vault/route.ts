/**
 * /api/owner/vault  (OWNER ONLY)
 *   GET                  -> every account: service, portal URL, username, whether a
 *                           password is on file. Never the password itself.
 *   GET    ?reveal=<id>  -> the password for ONE record. Deliberately a separate call so
 *                           a page load cannot spill the whole vault into a cache or a
 *                           screenshot.
 *   POST                 -> upsert. { id?, service, category, url, username, password?, ... }
 *                           Omit `password` to leave the stored one untouched; send ""
 *                           to clear it.
 *   POST   { action:"reseed" } -> put back any catalogue service that was deleted.
 *   DELETE ?id=<id>      -> remove a record.
 *
 * Owner-walled like every /api/owner/* route: a non-owner gets 404, not 401, so the
 * existence of the vault is not advertised.
 */

import { requireOwner, ok, fail, body } from "../../../../lib/api";
import {
  listVault,
  revealSecret,
  upsertEntry,
  deleteEntry,
  reseedVault,
  vaultSummary,
  vaultKeyStatus,
  type VaultPatch,
} from "../../../../lib/owner/vault";
import { CATALOG_CATEGORIES } from "../../../../lib/owner/vaultCatalog";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const reveal = url.searchParams.get("reveal");
  if (reveal) {
    const r = await revealSecret(reveal);
    if (!r.ok) return fail(r.error || "not_found", r.error === "locked" ? 409 : 404);
    return ok({ id: reveal, password: r.password });
  }

  const [entries, summary] = await Promise.all([listVault(), vaultSummary()]);
  return ok({ entries, summary, categories: CATALOG_CATEGORIES, key: vaultKeyStatus() });
}

export async function POST(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const b = await body<{ action?: string; id?: string } & VaultPatch>(req);
  if (!b) return fail("bad_request", 400);

  if (b.action === "reseed") {
    const added = await reseedVault();
    return ok({ added, entries: await listVault() });
  }

  const { action: _a, id, ...patch } = b;
  const r = await upsertEntry(id, patch);
  if (!r.ok) {
    // A password cannot be written without a key: say which env var to set rather than
    // failing as a generic bad request.
    if (r.error === "no_key") {
      return fail("no_key", 409, { message: "Set OWNER_VAULT_KEY (or RECRUITEROS_SESSION_SECRET) on the server before storing passwords." });
    }
    return fail(r.error || "bad_request", r.error === "not_found" ? 404 : 400);
  }
  return ok({ entry: r.entry, summary: await vaultSummary() });
}

export async function DELETE(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("bad_request", 400);
  const removed = await deleteEntry(id);
  if (!removed) return fail("not_found", 404);
  return ok({ deleted: true, summary: await vaultSummary() });
}
