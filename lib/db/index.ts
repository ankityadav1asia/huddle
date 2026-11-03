// Database access. One Postgres dialect everywhere:
// - DATABASE_URL set (hosted, e.g. Neon): node-postgres pool.
// - Otherwise (local dev, tests): embedded PGlite (Postgres compiled to WASM) persisted under .data/.
// Both expose the same small interface: query(sql, params) -> { rows }, exec(sql), tx(fn), close().
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, type Config } from '../config.ts';
import { migrate } from './migrate.ts';

// What every query site needs: a pooled connection, or the client inside a transaction.
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  exec(sql: string): Promise<unknown>;
}

export interface Db extends Queryable {
  kind: 'pglite' | 'postgres';
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  dbPromise ||= open(config()).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

// Tests inject an in-memory database.
export function setDb(db: Db | null) {
  dbPromise = db ? Promise.resolve(db) : null;
}

async function open(cfg: Config): Promise<Db> {
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

export async function openPglite(dataDir: string | null): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const wrap = (runner: Pick<typeof pg, 'query' | 'exec'>): Queryable => ({
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

export async function openPostgres(url: string): Promise<Db> {
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
// Rows come back untyped unless the caller names the row type (lib/db/rows.ts): each query site knows its columns.
export const one = async <T = any>(q: Queryable, sql: string, params?: unknown[]): Promise<T | null> => (await q.query(sql, params)).rows[0] || null;
export const many = async <T = any>(q: Queryable, sql: string, params?: unknown[]): Promise<T[]> => (await q.query(sql, params)).rows;
