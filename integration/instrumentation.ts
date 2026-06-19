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
    // FAILSAFE: assert durable persistence is actually live in this container, loudly,
    // BEFORE any traffic. The "saved data wiped on every deploy" bug is silent — the app
    // happily runs memory-only and the loss only shows up after the next restart. A big
    // boot-log banner makes a broken /data volume / missing config impossible to miss on
    // the very deploy that introduces it, instead of after a user loses work.
    try {
      const { dbEnabled, dbPing } = await import("./lib/db");
      const durable = dbEnabled() && (await dbPing());
      if (!durable) {
        console.error(
          "\n========================================================================\n" +
          "[PERSISTENCE] WARNING: durable storage is NOT active in this container.\n" +
          "Saved data (JD Sourcing runs, accounts, sessions, …) will be LOST on the\n" +
          "next restart/deploy. Expected the /data volume to be mounted+writable, or\n" +
          "DATABASE_URL set. Check the volume mount and NODE_ENV=production.\n" +
          "========================================================================\n",
        );
      } else {
        console.log("[persistence] durable backend live — saved data survives redeploys.");
      }
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
      // Auto-enroll autopilot: populates BD Bulk with verified prospects hands-off. A complete
      // no-op until INMARKET_AUTOENROLL (+ workspace + campaign) is configured, so arming it here
      // never starts populating anything you didn't point it at.
      const { ensureAutoEnroll } = await import("./lib/inmarket/autoEnroll");
      ensureAutoEnroll();
    } catch {
      /* never let an instrumentation hiccup block server startup */
    }
    try {
      const { ensureAtsScheduler } = await import("./lib/ats");
      ensureAtsScheduler();
    } catch {
      /* never let an instrumentation hiccup block server startup */
    }
    // The Automation clock: the in-process replacement for the external n8n
    // conductor. Gated by AUTOMATION_ENABLED (no-op when off), it ticks the
    // cadence / LinkedIn / voice / sending / nurture engines on intervals so
    // campaigns with Autopilot on run end-to-end with nobody in the loop.
    try {
      const { ensureAutomationScheduler } = await import("./lib/automation/scheduler");
      ensureAutomationScheduler();
    } catch {
      /* never let an instrumentation hiccup block server startup */
    }
  }
}
