// Database access. One Postgres dialect everywhere:
// - DATABASE_URL set (hosted, e.g. Neon): node-postgres pool.
// - Otherwise (local dev, tests): embedded PGlite (Postgres compiled to WASM) persisted under .data/.
// Both expose the same small interface: query(sql, params) -> { rows }, exec(sql), tx(fn), close().
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { migrate } from './migrate.js';

let dbPromise = null;

export function getDb() {
  dbPromise ||= open(config()).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

// Tests inject an in-memory database.
export function setDb(db) {
  dbPromise = db ? Promise.resolve(db) : null;
}

async function open(cfg) {
  if (cfg.databaseUrl) {
    const db = await openPostgres(cfg.databaseUrl);
    await migrate(db);
    return db;
  }
  if (cfg.hosted) throw Object.assign(new Error('DATABASE_URL is not configured'), { code: 'db_not_configured' });
  const dir = path.join(cfg.dataDir, 'pglite');
  mkdirSync(dir, { recursive: true });
  const db = await openPglite(dir);
  await migrate(db);
  return db;
}

export async function openPglite(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const wrap = (runner) => ({
    query: (sql, params = []) => runner.query(sql, params),
    exec: (sql) => runner.exec(sql),
  });
  return {
    kind: 'pglite',
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
}

export async function openPostgres(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX) || 5, idleTimeoutMillis: 10000 });
  return {
    kind: 'postgres',
    query: (sql, params = []) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params = []) => client.query(sql, params), exec: (sql) => client.query(sql) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// Small helpers used across services.
export const one = async (q, sql, params) => (await q.query(sql, params)).rows[0] || null;
export const many = async (q, sql, params) => (await q.query(sql, params)).rows;
