/**
 * Portal isolation test: the host a request arrives on decides which company's
 * workspace a session may operate in.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-portal-isolation.mts
 *
 * Runs fully in-memory (no DATABASE_URL): seeds the auth + branding stores
 * directly, then drives lib/api context() with synthetic Requests.
 */

import { devAuthStore } from "../lib/auth/index";
import { context } from "../lib/api";
import { setBranding, setCustomDomain } from "../lib/branding/index";
import { isTenantWorkspace, tenantWorkspaceForHost } from "../lib/branding/portal";
import { ostextTenantFor } from "../lib/ostextImport";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log((cond ? "PASS" : "FAIL") + "  " + label);
  if (!cond) failures++;
}

const now = new Date().toISOString();
const later = new Date(Date.now() + 3600_000).toISOString();
const store = devAuthStore();

function seedUser(id: string, email: string, name: string) {
  store.users.set(id, { id, email, name, passwordHash: null, emailVerified: true, createdAt: now });
  store.usersByEmail.set(email, id);
}
function seedWs(id: string, name: string, domain?: string) {
  store.workspaces.set(id, { id, name, domain, plan: "team", createdAt: now });
  if (domain) store.workspacesByDomain.set(domain, id);
}
function seedSession(token: string, userId: string, workspaceId: string) {
  store.sessions.set(token, { token, userId, workspaceId, createdAt: now, expiresAt: later });
}
function reqFor(host: string, token: string): Request {
  return new Request("http://internal/api/anything", {
    headers: { host, cookie: `ros_session=${encodeURIComponent(token)}` },
  });
}

// The operator: owner of the house workspace AND an owner-role member of the
// Lume workspace (the worst case for the old behavior). A Lume-only recruiter
// rounds out the cast.
seedUser("u-op", "operator@gmail.com", "Operator");
seedUser("u-ariel", "ariel@lumesp.com", "Ariel");
seedWs("ws-house", "RecruitersOS", undefined);
seedWs("ws-lume", "Lume Search Partners", "lumesp.com");
store.memberships.push(
  { userId: "u-op", workspaceId: "ws-house", role: "owner" },
  { userId: "u-op", workspaceId: "ws-lume", role: "owner" },
  { userId: "u-ariel", workspaceId: "ws-lume", role: "member" },
);
seedSession("t-op-lume", "u-op", "ws-lume");   // operator's session STUCK in Lume
seedSession("t-op-house", "u-op", "ws-house");
seedSession("t-ariel", "u-ariel", "ws-lume");

// ---- host -> tenant resolution -------------------------------------------
ok(tenantWorkspaceForHost("app.lumesp.com") === "ws-lume", "app.lumesp.com resolves to the Lume workspace (preset path)");
ok(tenantWorkspaceForHost("recruitersos.co") === null, "recruitersos.co is the house portal");
ok(tenantWorkspaceForHost("app.recruitersos.co:443") === null, "house subdomain (with port) is the house portal");
ok(tenantWorkspaceForHost("localhost:3000") === null, "localhost is the house portal");
ok(isTenantWorkspace("ws-lume"), "Lume workspace is portal-bound");
ok(!isTenantWorkspace("ws-house"), "house workspace is not portal-bound");

// Custom-domain path: verified binds, unverified does not, house host rejected.
seedWs("ws-acme", "Acme Search", "acme-search.com");
await setBranding("ws-acme", { customDomain: "portal.acme-search.com", domainStatus: "verified" });
ok(tenantWorkspaceForHost("portal.acme-search.com") === "ws-acme", "verified custom domain resolves to its workspace");
await setBranding("ws-acme", { domainStatus: "pending" });
ok(tenantWorkspaceForHost("portal.acme-search.com") === null, "unverified custom domain does NOT steer isolation");
let rejected = false;
try { await setCustomDomain("ws-acme", "recruitersos.co"); } catch { rejected = true; }
ok(rejected, "claiming the house domain as a custom domain is rejected");

// ---- the per-request session wall ----------------------------------------
const a = context(reqFor("recruitersos.co", "t-op-lume"));
ok(a?.workspace.id === "ws-house", "operator session stuck in Lume is re-scoped to HOUSE on recruitersos.co");
const b = context(reqFor("app.lumesp.com", "t-op-house"));
ok(b?.workspace.id === "ws-lume", "operator session in house is re-scoped to LUME on app.lumesp.com");
const c = context(reqFor("recruitersos.co", "t-ariel"));
ok(c === null, "Lume-only recruiter gets NOTHING on the house portal");
const d = context(reqFor("app.lumesp.com", "t-ariel"));
ok(d?.workspace.id === "ws-lume", "Lume recruiter works normally on app.lumesp.com");
const e = context(reqFor("recruitersos.co", "t-op-house"));
ok(e?.workspace.id === "ws-house", "house session on the house portal is untouched");
const f = context(reqFor("x-forwarded.example", "t-op-house"));
const fwd = new Request("http://internal/api/anything", {
  headers: { "x-forwarded-host": "app.lumesp.com", host: "app:3000", cookie: "ros_session=t-op-house" },
});
ok(context(fwd)?.workspace.id === "ws-lume", "x-forwarded-host (the proxy reality) drives the wall");
ok(f?.workspace.id === "ws-house", "unknown host behaves as the house portal");

// ---- engine tenant label ---------------------------------------------------
// HOUSE_WORKSPACE_ID is unset here, so isHouseWorkspace() calls EVERY workspace
// house - the portal-bound override must still label Lume as its own tenant.
ok((await ostextTenantFor("ws-lume", "ryan@lumesp.com")) === "lumesp.com", "Lume pushes stamp tenant lumesp.com even with HOUSE_WORKSPACE_ID unset");
ok((await ostextTenantFor("ws-house")) === "house", "house pushes stamp tenant house");
ok((await ostextTenantFor(undefined)) === "house", "background callers with no workspace act as the house");

process.exit(failures ? 1 : 0);
