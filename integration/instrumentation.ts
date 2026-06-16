/**
 * Next.js instrumentation hook — runs ONCE when the server process boots (every deploy or
 * restart), before any request is served. We use it to ARM the background workers that must
 * run with zero babysitting:
 *   - the In-Market accumulator, so the Hire Signals pool populates day in, day out, and
 *   - the ATS sync scheduler, so every connected Loxo workspace stays in sync on an interval
 *     (no external cron pointed at /api/loxo/cron, no human clicking Sync).
 *
 * Before this, the accumulator only started on the first search after a deploy — so a fresh
 * deploy with no traffic meant no ingestion. Now both are self-starting and fully unattended:
 * boot → arm → they tick on their own cycle forever. Each worker's own `started` guard keeps
 * arming idempotent.
 */
export async function register(): Promise<void> {
  // Positive runtime guard (NOT an early-return): NEXT_RUNTIME is replaced at build time, so
  // in the edge compile this whole block is `if (false)` and webpack dead-code-eliminates the
  // dynamic imports — keeping the node-only worker graphs (pg, node:crypto, …) out of the
  // edge bundle. The body only ever runs in the long-lived Node.js server.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // FIRST: mirror every saved portal credential into process.env at boot, before any
    // request or worker runs. Saved keys live on the durable volume; without this eager
    // load they only reach the running process lazily (first Connected-page touch), so a
    // redeploy would leave JD Sourcing's AI key, enrichment, voice and crons "not
    // configured" until someone opened Setup. This keeps every tool online across deploys.
    try {
      const { ensureCredsHydrated } = await import("./lib/connected/credentials");
      await ensureCredsHydrated();
    } catch {
      /* never let an instrumentation hiccup block server startup */
    }
    try {
      const { ensureAccumulator } = await import("./lib/inmarket/accumulator");
      ensureAccumulator();
    } catch {
      /* never let an instrumentation hiccup block server startup */
    }
    try {
      const { ensureAtsScheduler } = await import("./lib/ats");
      ensureAtsScheduler();
    } catch {
      /* never let an instrumentation hiccup block server startup */
    }
  }
}
