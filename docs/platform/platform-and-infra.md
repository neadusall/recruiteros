# Platform Reference — Platform & Infra

The foundation everything else sits on. All paths are under
[`integration/lib/`](../../integration/lib/). See the [platform index](README.md) for the other groups.

---

### accounts
- **Purpose:** Manages LinkedIn sending accounts, sending domains, and API keys for outreach campaigns, with automated health monitoring and warmup-status tracking.
- **Key files:** `index.ts` (LinkedIn accounts, domains, and API keys; types inline).
- **Main exports / entry points:** `addLinkedInAccount()`, `listLinkedInAccounts()`, `addDomain()`, `listDomains()`, `addApiKey()`, `listApiKeys()`, `runHealthSweep()`, `workspaceAccountCounts()`, `purgeWorkspaceAccounts()`.
- **Depends on:** `core/ids` (rid, nowIso), `auth` (workspace scoping).
- **Start here:** `integration/lib/accounts/index.ts` — single file holds the whole module.

### auth
- **Purpose:** Enterprise identity and multi-tenant session management: sign-up, login, magic links, OAuth, role-based access control, and team management.
- **Key files:** `index.ts` (core flows), `crypto.ts` (password hashing), `permissions.ts` (RBAC capability matrix), `types.ts` (User, Workspace, Session, Role), `team.ts` (invites + membership).
- **Main exports / entry points:** `register()`, `login()`, `requestMagicLink()`, `consumeMagicLink()`, `resetPassword()`, `upsertOAuthUser()`, `sessionContext()`, `capabilitiesFor()`, `can()`.
- **Depends on:** `core/ids`, `db` (durability snapshots).
- **Start here:** `integration/lib/auth/index.ts`.

### owner
- **Purpose:** Single-operator back office: workspace administration, account suspension/deletion, hard resets, and the owner-only joined account view (identity + cost + revenue + platform counts).
- **Key files:** `index.ts` (hard reset, account list, full account view), `store.ts` (owner-private metadata: monthly price, tier, notes, reset timestamps).
- **Main exports / entry points:** `ownerEmails()`, `isOwnerEmail()`, `listFullAccounts()`, `fullAccountDetail()`, `updateAccountMeta()`, `hardReset()`, `setAccountSuspended()`, `revokeAccountSessions()`.
- **Depends on:** `auth` (admin account fns), `billing` (cost/revenue), `accounts` (infra counts), `core` (prospects, campaigns).
- **Start here:** `integration/lib/owner/index.ts` — full account view joins billing, accounts, data.

### billing
- **Purpose:** Cost-rate catalog, usage ledger, and pricing engine (owner-only). Tracks every external API call and computes account profitability via gross margin.
- **Key files:** `index.ts` (re-exports all), `rates.ts` (rate catalog), `ledger.ts` (usage events store), `pricing.ts` (cost breakdown + recommendation).
- **Main exports / entry points:** `recordUsage()`, `workspaceCost()`, `workspaceCostByCategory()`, `workspaceEvents()`, `purgeWorkspaceUsage()`, `estimateCost()`, `recommendPrice()`.
- **Depends on:** `core/ids`, `db` (durability snapshots).
- **Start here:** `integration/lib/billing/index.ts`, then `rates.ts` for the cost model.

### providers
- **Purpose:** Single registry of all external service integrations (Instantly, Unipile, Telnyx, etc.), with status checks and health verification.
- **Key files:** `index.ts` (provider singletons + registry), `http.ts` (base client interface), individual providers (`instantly.ts`, `unipile.ts`, `telnyx.ts`, …).
- **Main exports / entry points:** `instantly`, `unipile`, `salesrobot`, `ostext`, `telnyx`, `rapidapi`, `freshLinkedin`, `tomba` (singletons), `getProvider()`, `providerStatuses()`, `verifyAll()`.
- **Depends on:** `ats/loxo` (ATS adapter), external APIs.
- **Start here:** `integration/lib/providers/index.ts` — the registry + what surfaces in Connected.

### connected
- **Purpose:** Campaign pre-flight check: verify each required integration is green before allowing motion activation (Red → Yellow → Green status flow).
- **Key files:** `index.ts` (entire module).
- **Main exports / entry points:** `listIntegrations()`, `configure()`, `testConnection()`, `testAll()`, `preflight()`, `providerHealth()`.
- **Depends on:** `core/types` (Motion), `providers` (health check).
- **Start here:** `integration/lib/connected/index.ts` — small, all logic in one file.

### ats
- **Purpose:** ATS vendor abstraction and object mapping: Loxo verified, others placeholders. Defines how BD prospects, candidates, and placements map to ATS objects.
- **Key files:** `index.ts` (vendor registry, Loxo object map, adapter getter), `loxo.ts` (Loxo API client), `types.ts` (AtsAdapter interface).
- **Main exports / entry points:** `getAts()`, `setAts()`, `LOXO_OBJECT_MAP`, `ATS_VENDORS`, `LoxoAdapter`.
- **Depends on:** `providers` (Loxo instantiation via getProvider).
- **Start here:** `integration/lib/ats/index.ts` — vendor options + object map.

### core
- **Purpose:** Platform persistence boundary — the single repository every module reads/writes through. In-memory reference with snapshot durability, swappable for Prisma in production.
- **Key files:** `repository.ts` (CoreRepository interface + InMemoryCore), `types.ts` (Prospect, Campaign, Activity), `ids.ts` (deterministic id generation).
- **Main exports / entry points:** `getCore()`, `devCore()`, CoreRepository methods (getCampaign, saveCampaign, getProspect, saveProspect, …).
- **Depends on:** `db` (snapshot load/save).
- **Start here:** `integration/lib/core/repository.ts`, then `ids.ts` for id/time helpers.

### overview
- **Purpose:** Real-time dashboard read model: capacity stats (accounts, domains, send limits), appointments, warm responses, active drips — computed from core + accounts + response stores.
- **Key files:** `index.ts` (entire module).
- **Main exports / entry points:** `overview()` — returns OverviewSnapshot (capacity, appointments, responses, drip status).
- **Depends on:** `core` (prospects, campaigns), `accounts` (capacity), `response` (recent conversations).
- **Start here:** `integration/lib/overview/index.ts` — single-function export.

### dev
- **Purpose:** Development seeder: idempotent workspace initialization with demo accounts, campaigns, prospects, integrations, and responses so the app is live on first boot.
- **Key files:** `seed.ts` (entire module).
- **Main exports / entry points:** `seedWorkspace()` — idempotent per workspace; populates campaigns, prospects, accounts, test responses.
- **Depends on:** `core`, `campaigns`, `prospects`, `accounts`, `connected`, `response`.
- **Start here:** `integration/lib/dev/seed.ts`.

### exttoken
- **Purpose:** Stateless, signed extension ingest tokens for the Chrome Sales Navigator scraper (no server storage, HMAC-verified, survives restarts).
- **Key files:** `index.ts` (entire module).
- **Main exports / entry points:** `getOrCreateToken()`, `regenerateToken()`, `workspaceForToken()` (validation), `bearerToken()` (header parsing).
- **Depends on:** `node:crypto` (HMAC-SHA256), `RECRUITEROS_SESSION_SECRET`.
- **Start here:** `integration/lib/exttoken/index.ts` — small, self-contained HMAC token system.
