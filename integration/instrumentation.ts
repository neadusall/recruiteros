/**
 * Next.js instrumentation hook — runs ONCE when the server process boots (every deploy or
 * restart), before any request is served. We use it to ARM the In-Market background
 * accumulator so the Hire Signals pool populates day in, day out with zero babysitting.
 *
 * Before this, the accumulator only started on the first search after a deploy — so a fresh
 * deploy with no traffic meant no ingestion. Now it's self-starting and fully unattended:
 * boot → arm → it pulls on its hourly cycle forever. The accumulator's own `started` guard
 * keeps this idempotent with the per-request `ensureAccumulator()` call in the API route.
 */
export async function register(): Promise<void> {
  // Positive runtime guard (NOT an early-return): NEXT_RUNTIME is replaced at build time, so
  // in the edge compile this whole block is `if (false)` and webpack dead-code-eliminates the
  // dynamic import — keeping the node-only accumulator graph (pg, node:crypto, …) out of the
  // edge bundle. The body only ever runs in the long-lived Node.js server.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { ensureAccumulator } = await import("./lib/inmarket/accumulator");
      ensureAccumulator();
    } catch {
      /* never let an instrumentation hiccup block server startup */
    }
  }
}
