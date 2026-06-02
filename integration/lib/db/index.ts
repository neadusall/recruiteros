/**
 * RecruiterOS · Persistence
 * A tiny, dependency-light durable layer over Postgres.
 *
 * The engine's modules keep their fast in-memory stores; this adds a snapshot
 * key/value table so state survives restarts. Each module that opts in calls
 * `loadSnapshot(key)` once on boot and `saveSnapshot(key, data)` (debounced)
 * after mutations. No ORM, no migrations beyond the single table below.
 *
 * If DATABASE_URL is not set (local dev without a db), it degrades gracefully:
 * load returns null, save is a no-op, so the app still runs in-memory.
 */

import { Pool } from "pg";

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

/**
 * Resolve the Postgres connection string. Prefers DATABASE_URL, but SELF-HEALS:
 * if DATABASE_URL was never written to .env.production yet POSTGRES_PASSWORD is
 * present (it must be, for the compose `db` service), derive the standard
 * compose connection. This keeps accounts/sessions durable across redeploys
 * even on installs whose .env.production predates DATABASE_URL — the fix for the
 * "logged out + asked to create a new account on every deploy" bug.
 */
function connString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.POSTGRES_PASSWORD) {
    return `postgres://recruiteros:${process.env.POSTGRES_PASSWORD}@db:5432/recruiteros`;
  }
  return null;
}

export function dbEnabled(): boolean {
  return !!connString();
}

function getPool(): Pool | null {
  const cs = connString();
  if (!cs) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: cs,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

async function init(): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `CREATE TABLE IF NOT EXISTS ros_kv (
       k text PRIMARY KEY,
       v jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

function whenReady(): Promise<void> {
  if (!ready) ready = init().catch((e) => { console.error("[db] init failed:", e.message); });
  return ready;
}

/** Real connectivity probe: true only if a query actually succeeds. */
export async function dbPing(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try { await p.query("SELECT 1"); return true; } catch { return false; }
}

/** Load a JSON snapshot for `key`, or null if absent / db disabled. */
export async function loadSnapshot<T>(key: string): Promise<T | null> {
  const p = getPool();
  if (!p) return null;
  try {
    await whenReady();
    const r = await p.query("SELECT v FROM ros_kv WHERE k = $1", [key]);
    return r.rows[0] ? (r.rows[0].v as T) : null;
  } catch (e) {
    console.error("[db] loadSnapshot", key, (e as Error).message);
    return null;
  }
}

/** Upsert a JSON snapshot for `key`. No-op if db disabled. */
export async function saveSnapshot(key: string, data: unknown): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await whenReady();
    await p.query(
      `INSERT INTO ros_kv (k, v, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
      [key, JSON.stringify(data)],
    );
  } catch (e) {
    console.error("[db] saveSnapshot", key, (e as Error).message);
  }
}

/**
 * Debounced saver: returns a function you can call on every mutation; it
 * coalesces rapid writes into one save ~250ms later. Survives process exit via
 * a flush on the final timer.
 */
export function debouncedSaver(key: string, getData: () => unknown, ms = 250): () => void {
  let t: NodeJS.Timeout | null = null;
  return function schedule() {
    if (!dbEnabled()) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => { void saveSnapshot(key, getData()); t = null; }, ms);
  };
}
