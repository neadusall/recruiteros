/**
 * RecruitersOS · Public API
 * Barrel — mount the platform API in a few lines.
 *
 *   import { nextHandler, memoryKeyStore, issueKey } from "@/integration/api";
 *
 *   const store = memoryKeyStore();
 *   const { plaintext, record } = issueKey({ workspaceId, scopes: ["admin"], label: "Server", now });
 *   await store.save(record);            // show `plaintext` to the user ONCE
 *
 *   const deps = { now: () => new Date().toISOString(), newId: (p) => `${p}_...`, config: {...} };
 *   export const GET = nextHandler({ store, deps });
 *   export const POST = GET;             // same handler for every verb (catch-all route)
 */

export * from "./types";
export {
  issueKey,
  authenticate,
  hasScope,
  memoryKeyStore,
  type KeyStore,
  type AuthResult,
  type IssuedKey,
} from "./auth";
export {
  getCatalog,
  postCollect,
  postBuildCampaign,
  postIngest,
  postEnrich,
  getConfig,
  postProvider,
  postWebhook,
  type HandlerDeps,
} from "./handlers";
export {
  handle,
  routeTable,
  nextHandler,
  expressHandler,
  type RouterOptions,
} from "./router";
export { OPENAPI, openApiJson } from "./openapi";
