/**
 * RecruiterOS · Persistence
 * A tiny, dependency-light durable layer. Modules keep fast in-memory stores;
 * this snapshots them so state (accounts, sessions, workspaces, …) survives a
 * restart. Each module calls `loadSnapshot(key)` once on boot and
 * `saveSnapshot(key, data)` (debounced) after mutations.
 *
 * Backends, in priority order:
 *   1. Postgres — only when DATABASE_URL is explicitly set (opt-in).
 *   2. File     — when ROS_DATA_DIR is set (a mounted Docker volume in prod).
 *                 This is the zero-config default: no DB, no password, no
 *                 volume-init matching, no manual enable step — it just survives
 *                 every redeploy. THIS is the durable default in production.
 *   3. Memory   — neither set (local/static dev): load null, save no-op.
 *
 * The "logged out + create a new account on every deploy" bug was an in-memory
 * store with no durable backend; the file backend fixes it for good.
 */

import { Pool } from "pg";
import { promises as fs } from "fs";
import * as path from "path";

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

/** Default on-disk store path used in production when ROS_DATA_DIR is unset. */
const DEFAULT_PROD_DATA_DIR = "/var/lib/recruiteros";

/**
 * Durable file directory. Prefer an explicit ROS_DATA_DIR (a mounted volume).
 * If it's unset BUT we're in production, fall back to a fixed on-disk path so the
 * store (accounts, sessions, workspaces) survives redeploys regardless — without
 * this, an unconfigured prod box keeps everything in memory and every deploy wipes
 * all users + sessions (the "logged out / account gone after every deploy" bug).
 * Local/static dev (NODE_ENV !== "production") stays in memory: no stray files.
 */
function fileDir(): string | null {
  if (process.env.ROS_DATA_DIR) return process.env.ROS_DATA_DIR;
  if (process.env.NODE_ENV === "production") return DEFAULT_PROD_DATA_DIR;
  return null;
}

/** Postgres connection string, if a DB backend is in play. */
function pgUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.POSTGRES_PASSWORD) {
    return `postgres://recruiteros:${process.env.POSTGRES_PASSWORD}@db:5432/recruiteros`;
  }
  return null;
}

type Mode = "pg" | "file" | "none";
function mode(): Mode {
  if (process.env.DATABASE_URL) return "pg"; // explicit Postgres wins
  if (fileDir()) return "file";              // zero-config durable default
  if (process.env.POSTGRES_PASSWORD) return "pg"; // legacy compose self-heal
  return "none";
}

export function dbEnabled(): boolean {
  return mode() !== "none";
}

/* ---------------- file backend ---------------- */
function fpath(key: string): string {
  return path.join(fileDir() as string, "snap_" + key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
}
async function fileLoad<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(fpath(key), "utf8")) as T;
  } catch {
    return null; // absent or unreadable -> start empty
  }
}
async function fileSave(key: string, data: unknown): Promise<void> {
  const dir = fileDir() as string;
  await fs.mkdir(dir, { recursive: true });
  const fp = fpath(key);
  const tmp = fp + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, fp); // atomic replace
}

/* ---------------- postgres backend ---------------- */
function getPool(): Pool | null {
  const cs = pgUrl();
  if (!cs) return null;
  if (!pool) {
    pool = new Pool({ connectionString: cs, max: 5, idleTimeoutMillis: 30_000 });
  }
  return pool;
}
async function pgInit(): Promise<void> {
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
  if (!ready) ready = pgInit().catch((e) => { console.error("[db] init failed:", e.message); });
  return ready;
}

/** Real readiness probe: true only if the active backend actually works. */
export async function dbPing(): Promise<boolean> {
  if (mode() === "file") {
    try {
      await fs.mkdir(fileDir() as string, { recursive: true });
      await fs.writeFile(path.join(fileDir() as string, ".probe"), String(Date.now()));
      return true;
    } catch {
      return false;
    }
  }
  const p = getPool();
  if (!p) return false;
  try { await p.query("SELECT 1"); return true; } catch { return false; }
}

/** Load a JSON snapshot for `key`, or null if absent / persistence disabled. */
export async function loadSnapshot<T>(key: string): Promise<T | null> {
  if (mode() === "file") return fileLoad<T>(key);
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

/** Upsert a JSON snapshot for `key`. No-op if persistence disabled. */
export async function saveSnapshot(key: string, data: unknown): Promise<void> {
  if (mode() === "file") {
    try { await fileSave(key, data); } catch (e) { console.error("[db] fileSave", key, (e as Error).message); }
    return;
  }
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
 * Debounced saver: call on every mutation; coalesces rapid writes into one save
 * ~250ms later.
 */
export function debouncedSaver(key: string, getData: () => unknown, ms = 250): () => void {
  let t: NodeJS.Timeout | null = null;
  return function schedule() {
    if (!dbEnabled()) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => { void saveSnapshot(key, getData()); t = null; }, ms);
  };
}
