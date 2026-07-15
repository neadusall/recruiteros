// One-time setup: create the landlinedb database (if missing) and apply schema.sql.
// Connects to the admin DB first, then the module DB.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.LANDLINEDB_URL || 'postgres://landline:landline@localhost:5433/landlinedb';
const admin = new URL(url);
const dbName = admin.pathname.slice(1);
admin.pathname = '/' + (process.env.LANDLINEDB_ADMIN_DB || 'recruiteros');

const a = new pg.Client({ connectionString: admin.href });
await a.connect();
const exists = await a.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
if (!exists.rowCount) {
  await a.query(`CREATE DATABASE ${dbName.replace(/[^a-z0-9_]/g, '')}`);
  console.log('created database', dbName);
}
await a.end();

const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query(readFileSync(join(here, '..', 'schema.sql'), 'utf8'));
console.log('schema applied to', dbName);
await c.end();
